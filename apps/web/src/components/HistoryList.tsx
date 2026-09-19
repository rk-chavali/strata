import { useEffect, useState } from "react";
import type { JSX } from "react";
import { api } from "../api";
import { Badge, EmptyState, Icon, Loading } from "../ui";
import type { HistoryEntry } from "../types";

/**
 * What changed here, most recent first.
 *
 * This is the analogue of Harness's execution history: the same object, but the record of
 * what has happened to it rather than its current state. For a CI pipeline that is its runs;
 * for a model it is the pull requests and commits that touched its files.
 *
 * **Why it is a list of commits and not a list of pull requests.** Pull requests live on
 * GitHub and reading them needs a token, network access and a rate-limit budget. Commits are
 * in the repository we already have, work offline, and are the truth about what landed, a PR
 * that was closed without merging changed nothing, and one that was merged is a commit. Where
 * a commit records a PR number, which is how GitHub writes both merge and squash commits, it
 * links straight to it. So the common case is fully served and no case is a dead end.
 *
 * The consequence worth stating: a pull request that is still **open** does not appear here,
 * because nothing has landed. Work in progress lives in Changes, which is the working tree.
 */

export function HistoryList({
  /** Scope: exactly one of these. Unscoped would be the whole repo, which is Changes' job. */
  model,
  domain,
  limit = 20,
  /** Compact rendering for embedding in a page that is mostly something else. */
  dense,
  /** Refetch when this changes, pass the workspace refresh key. */
  refreshKey,
}: {
  model?: string;
  domain?: string;
  limit?: number;
  dense?: boolean;
  refreshKey?: number;
}): JSX.Element {
  const [entries, setEntries] = useState<HistoryEntry[] | undefined>();
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);

    api
      .history({ ...(model ? { model } : {}), ...(domain ? { domain } : {}), limit })
      .then((result) => {
        if (cancelled) return;
        setEntries(result.entries);
        setTruncated(result.truncated);
      })
      .catch(() => {
        if (cancelled) return;
        setEntries([]);
        setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [model, domain, limit, refreshKey]);

  if (entries === undefined) return <Loading label="Reading history…" />;

  if (entries.length === 0) {
    return (
      <EmptyState
        icon="branch"
        title={failed ? "Could not read the history" : "Nothing has landed yet"}
        body={
          failed
            ? "The workspace may not be a git repository, or git may not be available on the server."
            : "Once a change to these files is committed, usually through a pull request, it appears here. Work you have not proposed yet is in Changes."
        }
        action={undefined}
      />
    );
  }

  return (
    <div className={`hist${dense ? " hist--dense" : ""}`}>
      {entries.map((entry) => (
        <Entry key={entry.sha} entry={entry} dense={dense} />
      ))}

      {truncated ? (
        <p className="muted small hist__more">Showing the most recent {limit}.</p>
      ) : null}
    </div>
  );
}

function Entry({ entry, dense }: { entry: HistoryEntry; dense?: boolean }): JSX.Element {
  /**
   * The subject, with the pull-request suffix removed.
   *
   * A squash merge writes `Add the customer dimension (#42)`, and the number is already shown
   * as its own badge, leaving it in the text means reading "42" twice on every row.
   */
  const subject = entry.pullRequest
    ? entry.subject.replace(/\s*\(#\d+\)\s*$/, "").replace(/^Merge pull request #\d+ from \S+\s*/, "")
    : entry.subject;

  return (
    <article className="hist__row">
      <span className="hist__mark" aria-hidden>
        <Icon name={entry.merge ? "pr" : "branch"} size={13} />
      </span>

      <div className="hist__body">
        <div className="hist__top">
          {/*
            The PR number is the primary identifier when there is one, it is what a person
            says out loud and what a reviewer searches for, so it leads, and the subject
            follows it.
          */}
          {entry.pullRequest ? (
            entry.pullRequestUrl ? (
              <a
                className="hist__pr"
                href={entry.pullRequestUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                #{entry.pullRequest}
              </a>
            ) : (
              <span className="hist__pr">#{entry.pullRequest}</span>
            )
          ) : null}

          <span className="hist__subject">{subject || "(no message)"}</span>

          {entry.merge && !entry.pullRequest ? <Badge tone="neutral">merge</Badge> : null}
        </div>

        <div className="hist__meta muted small">
          <span title={entry.authorEmail}>{entry.author}</span>
          <span>·</span>
          <time dateTime={entry.date} title={new Date(entry.date).toLocaleString()}>
            {relative(entry.date)}
          </time>
          <span>·</span>
          {entry.commitUrl ? (
            <a className="mono" href={entry.commitUrl} target="_blank" rel="noreferrer noopener">
              {entry.shortSha}
            </a>
          ) : (
            <span className="mono">{entry.shortSha}</span>
          )}
          {entry.files.length > 0 ? (
            <>
              <span>·</span>
              <span>
                {entry.files.length} file{entry.files.length === 1 ? "" : "s"}
              </span>
            </>
          ) : null}
        </div>

        {/*
          Which files, but only when there is room for it. In the dense variant on a domain
          page this would be twenty paths of noise under five rows of signal.
        */}
        {!dense && entry.files.length > 0 ? (
          <ul className="hist__files">
            {entry.files.slice(0, 6).map((file) => (
              <li key={file} className="mono truncate-start">
                {file}
              </li>
            ))}
            {entry.files.length > 6 ? (
              <li className="muted">and {entry.files.length - 6} more</li>
            ) : null}
          </ul>
        ) : null}
      </div>
    </article>
  );
}

/**
 * A relative time, computed once per render.
 *
 * Not a live ticking clock: nothing here changes minute to minute, and a component that
 * re-renders on a timer to move "3 hours ago" to "4 hours ago" costs a wake-up per minute
 * for a change nobody is waiting for.
 */
function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return iso;

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";

  /**
   * Largest unit first, first match wins.
   *
   * The obvious alternative, walking upwards and keeping the last unit that fits, needs a
   * running "best so far" and gets the boundary cases wrong in ways that only show up on
   * commits from exactly a month ago. Descending order makes the first hit the answer.
   */
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];

  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of units) {
    if (seconds >= size) return formatter.format(-Math.round(seconds / size), unit);
  }
  return "just now";
}
