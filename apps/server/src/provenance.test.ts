import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { initRepo } from "./git.js";
import { objectProvenance } from "./provenance.js";

const exec = promisify(execFile);

/**
 * Provenance, against a real repository and a real HTTP server.
 *
 * Same reasoning as `git.test.ts`: this module's job is to read what git and Jira actually
 * return, so mocking either would assert that the parser matches the test author's guess about
 * the format, which is the implementation's assumption checked twice.
 *
 * The behaviour that matters most here is **degradation**. Every branch below where something is
 * missing or broken still has to produce the half that works, because this renders in a panel
 * beside the model and a reader who loses the commit because Jira timed out has lost the useful
 * part to protect the decorative one.
 */

// Real `git` several times per test, on a machine that may be slow. See git.test.ts.
const GIT_TIMEOUT = 60_000;

let repo: string;
let server: Server;
let origin: string;
let requests: string[];
let respond: () => { status: number; body: string };

async function git(...args: string[]): Promise<void> {
  await exec("git", args, { cwd: repo });
}

async function commit(subject: string, content: string): Promise<void> {
  await writeFile(join(repo, "dim_customer.yaml"), content, "utf8");
  await git("add", "-A");
  await git("commit", "-m", subject);
}

beforeAll(async () => {
  requests = [];
  respond = () => ({
    status: 200,
    body: JSON.stringify({ fields: { summary: "Capture customer email", status: { name: "Done" } } }),
  });

  repo = await mkdtemp(join(tmpdir(), "strata-provenance-"));
  await initRepo(repo);
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test Modeller");
  await commit("Add the customer dimension (#42)", "id: tbl_dim_customer\n");

  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    const reply = respond();
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, GIT_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(repo, { recursive: true, force: true }).catch(() => {});
});

afterEach(() => {
  requests = [];
});

/** Jira config pointed at the fake server. */
function jira(overrides: Partial<Parameters<typeof objectProvenance>[0]["jira"]> = {}) {
  return {
    baseUrl: origin,
    email: "modeller@acme.com",
    token: "not-a-real-token",
    projectKeys: "DATA, PLATFORM",
    ...overrides,
  } as NonNullable<Parameters<typeof objectProvenance>[0]["jira"]>;
}

describe("objectProvenance, from git alone", () => {
  it(
    "reports the last commit and the pull request it names",
    async () => {
      const result = await objectProvenance({ root: repo, file: "dim_customer.yaml" });

      expect(result.lastChange?.subject).toBe("Add the customer dimension (#42)");
      expect(result.lastChange?.author).toBe("Test Modeller");
      // The squash-merge form. Parsed with no integration configured and no network call.
      expect(result.lastChange?.pullRequest).toBe(42);
    },
    GIT_TIMEOUT,
  );

  it(
    "finds no ticket when Jira is not configured, and says nothing looked",
    async () => {
      /*
        Without project keys there is nothing to anchor on, and an unanchored `[A-Z]+-\d+` reads
        `UTF-8` and `COVID-19` as ticket keys. Reporting nothing is the honest answer.

        `ticketSource` absent is the part that matters, and it is a real bug this caught: the
        panel told the reader "no ticket found in the commit" for a commit whose subject read
        `DATA-1234`, because nothing had looked. The two states need opposite instructions.
      */
      const result = await objectProvenance({ root: repo, file: "dim_customer.yaml" });
      expect(result.ticket).toBeUndefined();
      expect(result.ticketSource).toBeUndefined();
    },
    GIT_TIMEOUT,
  );

  it("says why there is nothing when the object has no file yet", async () => {
    const result = await objectProvenance({ root: repo, file: undefined });
    expect(result.unavailable).toMatch(/not saved to a file/i);
    expect(result.lastChange).toBeUndefined();
  });

  it("says why there is nothing when the directory is not a repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "strata-provenance-plain-"));
    try {
      const result = await objectProvenance({ root: plain, file: "anything.yaml" });
      expect(result.unavailable).toMatch(/git repository/i);
    } finally {
      await rm(plain, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe("objectProvenance, with Jira", () => {
  it(
    "resolves the ticket named in the commit subject and fills in its detail",
    async () => {
      await commit("DATA-1234 add the email column", "id: tbl_dim_customer\nx: 1\n");

      const result = await objectProvenance({ root: repo, file: "dim_customer.yaml", jira: jira() });

      expect(result.ticket?.key).toBe("DATA-1234");
      expect(result.ticket?.summary).toBe("Capture customer email");
      expect(result.ticket?.status).toBe("Done");
      expect(result.ticket?.url).toBe(`${origin}/browse/DATA-1234`);
      // Only the two fields the panel shows, not the whole issue document.
      expect(requests[0]).toContain("fields=summary,status");
    },
    GIT_TIMEOUT,
  );

  it(
    "ignores a key from a project that is not configured",
    async () => {
      await commit("BILLING-9 unrelated change", "id: tbl_dim_customer\nx: 2\n");

      const result = await objectProvenance({
        root: repo,
        file: "dim_customer.yaml",
        jira: jira({ projectKeys: "DATA" }),
      });

      expect(result.ticket).toBeUndefined();
      // Jira *was* consulted, so the panel should blame the commit subject, not the config.
      expect(result.ticketSource).toBe("jira");
      expect(requests, "an unconfigured project should not cost a request").toHaveLength(0);
    },
    GIT_TIMEOUT,
  );

  it(
    "keeps the commit and explains itself when Jira refuses",
    async () => {
      await commit("DATA-77 another change", "id: tbl_dim_customer\nx: 3\n");
      respond = () => ({ status: 404, body: "{}" });

      const result = await objectProvenance({ root: repo, file: "dim_customer.yaml", jira: jira() });

      // The half that works survives. This is the whole point of the degradation rule.
      expect(result.lastChange?.subject).toBe("DATA-77 another change");
      expect(result.ticket?.key).toBe("DATA-77");
      expect(result.ticket?.url).toBeDefined();
      expect(result.ticket?.summary).toBeUndefined();
      expect(result.ticket?.unavailable).toMatch(/No issue DATA-77/);
    },
    GIT_TIMEOUT,
  );

  it(
    "keeps the commit when Jira is unreachable entirely",
    async () => {
      await commit("DATA-88 yet another change", "id: tbl_dim_customer\nx: 4\n");

      const result = await objectProvenance({
        root: repo,
        file: "dim_customer.yaml",
        // A port with nothing listening. A thrown fetch must not take the commit down with it.
        jira: jira({ baseUrl: "http://127.0.0.1:1" }),
      });

      expect(result.lastChange?.subject).toBe("DATA-88 yet another change");
      expect(result.ticket?.key).toBe("DATA-88");
      expect(result.ticket?.unavailable).toBeTruthy();
    },
    GIT_TIMEOUT,
  );
});
