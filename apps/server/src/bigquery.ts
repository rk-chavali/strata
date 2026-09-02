import { createSign } from "node:crypto";
import type { ObjectGraph } from "@strata/metamodel";

/**
 * Reading Google Cloud: Data Catalog taxonomies, and the policy tags inside them.
 *
 * **No SDK, deliberately.** `@google-cloud/*` was removed from this repo at the operator's
 * request, and the surface needed here is three GET requests and a token exchange. Pulling in a
 * client library, and its transitive gRPC stack, to avoid writing sixty lines of `fetch` would
 * be a poor trade for a self-hosted container that people audit before running.
 *
 * **The problem this exists to solve.** A policy tag is a resource path,
 * `projects/P/locations/L/taxonomies/T/policyTags/G`, and nothing about the word "pii" implies
 * that string. Today an operator opens the console, finds each tag by hand, and pastes the path
 * into `strata.config.yaml`, once per category, per sensitivity level, and again per environment,
 * because dev and prod have different taxonomy ids for the same logical classification. It is
 * clerical, easy to get subtly wrong, and a wrong tag fails at apply time rather than here.
 *
 * So: read the taxonomies, match them to the classifications the model actually uses, and write
 * the mapping back into the config as a reviewable diff.
 */

/** How credentials reach Google. */
export type GcpAuth =
  /** A short-lived token, e.g. from `gcloud auth print-access-token`. Simplest to test with. */
  | { kind: "token"; token: string }
  /** A service account key. Signed locally into a JWT and exchanged for a token. */
  | { kind: "serviceAccount"; clientEmail: string; privateKey: string; tokenUri?: string };

export interface PolicyTagNode {
  /** Full resource name, the string that goes into generated DDL. */
  name: string;
  displayName: string;
  description?: string;
  parentPolicyTag?: string;
  /** `pii/contact/email`, built by walking parents. The name a human recognises. */
  path: string;
  taxonomy: string;
  taxonomyDisplayName: string;
}

export interface TaxonomyListing {
  project: string;
  location: string;
  taxonomies: { name: string; displayName: string; description?: string }[];
  policyTags: PolicyTagNode[];
}

/** Injected so tests drive a loopback server rather than reaching Google. */
export type Fetcher = typeof fetch;

const CATALOG_BASE = "https://datacatalog.googleapis.com/v1";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/**
 * Turn a service account key into an access token.
 *
 * The JWT-bearer flow, done by hand: build a claim set, sign it RS256 with the key's private
 * half, and exchange it at the token endpoint. `node:crypto` signs it, so there is no dependency
 * and no key ever leaves this process except as a signature.
 *
 * Exported for the tests, which check the assertion is well-formed without a real key round-trip.
 */
export function buildAssertion(
  clientEmail: string,
  privateKey: string,
  audience: string,
  now = Math.floor(Date.now() / 1000),
): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");

  const header = encode({ alg: "RS256", typ: "JWT" });
  const claims = encode({
    iss: clientEmail,
    scope: SCOPE,
    aud: audience,
    // One hour is the maximum Google accepts; anything longer is rejected outright.
    exp: now + 3600,
    iat: now,
  });

  const signature = createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(
      // Keys pasted out of a JSON file carry literal `\n`; PEM parsing needs real newlines.
      privateKey.replace(/\\n/g, "\n"),
      "base64url",
    );

  return `${header}.${claims}.${signature}`;
}

/** Resolve whatever the operator configured into a bearer token. */
export async function accessToken(auth: GcpAuth, fetcher: Fetcher = fetch): Promise<string> {
  if (auth.kind === "token") return auth.token;

  const uri = auth.tokenUri ?? TOKEN_URI;
  const response = await fetcher(uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: buildAssertion(auth.clientEmail, auth.privateKey, uri),
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Google rejected the service account credentials (${response.status}). ${text.slice(0, 200)}`,
    );
  }

  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("the token response contained no access_token");
  return body.access_token;
}

/**
 * Every taxonomy and policy tag visible in one project and location.
 *
 * Policy tags are **regional**: a taxonomy in `us` is invisible from `eu`, so the location is
 * part of the address rather than a filter. Callers list per region.
 */
export async function listTaxonomies(
  options: {
    project: string;
    location: string;
    auth: GcpAuth;
    /** Override the API host. Only the tests use this. */
    base?: string;
  },
  fetcher: Fetcher = fetch,
): Promise<TaxonomyListing> {
  const base = options.base ?? CATALOG_BASE;
  const token = await accessToken(options.auth, fetcher);

  const get = async (url: string): Promise<Record<string, unknown>> => {
    const response = await fetcher(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        response.status === 403
          ? `Access denied reading taxonomies in ${options.project}. The principal needs ` +
            `\`datacatalog.taxonomies.list\` and \`datacatalog.taxonomies.get\`.`
          : `Data Catalog returned ${response.status} ${response.statusText}. ${text.slice(0, 200)}`,
      );
    }
    return (await response.json()) as Record<string, unknown>;
  };

  const parent = `projects/${options.project}/locations/${options.location}`;
  const listed = await get(`${base}/${parent}/taxonomies`);

  const taxonomies = (
    (listed.taxonomies as { name: string; displayName: string; description?: string }[]) ?? []
  ).map((entry) => ({
    name: entry.name,
    displayName: entry.displayName,
    ...(entry.description ? { description: entry.description } : {}),
  }));

  const policyTags: PolicyTagNode[] = [];

  for (const taxonomy of taxonomies) {
    const page = await get(`${base}/${taxonomy.name}/policyTags`);
    const raw =
      (page.policyTags as {
        name: string;
        displayName: string;
        description?: string;
        parentPolicyTag?: string;
      }[]) ?? [];

    /*
      Paths are built after the whole taxonomy is read, not during.

      The API returns tags in no guaranteed order, so a parent can arrive after its child. Building
      the path in one pass would produce `contact` for a tag whose parent had not been seen yet, and a path is what an operator matches against, so getting it wrong makes the mapping wrong.
    */
    const byName = new Map(raw.map((tag) => [tag.name, tag]));

    const pathOf = (tag: { displayName: string; parentPolicyTag?: string }): string => {
      const parts = [tag.displayName];
      let current = tag.parentPolicyTag;
      // Bounded, because a malformed cycle in the API response must not hang the sync.
      for (let depth = 0; current && depth < 10; depth += 1) {
        const found = byName.get(current);
        if (!found) break;
        parts.unshift(found.displayName);
        current = found.parentPolicyTag;
      }
      return parts.join("/");
    };

    for (const tag of raw) {
      policyTags.push({
        name: tag.name,
        displayName: tag.displayName,
        ...(tag.description ? { description: tag.description } : {}),
        ...(tag.parentPolicyTag ? { parentPolicyTag: tag.parentPolicyTag } : {}),
        path: pathOf(tag),
        taxonomy: taxonomy.name,
        taxonomyDisplayName: taxonomy.displayName,
      });
    }
  }

  return { project: options.project, location: options.location, taxonomies, policyTags };
}

// ---------------------------------------------------------------- matching

export interface MappingProposal {
  byCategory: Record<string, string>;
  bySensitivity: Record<string, string>;
  byName: Record<string, string>;
  /** Classifications the model uses that no policy tag matched. The actionable half. */
  unmatched: { kind: "category" | "sensitivity"; value: string }[];
  /** Tags that exist in Data Catalog but nothing in the model claims. Reported, never guessed at. */
  unused: { path: string; name: string }[];
}

/** Every category and sensitivity level the model actually uses. */
export function classificationsInUse(graph: ObjectGraph): {
  categories: string[];
  sensitivities: string[];
} {
  const categories = new Set<string>();
  const sensitivities = new Set<string>();

  const absorb = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const classification = value as { sensitivity?: string; categories?: string[] };
    if (classification.sensitivity) sensitivities.add(classification.sensitivity);
    for (const category of classification.categories ?? []) categories.add(category);
  };

  for (const entry of graph.all()) {
    const object = entry.object as Record<string, unknown>;
    absorb(object.classification);

    // Columns and attributes carry their own, and a domain lends its own to whatever uses it.
    for (const key of ["columns", "attributes"]) {
      const members = object[key];
      if (!Array.isArray(members)) continue;
      for (const member of members) {
        if (typeof member === "object" && member !== null) {
          absorb((member as Record<string, unknown>).classification);
        }
      }
    }
  }

  return { categories: [...categories].sort(), sensitivities: [...sensitivities].sort() };
}

/**
 * Match what the model classifies against what Data Catalog holds.
 *
 * Matching is on the **leaf display name**, case-insensitively, and nothing else. Two rules that
 * sound like improvements are deliberately absent:
 *
 * *No fuzzy matching.* `pii_email` and `pii-email` are not treated as the same tag. A wrong policy
 * tag applies real column-level security to the wrong column, and a near-miss that silently
 * resolves is far more dangerous than one reported as unmatched.
 *
 * *No inventing tags.* A category with no matching tag is reported in `unmatched` rather than
 * mapped to something plausible. The operator either creates the tag or decides the category does
 * not need one, both are decisions, and neither is ours.
 */
export function proposeMapping(
  graph: ObjectGraph,
  listing: TaxonomyListing,
): MappingProposal {
  const { categories, sensitivities } = classificationsInUse(graph);

  const byLeaf = new Map<string, PolicyTagNode>();
  for (const tag of listing.policyTags) {
    const key = tag.displayName.toLowerCase();
    /*
      First wins, and a collision is left alone.

      Two taxonomies can both define a tag called `email`. Overwriting would make the result
      depend on listing order, which is not stable, so the first is kept and the duplicate simply
      does not shadow it. The operator sees both in `unused` and can map by path instead.
    */
    if (!byLeaf.has(key)) byLeaf.set(key, tag);
  }

  const byCategory: Record<string, string> = {};
  const bySensitivity: Record<string, string> = {};
  const unmatched: MappingProposal["unmatched"] = [];
  const claimed = new Set<string>();

  for (const category of categories) {
    const tag = byLeaf.get(category.toLowerCase());
    if (tag) {
      byCategory[category] = tag.name;
      claimed.add(tag.name);
    } else {
      unmatched.push({ kind: "category", value: category });
    }
  }

  for (const level of sensitivities) {
    const tag = byLeaf.get(level.toLowerCase());
    if (tag) {
      bySensitivity[level] = tag.name;
      claimed.add(tag.name);
    } else {
      unmatched.push({ kind: "sensitivity", value: level });
    }
  }

  /*
    Every tag is offered by its full path as well.

    A column can name `policyTagName: pii/contact/email` directly, and that is the escape hatch
    for anything the category and sensitivity vocabularies cannot express. Mapping all of them
    costs nothing and means the escape hatch resolves without a second sync.
  */
  const byName: Record<string, string> = {};
  for (const tag of listing.policyTags) byName[tag.path] = tag.name;

  return {
    byCategory,
    bySensitivity,
    byName,
    unmatched,
    unused: listing.policyTags
      .filter((tag) => !claimed.has(tag.name))
      .map((tag) => ({ path: tag.path, name: tag.name })),
  };
}

// ---------------------------------------------------------------- reading a warehouse back

const BIGQUERY_BASE = "https://bigquery.googleapis.com/bigquery/v2";

/**
 * How many rows one introspection may return.
 *
 * A bound rather than a page limit, because the failure it prevents is memory rather than time:
 * this walks every page and accumulates, so a dataset far larger than anyone expects would
 * otherwise be an unbounded allocation driven by somebody else's warehouse. Fifty thousand
 * columns is comfortably past any dataset a person is about to model by hand, and the caller is
 * told when it truncates rather than being handed a quietly partial model.
 */
const MAX_ROWS = 50_000;

export interface QueryResult {
  rows: Record<string, string | null>[];
  /** True when `MAX_ROWS` cut the result short. */
  truncated: boolean;
}

/**
 * Run one read-only query and collect every page.
 *
 * **Why the REST API by hand, again.** The same reasoning `accessToken` records: this is one POST
 * and a paging loop, and `@google-cloud/bigquery` would bring a gRPC stack into a container people
 * audit before running. Nothing here is clever enough to be worth a dependency.
 *
 * **`location` is not optional in practice.** `INFORMATION_SCHEMA` is regional, so a dataset in
 * `EU` is invisible to a job that ran in `US`, and the error Google returns for that is a bare
 * "not found" that reads as a permissions problem or a typo. Passing it through means the caller
 * can say which region it looked in.
 *
 * **A job that is not finished is polled, not assumed.** `jobs.query` returns `jobComplete: false`
 * when the query outruns its timeout, with no rows attached. Treating that response as an empty
 * result would report a populated dataset as empty, which is the worst possible answer here
 * because it looks exactly like success.
 */
export async function runQuery(
  options: { project: string; sql: string; auth: GcpAuth; location?: string; base?: string },
  fetcher: Fetcher = fetch,
): Promise<QueryResult> {
  const base = options.base ?? BIGQUERY_BASE;
  const token = await accessToken(options.auth, fetcher);
  const endpoint = `${base}/projects/${encodeURIComponent(options.project)}/queries`;

  const call = async (url: string, body?: unknown): Promise<Record<string, unknown>> => {
    const response = await fetcher(url, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      /*
        403 and 404 are the two an operator will actually hit, and the generic message sends them
        to the wrong place: a missing dataset and a missing permission both read as "it did not
        work". Naming the role and naming the region is the difference between a fix and a guess.
      */
      if (response.status === 403) {
        throw new Error(
          `Access denied running the query in ${options.project}. The principal needs ` +
            "`bigquery.jobs.create` on the project and `bigquery.tables.get` on the dataset.",
        );
      }
      if (response.status === 404) {
        throw new Error(
          `Not found in ${options.project}` +
            (options.location ? ` (location ${options.location})` : "") +
            ". INFORMATION_SCHEMA is regional, so check the dataset name and its region.",
        );
      }
      throw new Error(`BigQuery returned ${response.status} ${response.statusText}. ${text.slice(0, 200)}`);
    }

    return (await response.json()) as Record<string, unknown>;
  };

  let payload = await call(endpoint, {
    query: options.sql,
    useLegacySql: false,
    // Read-only by construction: a dry run would not return rows, and this is the next
    // strongest statement available. INFORMATION_SCHEMA cannot be written to in any case.
    ...(options.location ? { location: options.location } : {}),
    timeoutMs: 30_000,
    maxResults: 2000,
  });

  const jobRef = payload.jobReference as { jobId?: string; location?: string } | undefined;
  const jobId = jobRef?.jobId;
  const jobLocation = jobRef?.location ?? options.location;

  /* Not finished inside the timeout. Poll the results endpoint rather than reporting nothing. */
  for (let attempt = 0; payload.jobComplete === false && attempt < 30; attempt += 1) {
    if (!jobId) throw new Error("BigQuery did not finish the query and returned no job to poll");
    const query = new URLSearchParams({ timeoutMs: "10000" });
    if (jobLocation) query.set("location", jobLocation);
    payload = await call(`${endpoint}/${encodeURIComponent(jobId)}?${query.toString()}`);
  }

  if (payload.jobComplete === false) throw new Error("the query did not finish in time");

  const fields = ((payload.schema as { fields?: { name: string }[] } | undefined)?.fields ?? []).map(
    (field) => field.name,
  );

  const rows: Record<string, string | null>[] = [];
  let truncated = false;

  const collect = (page: Record<string, unknown>): void => {
    for (const row of (page.rows as { f?: { v?: unknown }[] }[] | undefined) ?? []) {
      if (rows.length >= MAX_ROWS) {
        truncated = true;
        return;
      }
      const record: Record<string, string | null> = {};
      fields.forEach((name, index) => {
        const value = row.f?.[index]?.v;
        // Google sends every scalar as a string or null; anything else here is a nested value
        // this projection does not ask for, and stringifying it would invent data.
        record[name] = value === null || value === undefined ? null : String(value);
      });
      rows.push(record);
    }
  };

  collect(payload);

  let pageToken = payload.pageToken as string | undefined;
  while (pageToken && !truncated) {
    if (!jobId) break;
    const query = new URLSearchParams({ pageToken, timeoutMs: "30000" });
    if (jobLocation) query.set("location", jobLocation);
    const page = await call(`${endpoint}/${encodeURIComponent(jobId)}?${query.toString()}`);
    collect(page);
    pageToken = page.pageToken as string | undefined;
  }

  return { rows, truncated };
}
