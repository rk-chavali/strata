import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkspace } from "@strata/storage";
import { taxonomyFor } from "@strata/ddl";
import {
  buildAssertion,
  GCP_SCOPES,
  classificationsInUse,
  listTaxonomies,
  proposeMapping,
  type TaxonomyListing,
} from "./bigquery.js";

/**
 * The Data Catalog client, against a fake API on loopback.
 *
 * **Nothing here reaches Google**, and no credential is involved: the service account key is a
 * throwaway RSA pair generated in-process. That is a hard constraint rather than a preference, * a test suite that authenticated for real would need a secret in CI and would make somebody's
 * quota the price of running the tests.
 *
 * The behaviours worth guarding are the ones where being *nearly* right is dangerous. A policy
 * tag applies real column-level security, so a fuzzy match that resolves `pii_email` to the tag
 * for `pii-email` protects the wrong column while looking like it worked.
 */

let root: string;
let server: Server;
let base: string;
let requests: string[];
let respond: (url: string) => { status: number; body: unknown };

async function write(relative: string, content: string): Promise<void> {
  const absolute = join(root, relative);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

/** A throwaway key pair, so the JWT path is exercised without a real credential anywhere. */
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const TAXONOMY = "projects/acme/locations/us/taxonomies/111";

/** One taxonomy with a nested tree: pii > contact > email, plus a standalone level. */
function catalogResponse(url: string): { status: number; body: unknown } {
  if (url.endsWith("/taxonomies")) {
    return {
      status: 200,
      body: { taxonomies: [{ name: TAXONOMY, displayName: "Acme data classification" }] },
    };
  }
  if (url.endsWith("/policyTags")) {
    return {
      status: 200,
      body: {
        policyTags: [
          // Deliberately child-before-parent: the API guarantees no ordering.
          { name: `${TAXONOMY}/policyTags/3`, displayName: "email", parentPolicyTag: `${TAXONOMY}/policyTags/2` },
          { name: `${TAXONOMY}/policyTags/2`, displayName: "contact", parentPolicyTag: `${TAXONOMY}/policyTags/1` },
          { name: `${TAXONOMY}/policyTags/1`, displayName: "pii" },
          { name: `${TAXONOMY}/policyTags/9`, displayName: "confidential" },
          { name: `${TAXONOMY}/policyTags/7`, displayName: "unused_tag" },
        ],
      },
    };
  }
  return { status: 404, body: {} };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strata-bq-"));
  requests = [];
  respond = catalogResponse;

  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      requests.push(url);

      if (url.includes("token")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }));
        return;
      }

      const reply = respond(url);
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  await write(
    "strata.config.yaml",
    `version: 1
name: governed
roots:
  - "."
`,
  );
  await write(
    "models/model.yaml",
    `id: mdl
kind: model
name: warehouse
tier: physical
`,
  );
  await write(
    "models/dim_customer.yaml",
    `id: tbl_dim
kind: table
name: dim_customer
model: warehouse
columns:
  - id: c1
    name: email_address
    dataType: STRING
    classification:
      sensitivity: confidential
      categories: [pii]
  - id: c2
    name: loyalty_tier
    dataType: STRING
    classification:
      categories: [financial]
`,
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("authentication", () => {
  it("builds a signed JWT with the fields Google requires", () => {
    const assertion = buildAssertion(
      "svc@acme.iam.gserviceaccount.com",
      privateKey,
      "https://x/token",
      GCP_SCOPES.bigquery,
      1_000,
    );
    const [header, claims, signature] = assertion.split(".");

    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });

    const parsed = JSON.parse(Buffer.from(claims!, "base64url").toString()) as {
      iss: string;
      aud: string;
      exp: number;
      iat: number;
    };
    expect(parsed.iss).toBe("svc@acme.iam.gserviceaccount.com");
    expect(parsed.aud).toBe("https://x/token");
    // One hour is the maximum Google accepts; longer is rejected outright.
    expect(parsed.exp - parsed.iat).toBe(3600);
    expect(signature!.length).toBeGreaterThan(0);
  });

  /*
    The scope is a security boundary, so it is asserted rather than assumed.

    Both call sites shared one `cloud-platform` constant, which is every Google API the key
    can reach, asked for by something that reads schemas. For a service account the effective
    permission is the scope intersected with the account's IAM roles, so a least-privileged
    key was never able to act outside BigQuery. The breadth was a missing second lock: if the
    minted bearer token leaks, the scope is the only thing still holding.

    These two tests fail if either scope widens, which is the way this regresses. Nothing
    about a schema read gets more correct by asking for more access.
  */
  it("asks for BigQuery only, not every Google API", () => {
    const claims = buildAssertion(
      "svc@acme.iam.gserviceaccount.com",
      privateKey,
      "https://x/token",
      GCP_SCOPES.bigquery,
      1_000,
    ).split(".")[1];

    const parsed = JSON.parse(Buffer.from(claims!, "base64url").toString()) as { scope: string };

    expect(parsed.scope).toBe("https://www.googleapis.com/auth/bigquery");
    expect(parsed.scope).not.toContain("cloud-platform");
  });

  it("keeps the broader scope to Data Catalog, which publishes no narrower one", () => {
    // Not a licence to reuse it elsewhere: `runQuery` must never be handed this.
    expect(GCP_SCOPES.dataCatalog).toBe("https://www.googleapis.com/auth/cloud-platform");
    expect(GCP_SCOPES.bigquery).not.toBe(GCP_SCOPES.dataCatalog);
  });

  it("accepts a private key with literal escaped newlines", () => {
    /*
      Keys pasted out of a service account JSON file carry `\\n` as two characters. PEM parsing
      needs real newlines, and without the fix this throws deep inside crypto with a message that
      says nothing about where the key came from.
    */
    const escaped = privateKey.replace(/\n/g, "\\n");
    expect(() =>
      buildAssertion("svc@acme", escaped, "https://x/token", GCP_SCOPES.bigquery),
    ).not.toThrow();
  });

  it("exchanges a service account assertion for a token", async () => {
    await listTaxonomies({
      project: "acme",
      location: "us",
      base,
      auth: {
        kind: "serviceAccount",
        clientEmail: "svc@acme",
        privateKey,
        tokenUri: `${base.replace("/v1", "")}/token`,
      },
    });

    expect(requests.some((url) => url.includes("token"))).toBe(true);
  });
});

describe("listTaxonomies", () => {
  const auth = { kind: "token", token: "t" } as const;

  it("builds the full path for a nested tag even when the parent arrives last", async () => {
    /*
      The API returns tags in no guaranteed order, so building paths in one pass yields `email`
      for a tag whose parent has not been seen yet. A path is what an operator matches against,
      so getting it wrong makes the whole mapping wrong.
    */
    const listing = await listTaxonomies({ project: "acme", location: "us", base, auth });

    const email = listing.policyTags.find((tag) => tag.displayName === "email");
    expect(email!.path).toBe("pii/contact/email");
  });

  it("reports a permission failure in terms of the permission needed", async () => {
    respond = () => ({ status: 403, body: {} });

    await expect(
      listTaxonomies({ project: "acme", location: "us", base, auth }),
    ).rejects.toThrow(/datacatalog\.taxonomies\.list/);
  });
});

describe("classificationsInUse", () => {
  it("collects what the model actually classifies, deduplicated", async () => {
    const workspace = await loadWorkspace(root);
    const used = classificationsInUse(workspace.graph);

    expect(used.categories).toEqual(["financial", "pii"]);
    expect(used.sensitivities).toEqual(["confidential"]);
  });
});

describe("proposeMapping", () => {
  const auth = { kind: "token", token: "t" } as const;

  async function listing(): Promise<TaxonomyListing> {
    return listTaxonomies({ project: "acme", location: "us", base, auth });
  }

  it("maps a category and a sensitivity level to their tag resources", async () => {
    const workspace = await loadWorkspace(root);
    const proposal = proposeMapping(workspace.graph, await listing());

    expect(proposal.byCategory.pii).toBe(`${TAXONOMY}/policyTags/1`);
    expect(proposal.bySensitivity.confidential).toBe(`${TAXONOMY}/policyTags/9`);
  });

  it("reports a classification with no tag rather than inventing one", async () => {
    const workspace = await loadWorkspace(root);
    const proposal = proposeMapping(workspace.graph, await listing());

    /*
      `financial` has no tag in the catalog. Mapping it to something plausible would apply
      column-level security nobody asked for; the operator either creates the tag or decides the
      category does not need one, and both are their decision.
    */
    expect(proposal.byCategory.financial).toBeUndefined();
    expect(proposal.unmatched).toContainEqual({ kind: "category", value: "financial" });
  });

  it("offers every tag by its full path, for columns that name one directly", async () => {
    const proposal = proposeMapping((await loadWorkspace(root)).graph, await listing());
    expect(proposal.byName["pii/contact/email"]).toBe(`${TAXONOMY}/policyTags/3`);
  });

  it("lists tags the model never claims", async () => {
    const proposal = proposeMapping((await loadWorkspace(root)).graph, await listing());
    expect(proposal.unused.map((tag) => tag.path)).toContain("unused_tag");
  });

  it("does not fuzzy-match a near miss", async () => {
    /*
      The catalog holds `pii_email`; the model classifies `pii`. Those are different tags.

      A wrong policy tag applies real column-level security to the wrong column, so a near-miss
      that silently resolves is far more dangerous than one reported as unmatched, it looks like
      it worked.
    */
    respond = (url) =>
      url.endsWith("/policyTags")
        ? {
            status: 200,
            body: { policyTags: [{ name: `${TAXONOMY}/policyTags/5`, displayName: "pii_email" }] },
          }
        : catalogResponse(url);

    const proposal = proposeMapping((await loadWorkspace(root)).graph, await listing());

    expect(proposal.byCategory.pii).toBeUndefined();
    expect(proposal.unmatched).toContainEqual({ kind: "category", value: "pii" });
  });
});

describe("taxonomyFor", () => {
  const governance = {
    policyTags: {
      byCategory: { pii: "projects/shared/.../1", finance: "projects/shared/.../2" },
      bySensitivity: { confidential: "projects/shared/.../3" },
      byName: {},
    },
    environments: {
      prod: {
        project: "acme-prod",
        location: "us",
        byCategory: { pii: "projects/acme-prod/.../99" },
        bySensitivity: {},
        byName: {},
      },
    },
  };

  it("returns the shared map when no environment is named", () => {
    expect(taxonomyFor(governance).byCategory?.pii).toBe("projects/shared/.../1");
  });

  it("lets an environment override one entry without dropping the rest", () => {
    /*
      The merge is field by field, not whole-object. An environment that overrides only `pii`
      must keep `finance`, replacing the map would leave those columns unprotected in exactly
      the environment someone bothered to configure specially.
    */
    const prod = taxonomyFor(governance, "prod");

    expect(prod.byCategory?.pii).toBe("projects/acme-prod/.../99");
    expect(prod.byCategory?.finance).toBe("projects/shared/.../2");
    expect(prod.bySensitivity?.confidential).toBe("projects/shared/.../3");
  });

  it("falls back to the shared map for an environment nobody declared", () => {
    // The caller has better context for that error; generating nothing would be the worse failure.
    expect(taxonomyFor(governance, "nope").byCategory?.pii).toBe("projects/shared/.../1");
  });
});
