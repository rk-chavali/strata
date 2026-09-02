import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkspace, type LoadedWorkspace } from "@strata/storage";
import { dispatch, markdownReview, ticketKey } from "./dispatch.js";
import { DeliveryLog } from "./deliveries.js";
import { SecretStore } from "./secrets.js";
import type { ChangeSummary } from "./changes.js";

/**
 * Dispatch, against a real HTTP server on loopback.
 *
 * **Nothing here touches a real Slack or Atlassian endpoint**, and that is a hard constraint
 * rather than a preference: a test suite that posts to a webhook to prove it can post to a
 * webhook writes into somebody's channel every time CI runs. The fake server is not a mock of
 * `fetch` either, mocking fetch would assert that we called the function we wrote, whereas a
 * real socket proves the request is well-formed enough for a server to parse, which is the part
 * that actually breaks.
 *
 * The properties under test are the dispatcher's contract, not the providers' cosmetics:
 * isolation (one failure cannot take down another provider), the readiness gate, event
 * filtering, and the exact bytes on the wire.
 */

let root: string;
let dataDir: string;
let received: { url: string; body: string; headers: Record<string, string | string[] | undefined> }[];
let server: Server;
let origin: string;
/** Set per test to control what the fake endpoint returns. */
let respond: (url: string) => { status: number; body: string };

async function write(relative: string, content: string): Promise<void> {
  const absolute = join(root, relative);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

/** A workspace with one provider configured. Written fresh per test so config edits do not leak. */
async function workspaceWith(integrations: string): Promise<LoadedWorkspace> {
  await write(
    "strata.config.yaml",
    `version: 1
name: test-workspace
roots:
  - "."
${integrations}
`,
  );
  return loadWorkspace(root);
}

function summaryFor(overrides: Partial<ChangeSummary> = {}): ChangeSummary {
  return {
    event: "merged",
    workspace: "test-workspace",
    branch: "DATA-1234-add-email",
    sha: "abcdef1234567890",
    shortSha: "abcdef1",
    subject: "Add customer email (#42)",
    author: "Ravi",
    date: "2026-08-19T10:00:00.000Z",
    pullRequest: 42,
    objects: [
      { id: "t1", name: "dim_customer", kind: "table", model: "retail", change: "modified", path: "a.yaml" },
      { id: "t2", name: "dim_legacy", kind: "table", model: "retail", change: "removed", path: "b.yaml" },
    ],
    downstream: [
      { source: "dim_customer", dependent: "fct_orders.customer_key", severity: "breaks", reason: "reads a dropped column" },
      { source: "dim_customer", dependent: "rpt_sales", severity: "informational", reason: "joins the table" },
    ],
    migration: [{ table: "dim_customer", statements: ["ALTER TABLE `p.d.dim_customer` ADD COLUMN email STRING"], requiresRecreate: false }],
    errors: [],
    counts: { added: 0, removed: 1, modified: 1, breaks: 1 },
    ...overrides,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strata-dispatch-"));
  dataDir = await mkdtemp(join(tmpdir(), "strata-dispatch-data-"));
  received = [];
  respond = () => ({ status: 200, body: "ok" });

  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ url: req.url ?? "", body, headers: req.headers });
      const reply = respond(req.url ?? "");
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(reply.body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true }).catch(() => {});
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe("the webhook provider", () => {
  it("posts a Slack-shaped payload and records the delivery", async () => {
    const workspace = await workspaceWith(`integrations:
  webhook:
    enabled: true
    settings:
      format: slack`);

    const secrets = new SecretStore(dataDir);
    await secrets.set("webhook.url", `${origin}/hook`);
    const log = new DeliveryLog(dataDir);

    const deliveries = await dispatch({ workspace, secrets, log }, summaryFor());

    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe("/hook");
    expect(received[0]!.headers["content-type"]).toBe("application/json");

    // Slack renders a bare `text` field and nothing else; sending the raw summary here would
    // render as an unreadable blob in the channel.
    const payload = JSON.parse(received[0]!.body) as { text: string };
    expect(Object.keys(payload)).toEqual(["text"]);
    expect(payload.text).toContain("test-workspace");
    expect(payload.text).toContain("dim_customer");
    // The consequence, not just the count, this is the line that earns the message its place.
    expect(payload.text).toContain("fct_orders.customer_key");

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.ok).toBe(true);
    expect(deliveries[0]!.provider).toBe("webhook");
    expect(await log.list()).toHaveLength(1);
  });

  it("sends the raw summary when the format is json", async () => {
    const workspace = await workspaceWith(`integrations:
  webhook:
    enabled: true
    settings:
      format: json`);

    const secrets = new SecretStore(dataDir);
    await secrets.set("webhook.url", `${origin}/hook`);

    await dispatch({ workspace, secrets, log: new DeliveryLog(dataDir) }, summaryFor());

    const payload = JSON.parse(received[0]!.body) as ChangeSummary;
    expect(payload.counts.breaks).toBe(1);
    expect(payload.migration[0]!.table).toBe("dim_customer");
  });

  it("never puts the webhook URL in the delivery log", async () => {
    const workspace = await workspaceWith(`integrations:
  webhook:
    enabled: true`);

    const secrets = new SecretStore(dataDir);
    const url = `${origin}/services/T00/B00/aVeryLongSecretToken`;
    await secrets.set("webhook.url", url);
    const log = new DeliveryLog(dataDir);

    await dispatch({ workspace, secrets, log }, summaryFor());

    /*
      The URL *is* the credential for an incoming webhook.

      The delivery log is read in the browser, screenshotted, and pasted into bug reports, so a
      preview that echoed the target would leak the ability to post into the channel.
    */
    const serialised = JSON.stringify(await log.list());
    expect(serialised).not.toContain("aVeryLongSecretToken");
  });

  it("records a non-2xx response as a failure with the status", async () => {
    respond = () => ({ status: 500, body: "channel not found" });

    const workspace = await workspaceWith(`integrations:
  webhook:
    enabled: true`);
    const secrets = new SecretStore(dataDir);
    await secrets.set("webhook.url", `${origin}/hook`);
    const log = new DeliveryLog(dataDir);

    const [delivery] = await dispatch({ workspace, secrets, log }, summaryFor());

    expect(delivery!.ok).toBe(false);
    expect(delivery!.status).toBe(500);
    expect(delivery!.detail).toContain("channel not found");
  });
});

describe("the dispatcher's gates", () => {
  it("does not fire a disabled provider", async () => {
    const workspace = await workspaceWith(`integrations:
  webhook:
    enabled: false`);
    const secrets = new SecretStore(dataDir);
    await secrets.set("webhook.url", `${origin}/hook`);

    const deliveries = await dispatch({ workspace, secrets, log: new DeliveryLog(dataDir) }, summaryFor());

    expect(received).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
  });

  it("does not fire a provider that is not subscribed to the event", async () => {
    // The webhook supports `merged` and `validationFailed`; narrowed here to the latter only.
    const workspace = await workspaceWith(`integrations:
  webhook:
    enabled: true
    events:
      - validationFailed`);
    const secrets = new SecretStore(dataDir);
    await secrets.set("webhook.url", `${origin}/hook`);

    await dispatch({ workspace, secrets, log: new DeliveryLog(dataDir) }, summaryFor({ event: "merged" }));

    expect(received).toHaveLength(0);
  });

  it("skips an enabled but unconfigured provider instead of calling it", async () => {
    const workspace = await workspaceWith(`integrations:
  webhook:
    enabled: true`);
    // No secret set, so the required URL is missing.
    const log = new DeliveryLog(dataDir);

    const [delivery] = await dispatch({ workspace, secrets: new SecretStore(dataDir), log }, summaryFor());

    expect(received).toHaveLength(0);
    /*
      Recorded rather than silently ignored.

      "Enabled but incomplete" is the dangerous state, it looks configured on the page and does
      nothing on merge, so it has to leave a trace the operator can find.
    */
    expect(delivery!.ok).toBe(false);
    expect(delivery!.message).toContain("not fully configured");
  });

  it("isolates a failing provider from a working one", async () => {
    /*
      The property the whole feature rests on.

      Confluence points at a high port with nothing listening, so its fetch rejects with
      ECONNREFUSED. (Deliberately not port 1, which Node rejects as a *blocked* port before it
      ever opens a socket, a different code path that would not exercise the cause unwrapping.)
      The
      webhook must still be delivered, and neither failure may propagate to the caller, the
      caller is a merge, and a broken wiki token is not a reason to fail somebody's merge.
    */
    const workspace = await workspaceWith(`integrations:
  webhook:
    enabled: true
  confluence:
    enabled: true
    settings:
      baseUrl: http://127.0.0.1:45999
      email: a@b.c
      pageId: "123"`);

    const secrets = new SecretStore(dataDir);
    await secrets.set("webhook.url", `${origin}/hook`);
    await secrets.set("confluence.token", "token");
    const log = new DeliveryLog(dataDir);

    const deliveries = await dispatch({ workspace, secrets, log }, summaryFor());

    const byProvider = Object.fromEntries(deliveries.map((entry) => [entry.provider, entry]));
    expect(byProvider.webhook!.ok).toBe(true);
    expect(byProvider.confluence!.ok).toBe(false);
    /*
      The failure has to say what went wrong.

      Node's fetch throws `TypeError: fetch failed` and hides the socket error on `cause`, so
      recording the outer message alone fills the delivery log with "fetch failed", which cannot
      distinguish a wrong host from a closed port from a bad certificate.
    */
    expect(byProvider.confluence!.message).toContain("ECONNREFUSED");
    expect(byProvider.confluence!.message).not.toBe("fetch failed");
    expect(received).toHaveLength(1);
    // Both outcomes are on the record, not just the failure.
    expect(await log.list()).toHaveLength(2);
  });
});

describe("the Confluence provider", () => {
  it("reads the current version before overwriting, and increments it", async () => {
    respond = (url) =>
      url.includes("expand=version")
        ? { status: 200, body: JSON.stringify({ title: "Data dictionary", version: { number: 7 } }) }
        : { status: 200, body: "{}" };

    await write(
      "model.yaml",
      `kind: model
id: m1
name: retail
tier: physical
`,
    );

    const workspace = await workspaceWith(`integrations:
  confluence:
    enabled: true
    settings:
      baseUrl: ${origin}
      email: a@b.c
      pageId: "999"`);

    const secrets = new SecretStore(dataDir);
    await secrets.set("confluence.token", "token");

    const [delivery] = await dispatch({ workspace, secrets, log: new DeliveryLog(dataDir) }, summaryFor());

    expect(received).toHaveLength(2);
    // Confluence has no "just overwrite" call; a stale version number is a 409.
    const put = JSON.parse(received[1]!.body) as { version: { number: number }; title: string };
    expect(put.version.number).toBe(8);
    expect(put.title).toBe("Data dictionary");
    expect(delivery!.ok).toBe(true);
  });

  it("says so plainly when the page does not exist", async () => {
    respond = () => ({ status: 404, body: "{}" });

    await write("model.yaml", `kind: model\nid: m1\nname: retail\ntier: physical\n`);
    const workspace = await workspaceWith(`integrations:
  confluence:
    enabled: true
    settings:
      baseUrl: ${origin}
      email: a@b.c
      pageId: "999"`);

    const secrets = new SecretStore(dataDir);
    await secrets.set("confluence.token", "token");

    const [delivery] = await dispatch({ workspace, secrets, log: new DeliveryLog(dataDir) }, summaryFor());

    expect(delivery!.ok).toBe(false);
    expect(delivery!.message).toContain("No page 999");
  });
});

describe("ticketKey", () => {
  it("finds the key in a branch name", () => {
    expect(ticketKey("DATA", "DATA-1234-add-email", undefined)).toBe("DATA-1234");
  });

  it("falls back to the commit subject", () => {
    expect(ticketKey("DATA", "feature/email", "Add email for DATA-99")).toBe("DATA-99");
  });

  it("does not match a key inside a longer word", () => {
    // `METADATA-12` contains `DATA-12`, and crediting a change to the wrong ticket is worse
    // than crediting it to none.
    expect(ticketKey("DATA", "METADATA-12-cleanup", undefined)).toBeUndefined();
  });

  it("ignores projects that are not configured", () => {
    expect(ticketKey("DATA", "PLATFORM-5-thing", undefined)).toBeUndefined();
  });

  it("returns nothing when no projects are configured", () => {
    // Without a project list, any uppercase-dash-number looks like a ticket. Guessing here
    // would comment on unrelated issues in someone's Jira.
    expect(ticketKey(undefined, "DATA-1234-x", undefined)).toBeUndefined();
  });

  it("normalises case and reads several configured projects", () => {
    expect(ticketKey("data, platform", "platform-7-fix", undefined)).toBe("PLATFORM-7");
  });
});

describe("markdownReview", () => {
  it("leads with consequences and includes the migration", () => {
    const body = markdownReview(summaryFor());

    expect(body).toContain("## Model review");
    expect(body).toContain("**breaks**");
    expect(body).toContain("fct_orders.customer_key");
    expect(body).toContain("ALTER TABLE");
  });

  it("says plainly when no migration is needed rather than omitting the section", () => {
    // An absent section reads as "not checked". The reviewer needs to know it was checked.
    const body = markdownReview(summaryFor({ migration: [] }));
    expect(body).toContain("No schema migration required.");
  });

  it("flags a rebuild differently from an in-place alter", () => {
    const body = markdownReview(
      summaryFor({
        migration: [{ table: "dim_customer", statements: [], requiresRecreate: true }],
      }),
    );
    expect(body).toContain("cannot be altered in place");
  });
});
