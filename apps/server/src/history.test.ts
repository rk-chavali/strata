import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { history, pullRequestNumber } from "./git.js";

const exec = promisify(execFile);

/**
 * `history()` against a real repository, and the PR-number parser against real subjects.
 *
 * Same reasoning as the rest of this module's tests: the job is to drive `git log` and parse
 * what comes back, so a mocked git would only assert that the arguments match the author's
 * expectation, the implementation's own assumption, checked twice.
 *
 * The cases that matter are the ones a naive version gets wrong: path scoping (a commit that
 * touched a *different* model must not appear), multi-line commit messages (which break any
 * newline-delimited format), and the two different ways GitHub records a pull request.
 */

const GIT_TIMEOUT = 60_000;

let root: string;

async function git(...args: string[]): Promise<void> {
  await exec("git", args, { cwd: root });
}

async function commit(message: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  await git("add", "-A");
  await git("commit", "--quiet", "-m", message);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "strata-history-"));
  await git("init", "--quiet", "--initial-branch=main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test Person");

  await commit("Add the customer entity", { "models/core/customer.yaml": "id: a\n" });
  await commit("Add the order table (#42)", { "models/mart/orders.yaml": "id: b\n" });
  await commit(
    "Widen the amount column\n\nIt needed more precision than NUMERIC(9,2) allowed.",
    { "models/mart/orders.yaml": "id: b\nchanged: true\n" },
  );
}, GIT_TIMEOUT);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("pullRequestNumber", () => {
  it("reads a merge commit", () => {
    expect(pullRequestNumber("Merge pull request #42 from acme/feature")).toBe(42);
  });

  it("reads a squash merge", () => {
    expect(pullRequestNumber("Add the customer dimension (#128)")).toBe(128);
  });

  it("finds nothing in an ordinary commit", () => {
    expect(pullRequestNumber("Fix the amount column")).toBeUndefined();
  });

  it("does not credit a number merely mentioned in passing", () => {
    /**
     * The anchor is the point. `(#42)` only counts at the very end, where a squash merge puts
     * it, a subject that happens to discuss issue 42 has not been merged by pull request 42,
     * and linking it to one would send a reviewer to the wrong page.
     */
    expect(pullRequestNumber("Fix the bug described in #42")).toBeUndefined();
    expect(pullRequestNumber("Revert (#42) and start again")).toBeUndefined();
  });

  it("ignores a merge of something that is not a pull request", () => {
    expect(pullRequestNumber("Merge branch 'main' into feature")).toBeUndefined();
  });
});

describe("history", () => {
  it(
    "returns commits most recent first",
    async () => {
      const { entries } = await history(root);
      expect(entries.map((entry) => entry.subject)).toEqual([
        "Widen the amount column",
        "Add the order table (#42)",
        "Add the customer entity",
      ]);
    },
    GIT_TIMEOUT,
  );

  it(
    "scopes to the paths it was given",
    async () => {
      /**
       * The whole feature rests on this. History "for a model" is history for that model's
       * files, and a commit touching a sibling model must not appear, otherwise every model
       * in the repo shows the same history and the view says nothing.
       */
      const { entries } = await history(root, { paths: ["models/core/customer.yaml"] });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.subject).toBe("Add the customer entity");
    },
    GIT_TIMEOUT,
  );

  it(
    "survives a multi-line commit message",
    async () => {
      /**
       * A newline-delimited log format breaks here, silently, by treating the body as another
       * commit. The subject is the first line and the body must not leak into it or into the
       * file list.
       */
      const { entries } = await history(root, { paths: ["models/mart/orders.yaml"] });
      const widened = entries.find((entry) => entry.subject.startsWith("Widen"));
      expect(widened?.subject).toBe("Widen the amount column");
      expect(widened?.files).toEqual(["models/mart/orders.yaml"]);
    },
    GIT_TIMEOUT,
  );

  it(
    "links a pull request when the commit records one",
    async () => {
      const { entries } = await history(root);
      const squashed = entries.find((entry) => entry.pullRequest === 42);
      expect(squashed).toBeDefined();
      expect(squashed?.subject).toBe("Add the order table (#42)");
    },
    GIT_TIMEOUT,
  );

  it(
    "has no pull request URL without a GitHub remote",
    async () => {
      /**
       * This repository has no remote, so there is nowhere to link to. Emitting a
       * `github.com/undefined/undefined` URL would be worse than emitting none.
       */
      const { entries } = await history(root);
      expect(entries.every((entry) => entry.pullRequestUrl === undefined)).toBe(true);
      expect(entries.every((entry) => entry.commitUrl === undefined)).toBe(true);
    },
    GIT_TIMEOUT,
  );

  it(
    "reports truncation without a second count",
    async () => {
      const { entries, truncated } = await history(root, { limit: 2 });
      expect(entries).toHaveLength(2);
      expect(truncated).toBe(true);
    },
    GIT_TIMEOUT,
  );

  it(
    "does not report truncation when everything fits",
    async () => {
      const { truncated } = await history(root, { limit: 50 });
      expect(truncated).toBe(false);
    },
    GIT_TIMEOUT,
  );

  it(
    "answers an explicitly empty scope with an empty history",
    async () => {
      /**
       * A model with no files on disk yet has an empty history, not the repository's. Falling
       * back to the whole log here would show every model the same unrelated commits.
       */
      const { entries } = await history(root, { paths: [] });
      expect(entries).toEqual([]);
    },
    GIT_TIMEOUT,
  );

  it(
    "returns nothing for a directory that is not a repository",
    async () => {
      const plain = await mkdtemp(join(tmpdir(), "strata-nonrepo-"));
      try {
        const { entries } = await history(plain);
        expect(entries).toEqual([]);
      } finally {
        await rm(plain, { recursive: true, force: true });
      }
    },
    GIT_TIMEOUT,
  );
});
