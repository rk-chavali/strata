import { history, type HistoryEntry } from "./git.js";
import { ticketKey } from "./dispatch.js";
import { safeFetch, trimTrailingSlashes } from "./ssrf.js";

/**
 * Why does this object exist, and who asked for it?
 *
 * The question a data model cannot currently answer, and the one it is uniquely placed to. Six
 * months after `dim_customer` gained a column, the only record of *why* is a ticket in a system
 * nobody thinks to search, and the archaeology costs an afternoon. Every other tool would have to
 * build a link table to answer this. strata does not: changes already travel through git, so the
 * commit that introduced a column already names the pull request, and the pull request title
 * already carries the ticket key. This reads what is already there.
 *
 * **The integrations were write-only, and that is the gap this closes.** Every provider fires
 * outbound on an event and posts somewhere. Nothing ever read anything back, so configuring Jira
 * produced a comment on a ticket and no visible benefit inside the product at all. A provider
 * that can also be *asked* a question is what turns the integrations page from configuration into
 * a feature.
 *
 * **Git alone answers most of it.** The commit, the author, the date and the pull request need no
 * integration and no credentials, so this returns something useful on a workspace that has
 * configured nothing. Jira only adds the ticket's summary and status on top. That ordering is
 * deliberate: a panel that is empty until you configure a SaaS product is a panel nobody sees.
 */

export interface TicketRef {
  key: string;
  /** Deep link, built from the configured site. Present whenever the key is. */
  url?: string;
  summary?: string;
  status?: string;
  /**
   * Why summary and status are missing, when they are.
   *
   * Stated rather than left blank. "DATA-1234" with nothing beside it reads as a broken panel;
   * "DATA-1234, Jira is not configured" reads as a working panel with a next step.
   */
  unavailable?: string;
}

export interface ObjectProvenance {
  /** The last commit that touched this object's file, when the workspace is a repository. */
  lastChange?: {
    sha: string;
    shortSha: string;
    subject: string;
    author: string;
    date: string;
    commitUrl?: string;
    pullRequest?: number;
    pullRequestUrl?: string;
  };
  ticket?: TicketRef;
  /**
   * Whether anything was consulted for a ticket at all.
   *
   * Without this the panel cannot tell two very different states apart, and it got the wording
   * wrong on the first run: a commit whose subject plainly read `DATA-1234` was reported as "no
   * ticket found in the commit", because Jira was unconfigured so nothing had looked. One state
   * means "connect Jira", the other means "put the key in your commit message", and an empty
   * state that gives the wrong instruction is worse than one that gives none.
   */
  ticketSource?: "jira";
  /**
   * Why there is no history, when there is none.
   *
   * A workspace that is not a git repository, or a file committed by nobody yet, are both
   * ordinary states rather than errors, and the panel should say which.
   */
  unavailable?: string;
}

/** Credentials for reading a ticket. Absent when the operator has not configured Jira. */
export interface JiraReadConfig {
  baseUrl: string;
  email: string;
  token: string;
  /** Comma-separated project keys, used to recognise a key in a commit subject. */
  projectKeys?: string;
}

/** How long a single Jira read gets. Shorter than dispatch: a person is waiting for this one. */
const TIMEOUT_MS = 8_000;

/**
 * Assemble what is known about why an object exists.
 *
 * Never throws. Every stage degrades to "less detail" rather than "no answer", because this
 * renders in a panel beside the model: a request that failed because Jira was slow should show
 * the commit it did find, not an error where the whole section used to be.
 */
export async function objectProvenance(options: {
  root: string;
  /** Repo-relative path of the file the object lives in. */
  file: string | undefined;
  jira?: JiraReadConfig;
}): Promise<ObjectProvenance> {
  if (!options.file) {
    return { unavailable: "This object is not saved to a file yet." };
  }

  const { entries } = await history(options.root, { paths: [options.file], limit: 1 });
  const last = entries[0];

  if (!last) {
    return {
      unavailable: "No commit has touched this file yet, or the workspace is not a git repository.",
    };
  }

  return {
    lastChange: describeCommit(last),
    ...(await resolveTicket(last, options.jira)),
  };
}

function describeCommit(entry: HistoryEntry): NonNullable<ObjectProvenance["lastChange"]> {
  return {
    sha: entry.sha,
    shortSha: entry.shortSha,
    subject: entry.subject,
    author: entry.author,
    date: entry.date,
    ...(entry.commitUrl ? { commitUrl: entry.commitUrl } : {}),
    ...(entry.pullRequest ? { pullRequest: entry.pullRequest } : {}),
    ...(entry.pullRequestUrl ? { pullRequestUrl: entry.pullRequestUrl } : {}),
  };
}

/**
 * Find the ticket, and fill in its detail when Jira is reachable.
 *
 * **Only the commit subject is searched, not the branch or a trailer.** The branch is gone by the
 * time a change is in history, and the body is not captured by the log format, which uses `%s`
 * and pairs each commit's header with its own file list by splitting on newlines. Adding `%b`
 * there would put a multi-line value inside a single-line header and break that parse, which has
 * already produced one hard-to-find bug in this file's history. A squash merge puts the ticket in
 * the subject, which is the common convention and enough to be useful.
 */
async function resolveTicket(
  entry: HistoryEntry,
  jira: JiraReadConfig | undefined,
): Promise<{ ticket?: TicketRef; ticketSource?: "jira" }> {
  /*
    Without Jira configured there are no project keys, and without project keys there is nothing
    to match: an unanchored `[A-Z]+-\d+` would read `UTF-8` and `COVID-19` as tickets. So an
    unconfigured workspace reports no ticket rather than a guessed one, and says so via
    `ticketSource` so the panel does not blame the commit message for it.
  */
  if (!jira) return {};

  const key = ticketKey(jira.projectKeys, undefined, entry.subject);
  if (!key) return { ticketSource: "jira" };

  const site = trimTrailingSlashes(jira.baseUrl);
  const ticket: TicketRef = { key, url: `${site}/browse/${key}` };

  try {
    // `fields=summary,status` rather than the whole issue: an issue document is large, and this
    // is on the path of opening an object.
    const response = await safeFetch(`${site}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${jira.email}:${jira.token}`).toString("base64")}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (response.status === 404) {
      return { ticketSource: "jira", ticket: { ...ticket, unavailable: `No issue ${key}, or the account cannot see it.` } };
    }
    if (!response.ok) {
      return { ticketSource: "jira", ticket: { ...ticket, unavailable: `Jira returned ${response.status}.` } };
    }

    const body = (await response.json()) as {
      fields?: { summary?: string; status?: { name?: string } };
    };

    return {
      ticketSource: "jira",
      ticket: {
        ...ticket,
        ...(body.fields?.summary ? { summary: body.fields.summary } : {}),
        ...(body.fields?.status?.name ? { status: body.fields.status.name } : {}),
      },
    };
  } catch (error) {
    /*
      Swallowed into the payload rather than thrown.

      The commit is the useful half and it is already resolved. Failing the whole request because
      a third party timed out would hide the part that works, on the page where someone is trying
      to understand a model.
    */
    return {
      ticketSource: "jira",
      ticket: { ...ticket, unavailable: error instanceof Error ? error.message : String(error) },
    };
  }
}
