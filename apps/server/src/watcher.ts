import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoadedWorkspace } from "@strata/storage";
import { fetchRemote, history, isAncestor, revision } from "./git.js";
import { buildChangeSummary } from "./changes.js";
import { dispatch, type DispatchContext } from "./dispatch.js";
import type { Delivery } from "./deliveries.js";

/**
 * Noticing that something merged.
 *
 * There is no webhook receiver, and adding one would mean asking every self-hosted operator to
 * expose a port to GitHub, which for a tool that runs inside a company network is a much larger
 * ask than it sounds. So merges are detected by polling: remember the sha the default branch
 * pointed at, and when it moves, describe what moved.
 *
 * Two behaviours here are load-bearing and both are about *not* firing:
 *
 * **The first observation never dispatches.** On a fresh instance there is no previous sha, so
 * "everything that ever happened" is technically new. Announcing the entire history to a Slack
 * channel the moment someone enables the integration is the single worst first impression this
 * feature could make. The first poll records the sha and stays quiet.
 *
 * **A rewritten history never dispatches.** If the recorded sha is no longer an ancestor, a
 * force push, a rebased branch, the range is meaningless and the diff would be nonsense. The
 * watcher resets to the new head and says nothing.
 */

/** How often the default branch is checked, when no interval is configured. */
const DEFAULT_INTERVAL_MS = 60_000;

interface WatchState {
  /** Last observed head sha, keyed by the ref watched. */
  seen: Record<string, string>;
}

export interface WatcherOptions {
  dataDir: string;
  /**
   * The workspace, reloaded from disk when `fresh` is set.
   *
   * The distinction matters more than it looks. A poll runs every minute against a server whose
   * workspace is cached, and between two polls the tree can move underneath it, someone pulls,
   * someone switches branch, someone saves an edit. Building the summary from a stale graph
   * compares the old revision against whatever happened to be in memory, and produces a
   * migration listing columns the change never touched. Observed, not theorised: it named three
   * unrelated columns on the first end-to-end run.
   */
  getWorkspace: (fresh?: boolean) => Promise<LoadedWorkspace>;
  context: () => Promise<Omit<DispatchContext, "workspace">>;
  /** Resolved per poll, because a remote can be configured after the server starts. */
  defaultBranch: () => Promise<string | undefined>;
  githubToken?: () => Promise<string | undefined>;
  intervalMs?: number;
}

/**
 * Why a poll did what it did.
 *
 * Every one of these is a state in which **nothing is sent**, and that is exactly why they are
 * named. The worst version of this feature is one an operator enables, sees no notifications
 * from, and cannot distinguish "nothing has merged" from "this has been broken for a week". A
 * poll that quietly returns an empty array is indistinguishable from one that never ran.
 */
export type WatchStatus =
  /** Providers were invoked. */
  | "dispatched"
  /** No default branch could be resolved, so there is nothing to watch. */
  | "no-default-branch"
  /** First sighting: the head was recorded and deliberately not announced. */
  | "baseline-recorded"
  /** The branch has not moved. The ordinary answer. */
  | "unchanged"
  /** The recorded sha is no longer an ancestor; reset without announcing. */
  | "history-rewritten"
  /** The branch moved, but no model files changed. */
  | "no-model-changes";

export interface WatchResult {
  status: WatchStatus;
  /** The ref actually watched, e.g. `origin/main` or `main`. */
  ref?: string;
  head?: string;
  checkedAt: string;
  deliveries: Delivery[];
}

/**
 * Branch names tried when neither the remote nor the GitHub API can say what the default is.
 *
 * `status()` reads `refs/remotes/origin/HEAD`, which git only writes during a clone, and the API
 * fallback needs a token. A repository connected with `remote add` and no token configured
 * therefore resolves nothing at all, which is a very ordinary state for a self-hosted install,
 * and one in which merge detection used to sit inert with no way to tell.
 */
const FALLBACK_BRANCHES = ["main", "master"];

export class MergeWatcher {
  private timer: NodeJS.Timeout | undefined;
  /** Guards against a slow poll overlapping the next tick. */
  private running = false;

  constructor(private readonly options: WatcherOptions) {}

  private get file(): string {
    return join(this.options.dataDir, "merge-state.json");
  }

  start(): void {
    if (this.timer) return;
    const interval = this.options.intervalMs ?? DEFAULT_INTERVAL_MS;

    /*
      `unref` so the poller cannot hold the process open.

      Without it, a `strata` server that is asked to shut down waits out the full interval first,
      and a test that constructs a watcher never exits at all.
    */
    this.timer = setInterval(() => void this.check().catch(() => undefined), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One poll.
   *
   * Public because the same work backs the "check now" action on the integrations page, an
   * operator who has just fixed a token should not have to wait out the interval to find out
   * whether it worked.
   */
  async check(): Promise<WatchResult> {
    const checkedAt = new Date().toISOString();
    const idle = (status: WatchStatus, extra: Partial<WatchResult> = {}): WatchResult => ({
      status,
      checkedAt,
      deliveries: [],
      ...extra,
    });

    if (this.running) return idle("unchanged");
    this.running = true;

    try {
      const workspace = await this.options.getWorkspace();
      const token = await this.options.githubToken?.();

      /*
        Fetch before resolving anything.

        Reading the *local* branch would only ever see merges made on this machine, which is
        precisely the case that does not need announcing, the person who made it was here.
      */
      const fetched = await fetchRemote(workspace.root, token);

      const resolved = await this.resolveRef(workspace.root, fetched);
      if (!resolved) return idle("no-default-branch");
      const { ref, head } = resolved;

      const state = await this.read();
      const previous = state.seen[ref];

      if (!previous) {
        // First sighting. Record and stay quiet, see the note at the top of the file.
        await this.write({ seen: { ...state.seen, [ref]: head } });
        return idle("baseline-recorded", { ref, head });
      }

      if (previous === head) return idle("unchanged", { ref, head });

      /*
        Confirm the branch simply moved *forward* before describing a range from the old sha.

        After a force push it did not. The old commit usually still exists locally as a dangling
        object, so merely resolving it proves nothing, the range would then describe a diff
        between two unrelated trees with complete confidence. Resetting silently is right: the
        history was rewritten by someone who knew they were doing it.
      */
      if (!(await isAncestor(workspace.root, previous, head))) {
        await this.write({ seen: { ...state.seen, [ref]: head } });
        return idle("history-rewritten", { ref, head });
      }

      const entries = await history(workspace.root, { limit: 1 });
      const latest = entries.entries[0];

      /*
        Reload before describing the change, not before deciding whether there is one.

        The cheap path, "has the branch moved?", runs every minute and needs nothing but git.
        The expensive path runs only when something actually merged, so paying for a fresh parse
        of the whole workspace there costs nothing in the common case and is the only way the
        summary can be about the tree as it now is.
      */
      const current = await this.options.getWorkspace(true);

      const summary = await buildChangeSummary(current, {
        event: "merged",
        range: { from: previous, to: head },
        branch: ref.replace(/^origin\//, ""),
        sha: head,
        ...(latest?.subject ? { subject: latest.subject } : {}),
        ...(latest?.author ? { author: latest.author } : {}),
        ...(latest?.date ? { date: latest.date } : {}),
        ...(latest?.pullRequest ? { pullRequest: latest.pullRequest } : {}),
        ...(latest?.pullRequestUrl ? { pullRequestUrl: latest.pullRequestUrl } : {}),
      });

      /*
        The sha is recorded *before* dispatching, not after.

        If a provider is slow and the next tick fires, or the process dies mid-dispatch, the
        alternative ordering re-announces the same merge on every poll until it succeeds. A
        missed notification is a smaller failure than an unbounded loop of duplicates.
      */
      await this.write({ seen: { ...state.seen, [ref]: head } });

      // A merge that touched no model files is not worth a notification.
      if (summary.objects.length === 0) return idle("no-model-changes", { ref, head });

      return {
        status: "dispatched",
        ref,
        head,
        checkedAt,
        deliveries: await dispatch({ workspace: current, ...(await this.options.context()) }, summary),
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * Which ref to watch, and where it currently points.
   *
   * Prefers what the caller resolved (the remote's own default, or the GitHub API), then falls
   * back to the conventional names. The fallback is what makes this work on a repository
   * connected with `remote add` and no token, the common self-hosted case, and the one where
   * merge detection previously did nothing at all with no way to find out why.
   */
  private async resolveRef(
    root: string,
    fetched: boolean,
  ): Promise<{ ref: string; head: string } | undefined> {
    const declared = await this.options.defaultBranch();
    const candidates = declared ? [declared, ...FALLBACK_BRANCHES] : FALLBACK_BRANCHES;

    for (const branch of candidates) {
      // The remote-tracking ref first: it sees merges made anywhere, which is the point.
      for (const ref of fetched ? [`origin/${branch}`, branch] : [branch, `origin/${branch}`]) {
        const head = await revision(root, ref);
        if (head) return { ref, head };
      }
    }

    return undefined;
  }

  private async read(): Promise<WatchState> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as WatchState;
      return { seen: parsed.seen ?? {} };
    } catch {
      return { seen: {} };
    }
  }

  private async write(state: WatchState): Promise<void> {
    await mkdir(this.options.dataDir, { recursive: true });
    await writeFile(this.file, JSON.stringify(state, null, 2), "utf8");
  }
}
