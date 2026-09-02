import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkspace } from "@strata/storage";
import { MergeWatcher } from "./watcher.js";
import { DeliveryLog } from "./deliveries.js";
import { SecretStore } from "./secrets.js";

const exec = promisify(execFile);

/**
 * Merge detection, against a real repository.
 *
 * Shelling out to real `git` for the same reason `git.test.ts` does: this module's whole job is
 * to interpret what git reports, so a mocked git would only assert that the author's assumptions
 * match the author's implementation. The cases that matter, a branch that moved forward, a
 * history that was rewritten, a commit that touched no model files, are all git behaviours.
 *
 * The webhook target is a loopback server, never a real endpoint.
 */

const GIT_TIMEOUT = 60_000;

let root: string;
let dataDir: string;
let received: string[];
let server: Server;
let origin: string;

async function git(...args: string[]): Promise<void> {
  await exec("git", args, { cwd: root });
}

async function write(relative: string, content: string): Promise<void> {
  const absolute = join(root, relative);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

async function commit(message: string): Promise<void> {
  await git("add", "-A");
  await git("commit", "-m", message);
}

/** A watcher wired to the scratch repo, with the webhook pointed at the loopback server. */
async function watcher(): Promise<MergeWatcher> {
  const secrets = new SecretStore(dataDir);
  await secrets.set("webhook.url", `${origin}/hook`);
  const log = new DeliveryLog(dataDir);

  return new MergeWatcher({
    dataDir,
    getWorkspace: () => loadWorkspace(root),
    context: async () => ({ secrets, log }),
    defaultBranch: async () => "main",
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strata-watch-"));
  dataDir = await mkdtemp(join(tmpdir(), "strata-watch-data-"));
  received = [];

  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await git("init", "--initial-branch=main");
  await git("config", "user.email", "test@strata.local");
  await git("config", "user.name", "Test");

  await write(
    "strata.config.yaml",
    `version: 1
name: watched
roots:
  - "."
integrations:
  webhook:
    enabled: true
    settings:
      format: json
`,
  );
  await write(
    "models/model.yaml",
    `id: m1
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
  - id: col_key
    name: customer_key
    dataType: INT64
`,
  );
  await commit("Initial model");
}, GIT_TIMEOUT);

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true }).catch(() => {});
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe("MergeWatcher", () => {
  it(
    "says nothing on the first observation",
    async () => {
      /*
        The single most important behaviour in this file.

        On a fresh instance every commit that ever happened is technically unseen. Announcing
        the whole history to a Slack channel the moment someone ticks the box would be the worst
        possible introduction to the feature.
      */
      const result = await (await watcher()).check();

      expect(result.status).toBe("baseline-recorded");
      expect(result.deliveries).toHaveLength(0);
      expect(received).toHaveLength(0);
    },
    GIT_TIMEOUT,
  );

  it(
    "dispatches once the branch moves forward, naming what changed",
    async () => {
      const watch = await watcher();
      await watch.check(); // Establishes the baseline.

      await write(
        "models/dim_customer.yaml",
        `id: tbl_dim
kind: table
name: dim_customer
model: warehouse
columns:
  - id: col_key
    name: customer_key
    dataType: INT64
  - id: col_email
    name: email_address
    dataType: STRING
`,
      );
      await commit("Add customer email (#42)");

      const result = await watch.check();

      expect(result.status).toBe("dispatched");
      expect(result.deliveries).toHaveLength(1);
      expect(result.deliveries[0]!.ok).toBe(true);
      expect(received).toHaveLength(1);

      const payload = JSON.parse(received[0]!) as {
        objects: { name: string; change: string }[];
        pullRequest?: number;
        migration: { table: string; statements: string[] }[];
      };

      expect(payload.objects).toEqual([
        expect.objectContaining({ name: "dim_customer", change: "modified" }),
      ]);
      // The PR number is read out of the commit subject, not invented.
      expect(payload.pullRequest).toBe(42);
      // A new column is an in-place ALTER, and saying so is the useful part.
      expect(payload.migration[0]!.statements.join(" ")).toContain("ADD COLUMN");
    },
    GIT_TIMEOUT,
  );

  it(
    "does not re-announce a merge it has already seen",
    async () => {
      const watch = await watcher();
      await watch.check();

      await write("models/dim_customer.yaml", `id: tbl_dim\nkind: table\nname: dim_customer\nmodel: warehouse\ncolumns:\n  - id: col_key\n    name: customer_key\n    dataType: STRING\n`);
      await commit("Retype the key");

      await watch.check();
      const second = await watch.check();

      expect(second.status).toBe("unchanged");
      expect(second.deliveries).toHaveLength(0);
      expect(received).toHaveLength(1);
    },
    GIT_TIMEOUT,
  );

  it(
    "stays quiet for a commit that touches no model files",
    async () => {
      const watch = await watcher();
      await watch.check();

      await write("README.md", "Notes about the warehouse.\n");
      await commit("Document the warehouse");

      const result = await watch.check();

      // Nobody wants a schema-change notification for a README edit.
      expect(result.status).toBe("no-model-changes");
      expect(result.deliveries).toHaveLength(0);
      expect(received).toHaveLength(0);
    },
    GIT_TIMEOUT,
  );

  it(
    "resets without dispatching when the history has been rewritten",
    async () => {
      const watch = await watcher();
      await watch.check();

      await write("models/dim_customer.yaml", `id: tbl_dim\nkind: table\nname: dim_customer\nmodel: warehouse\ncolumns:\n  - id: col_key\n    name: customer_key\n    dataType: INT64\n  - id: col_x\n    name: x\n    dataType: STRING\n`);
      await commit("A change that is about to be rewritten");
      await watch.check();
      received.length = 0;

      /*
        Rewrite history so the recorded sha is no longer an ancestor.

        The old commit still exists in the object database as a dangling object, which is exactly
        why `rev-parse` is not a sufficient reachability test, it would resolve, and the diff
        would then describe two unrelated trees with total confidence.
      */
      await git("reset", "--hard", "HEAD~1");
      await write("models/other.yaml", `id: tbl_other\nkind: table\nname: dim_other\nmodel: warehouse\ncolumns:\n  - id: c1\n    name: k\n    dataType: INT64\n`);
      await commit("A different history");

      const result = await watch.check();

      expect(result.status).toBe("history-rewritten");
      expect(result.deliveries).toHaveLength(0);
      expect(received).toHaveLength(0);
    },
    GIT_TIMEOUT,
  );

  it(
    "falls back to a conventional branch when nothing can name the default",
    async () => {
      /*
        The regression this exists for.

        `status()` reads `refs/remotes/origin/HEAD`, which git writes only during a clone, and
        the GitHub API fallback needs a token. A repository connected with `remote add` and no
        token resolves neither, which is a completely ordinary self-hosted setup, and in it
        merge detection used to return an empty array on every poll forever with no way to tell
        that from "nothing has merged".
      */
      const secrets = new SecretStore(dataDir);
      await secrets.set("webhook.url", `${origin}/hook`);

      const watch = new MergeWatcher({
        dataDir,
        getWorkspace: () => loadWorkspace(root),
        context: async () => ({ secrets, log: new DeliveryLog(dataDir) }),
        defaultBranch: async () => undefined,
      });

      const result = await watch.check();

      expect(result.status).toBe("baseline-recorded");
      expect(result.ref).toBe("main");
    },
    GIT_TIMEOUT,
  );

  it(
    "describes the tree as it is on disk, not as it was cached",
    async () => {
      /*
        Regression. Found by running the real server, not by reading the code.

        The watcher used to summarise against whatever workspace the server had cached. Between
        two polls the tree can move, someone pulls, switches branch, or saves an edit, and the
        summary then compared the old revision against a stale in-memory graph. The first
        end-to-end run produced a migration naming three columns the change had never touched,
        which is worse than no notification: it is a confident, wrong one.

        The fake cache here is deliberately stale in a way the assertion can see.
      */
      const secrets = new SecretStore(dataDir);
      await secrets.set("webhook.url", `${origin}/hook`);

      let cached: Awaited<ReturnType<typeof loadWorkspace>> | undefined;
      const watch = new MergeWatcher({
        dataDir,
        getWorkspace: async (fresh) => {
          if (fresh || !cached) cached = await loadWorkspace(root);
          return cached;
        },
        context: async () => ({ secrets, log: new DeliveryLog(dataDir) }),
        defaultBranch: async () => "main",
      });

      await watch.check(); // Baseline, and populates the cache with the current tree.

      await write(
        "models/dim_customer.yaml",
        `id: tbl_dim
kind: table
name: dim_customer
model: warehouse
columns:
  - id: col_key
    name: customer_key
    dataType: INT64
  - id: col_added
    name: added_after_cache
    dataType: STRING
`,
      );
      await commit("Add a column the cache has never seen");

      const result = await watch.check();

      expect(result.status).toBe("dispatched");
      const payload = JSON.parse(received[0]!) as {
        migration: { table: string; statements: string[] }[];
      };

      // Exactly one statement, for exactly the column that was added.
      const sql = payload.migration.flatMap((entry) => entry.statements).join(" ");
      expect(sql).toContain("added_after_cache");
      expect(payload.migration[0]!.statements).toHaveLength(1);
    },
    GIT_TIMEOUT,
  );

  it(
    "reports a dropped table by name, read out of history",
    async () => {
      const watch = await watcher();
      await watch.check();

      await rm(join(root, "models/dim_customer.yaml"));
      await commit("Drop the customer dimension");

      await watch.check();

      const payload = JSON.parse(received[0]!) as { objects: { name: string; change: string }[]; counts: { removed: number } };

      /*
        The deleted object is gone from the current workspace index by definition, so naming it
        requires reading the file at the *previous* revision. "1 file changed" would be useless;
        "dropped dim_customer" is the whole message.
      */
      expect(payload.objects).toEqual([
        expect.objectContaining({ name: "dim_customer", change: "removed" }),
      ]);
      expect(payload.counts.removed).toBe(1);
    },
    GIT_TIMEOUT,
  );
});
