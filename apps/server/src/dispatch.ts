import type { LoadedWorkspace } from "@strata/storage";
import { generateDocs } from "@strata/ddl";
import {
  PROVIDERS,
  isReady,
  secretFields,
  secretKey,
  type IntegrationEvent,
  type ProviderDefinition,
} from "./integrations.js";
import { summarySentence, type ChangeSummary } from "./changes.js";
import type { DeliveryLog, Delivery } from "./deliveries.js";
import type { SecretStore } from "./secrets.js";
import { safeFetch, trimTrailingSlashes } from "./ssrf.js";

/**
 * Firing the integrations.
 *
 * The registry, the config, the secret store and the page were all built before this; nothing
 * fired. This is the half that makes them true.
 *
 * Three properties matter more than the provider implementations themselves:
 *
 * **Isolation.** One provider throwing must not stop the others, and must never propagate back
 * into the merge or the proposal that triggered it. An integration is a side effect of the model
 * changing; a broken Confluence token is not a reason to refuse someone's pull request. Every
 * invocation is wrapped, every outcome recorded, and nothing rethrows.
 *
 * **A deadline.** A provider that hangs is worse than one that fails, because it hangs the
 * dispatch. Each call gets a hard timeout, and a timeout is recorded as a normal failure with a
 * message that says what happened.
 *
 * **Readiness before invocation.** An enabled-but-incomplete provider is skipped with a stated
 * reason rather than called and allowed to fail. The failure would be identical every time and
 * would bury the real failures in the log.
 */

/** How long any single provider gets before it is abandoned. */
const TIMEOUT_MS = 15_000;

/** GitHub rejects an issue comment body longer than this with a 422. */
const COMMENT_LIMIT = 65_536;

export interface DispatchContext {
  workspace: LoadedWorkspace;
  secrets: SecretStore;
  log: DeliveryLog;
}

/** What a provider reports back. Never an exception, the dispatcher converts those. */
interface ProviderResult {
  ok: boolean;
  message: string;
  detail?: string;
  status?: number;
  /** What was sent, for the delivery log. Must not contain credentials. */
  preview?: string;
}

/**
 * Run every provider that responds to this event.
 *
 * Returns the deliveries it recorded so a caller can surface them immediately, but the caller is
 * free to ignore the result: the log is the durable record, and the return value is a convenience.
 */
export async function dispatch(
  context: DispatchContext,
  summary: ChangeSummary,
): Promise<Delivery[]> {
  const configured = context.workspace.config.integrations ?? {};
  const deliveries: Delivery[] = [];

  for (const provider of PROVIDERS) {
    const config = configured[provider.id];
    if (!config?.enabled) continue;

    /*
      The configured event list wins over the provider's declared one.

      A provider declares which events it *can* respond to; an operator narrows that to the ones
      they want. Falling back to the declaration when they have not chosen means enabling a
      provider does the obvious thing without a second decision.
    */
    const events = (config.events?.length ? config.events : provider.events) as IntegrationEvent[];
    if (!events.includes(summary.event)) continue;

    deliveries.push(await invoke(context, provider, summary));
  }

  return deliveries;
}

/** Resolve one provider's configuration, check it, run it, and record what happened. */
async function invoke(
  context: DispatchContext,
  provider: ProviderDefinition,
  summary: ChangeSummary,
): Promise<Delivery> {
  const started = Date.now();
  const settings = context.workspace.config.integrations?.[provider.id]?.settings ?? {};

  const secrets: Record<string, string | undefined> = {};
  for (const field of secretFields(provider)) {
    secrets[field.key] = await context.secrets.get(secretKey(provider.id, field.key));
  }

  const record = (result: ProviderResult): Promise<Delivery> =>
    context.log.record({
      provider: provider.id,
      event: summary.event,
      ok: result.ok,
      message: result.message,
      durationMs: Date.now() - started,
      summary: summarySentence(summary),
      ...(result.detail ? { detail: result.detail } : {}),
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(result.preview ? { preview: result.preview } : {}),
      ...(summary.sha ? { sha: summary.sha, shortSha: summary.shortSha ?? summary.sha.slice(0, 7) } : {}),
    });

  const presence = Object.fromEntries(
    Object.entries(secrets).map(([key, value]) => [key, { configured: Boolean(value) }]),
  );
  if (!isReady(provider, settings, presence)) {
    return record({
      ok: false,
      message: "Skipped: enabled but not fully configured.",
      detail: "Fill in the required fields, or turn the integration off.",
    });
  }

  try {
    return await record(await withTimeout(run(context, provider, settings, secrets, summary)));
  } catch (error) {
    /*
      Everything lands here, including a timeout.

      Recorded rather than thrown, because the caller is a merge poller or a propose route and
      neither has anything useful to do with the exception. The operator finds it on the page.
    */
    return await record({ ok: false, message: describe(error) });
  }
}

/**
 * Turn a thrown value into something an operator can act on.
 *
 * Node's `fetch` throws `TypeError: fetch failed` and puts the only useful part, the DNS or
 * socket error, on `cause`. Recording the outer message alone produces a delivery log full of
 * "fetch failed", which tells the reader nothing about whether the host is wrong, the port is
 * closed, or the certificate is bad. Observed on the first run against a dead port.
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const cause = (error as { cause?: unknown }).cause;
  const code = (cause as { code?: string } | undefined)?.code;

  if (code) {
    const explained = CONNECTION_ERRORS[code];
    return explained ? `${explained} (${code})` : `${error.message}: ${code}`;
  }

  return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
}

/** The socket errors worth translating, because their codes are not self-explanatory. */
const CONNECTION_ERRORS: Record<string, string> = {
  ECONNREFUSED: "Nothing is listening at that address",
  ENOTFOUND: "That host does not resolve",
  ETIMEDOUT: "The host did not respond in time",
  ECONNRESET: "The connection was closed by the other end",
  EHOSTUNREACH: "That host is unreachable from this machine",
  CERT_HAS_EXPIRED: "The server's TLS certificate has expired",
  DEPTH_ZERO_SELF_SIGNED_CERT: "The server uses a self-signed certificate",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "The server's TLS certificate could not be verified",
};

/** Reject after the deadline, so a hanging provider cannot hang the dispatch. */
async function withTimeout(work: Promise<ProviderResult>): Promise<ProviderResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`No response within ${TIMEOUT_MS / 1000}s. Treated as failed.`)),
          TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function run(
  context: DispatchContext,
  provider: ProviderDefinition,
  settings: Record<string, string>,
  secrets: Record<string, string | undefined>,
  summary: ChangeSummary,
): Promise<ProviderResult> {
  switch (provider.id) {
    case "webhook":
      return sendWebhook(settings, secrets, summary);
    case "confluence":
      return publishConfluence(context, settings, secrets);
    case "jira":
      return commentJira(settings, secrets, summary);
    case "github":
      return commentGithub(context, settings, secrets, summary);
    default:
      return Promise.resolve({ ok: false, message: `\`${provider.id}\` has no dispatch implementation.` });
  }
}

// ---------------------------------------------------------------- webhook

async function sendWebhook(
  settings: Record<string, string>,
  secrets: Record<string, string | undefined>,
  summary: ChangeSummary,
): Promise<ProviderResult> {
  const url = secrets.url;
  if (!url) return { ok: false, message: "No webhook URL configured." };

  /*
    `slack` is the default rather than `json`.

    Slack and Teams incoming webhooks both render a bare `text` field, and between them they are
    almost every webhook anyone points at this. A raw summary posted to Slack renders as an
    unreadable blob, so defaulting to the format that works in the common case is the kinder
    default, `json` is there for the person who has written a receiver and knows they want it.
  */
  const format = (settings.format ?? "slack").trim().toLowerCase();
  const body = format === "json" ? JSON.stringify(summary) : JSON.stringify({ text: slackText(summary) });

  const response = await safeFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await response.text().catch(() => "");

  return {
    ok: response.ok,
    status: response.status,
    message: response.ok
      ? `Posted to ${new URL(url).host}.`
      : `${new URL(url).host} returned ${response.status} ${response.statusText}.`,
    ...(text && !response.ok ? { detail: text.slice(0, 300) } : {}),
    // The body, never the URL: the URL is the credential.
    preview: body,
  };
}

/**
 * The message a channel receives.
 *
 * Written as prose rather than fields because it is read in a feed between two conversations.
 * The ordering is deliberate: what happened, then what it breaks, then what it costs to apply.
 * A reader who stops after the first line has still learnt the useful thing.
 */
function slackText(summary: ChangeSummary): string {
  const lines: string[] = [];

  const where = summary.pullRequest ? ` (#${summary.pullRequest})` : "";
  const headline =
    summary.event === "validationFailed"
      ? `*${summary.workspace}*, validation failed on \`${summary.branch ?? "the current branch"}\``
      : summary.event === "proposed"
        ? `*${summary.workspace}*, proposal opened${where}`
        : `*${summary.workspace}*, model change merged${where}`;

  lines.push(headline);
  if (summary.subject) lines.push(`> ${summary.subject}`);
  lines.push(summarySentence(summary));

  const named = summary.objects
    .slice(0, 8)
    .map((object) => `${symbol(object.change)} ${object.name}`)
    .join("  ");
  if (named) {
    lines.push("", named + (summary.objects.length > 8 ? `  …and ${summary.objects.length - 8} more` : ""));
  }

  const breaks = summary.downstream.filter((entry) => entry.severity === "breaks");
  if (breaks.length > 0) {
    lines.push("", "*Breaks downstream:*");
    for (const entry of breaks.slice(0, 5)) lines.push(`• ${entry.dependent}, ${entry.reason}`);
    if (breaks.length > 5) lines.push(`• …and ${breaks.length - 5} more`);
  }

  if (summary.migration.length > 0) {
    const recreate = summary.migration.filter((entry) => entry.requiresRecreate);
    lines.push(
      "",
      recreate.length > 0
        ? `*Migration:* ${recreate.length} table(s) must be rebuilt, not altered in place.`
        : `*Migration:* ${summary.migration.length} table(s) alter in place.`,
    );
  }

  if (summary.errors.length > 0) {
    lines.push("", "*Errors:*");
    for (const error of summary.errors.slice(0, 5)) lines.push(`• ${error.message}`);
  }

  return lines.join("\n");
}

function symbol(change: string): string {
  return change === "added" ? "+" : change === "removed" ? "−" : "~";
}

// ---------------------------------------------------------------- confluence

async function publishConfluence(
  context: DispatchContext,
  settings: Record<string, string>,
  secrets: Record<string, string | undefined>,
): Promise<ProviderResult> {
  const { baseUrl, email, pageId } = settings;
  const token = secrets.token;

  if (!pageId) {
    return {
      ok: false,
      message: "No page id configured, so there is nothing to overwrite.",
      detail: "Set the page id to the wiki page that should mirror the data dictionary.",
    };
  }

  const api = `${trimTrailingSlashes(baseUrl ?? "")}/rest/api/content/${encodeURIComponent(pageId)}`;
  const authorization = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

  /*
    Read before write, because Confluence requires the version number incremented.

    There is no "just overwrite it" call. Sending a stale version is how you get a 409, and
    guessing the next number is how you get a 409 intermittently, which is worse, because it
    works in testing.
  */
  const current = await safeFetch(`${api}?expand=version`, {
    headers: { authorization, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!current.ok) {
    return {
      ok: false,
      status: current.status,
      message:
        current.status === 404
          ? `No page ${pageId} on that site, or the account cannot see it.`
          : `Confluence returned ${current.status} ${current.statusText} when reading the page.`,
    };
  }

  const page = (await current.json()) as { title?: string; version?: { number?: number } };
  const version = page.version?.number ?? 0;

  const docs = generateDocs(context.workspace.graph, {
    format: "html",
    workspaceName: context.workspace.config.name,
    resolveClassification: true,
    /*
      A fixed stamp rather than the clock.

      `generateDocs` embeds whatever it is given, and passing `Date.now()` would make every
      republish a genuine content change, so the wiki page would show a new version on every
      merge even when the dictionary is identical. Confluence's version history is worth
      keeping meaningful.
    */
    generatedAt: "",
  });

  const body = docs.map((file) => file.contents).join("\n");

  const updated = await safeFetch(api, {
    method: "PUT",
    headers: { authorization, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      id: pageId,
      type: "page",
      title: page.title ?? context.workspace.config.name,
      version: { number: version + 1 },
      body: { storage: { value: body, representation: "storage" } },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!updated.ok) {
    const text = await updated.text().catch(() => "");
    return {
      ok: false,
      status: updated.status,
      message: `Confluence rejected the update with ${updated.status} ${updated.statusText}.`,
      ...(text ? { detail: text.slice(0, 300) } : {}),
    };
  }

  return {
    ok: true,
    status: updated.status,
    message: `Republished "${page.title ?? pageId}" as version ${version + 1}.`,
    detail: `${docs.length} model document(s), ${body.length.toLocaleString()} characters.`,
    preview: body,
  };
}

// ---------------------------------------------------------------- jira

/**
 * Find the ticket this change belongs to.
 *
 * Looks in the branch name first, then the commit subject. Both are places teams genuinely put
 * it, and a team that puts it in neither gets no comment rather than a wrong one, which is why
 * this returns `undefined` rather than guessing at the first uppercase word it sees.
 *
 * Exported for the tests, because the extraction is the part with edge cases and the HTTP call
 * around it is not.
 */
export function ticketKey(
  projectKeys: string | undefined,
  branch: string | undefined,
  subject: string | undefined,
): string | undefined {
  const keys = (projectKeys ?? "")
    .split(",")
    .map((key) => key.trim().toUpperCase())
    .filter(Boolean);

  if (keys.length === 0) return undefined;

  // Word-bounded so `DATA-12` does not match inside `METADATA-12`, and anchored on the
  // configured projects so an unrelated `JIRA-1` in prose is not mistaken for a ticket.
  const pattern = new RegExp(`\\b(${keys.join("|")})-(\\d+)\\b`, "i");

  for (const source of [branch, subject]) {
    const found = source ? pattern.exec(source) : undefined;
    if (found) return `${found[1]!.toUpperCase()}-${found[2]}`;
  }

  return undefined;
}

async function commentJira(
  settings: Record<string, string>,
  secrets: Record<string, string | undefined>,
  summary: ChangeSummary,
): Promise<ProviderResult> {
  const key = ticketKey(settings.projectKeys, summary.branch, summary.subject);
  if (!key) {
    return {
      ok: true,
      message: "No ticket key in the branch name or commit subject, so nothing to comment on.",
      detail: "Name branches like `DATA-1234-add-customer-email` to link changes to tickets.",
    };
  }

  const api = `${trimTrailingSlashes(settings.baseUrl ?? "")}/rest/api/3/issue/${key}/comment`;
  const authorization = `Basic ${Buffer.from(`${settings.email}:${secrets.token}`).toString("base64")}`;

  // Atlassian Document Format, which is what the v3 API accepts. Plain strings are rejected.
  const text = [summarySentence(summary), summary.subject ? `\n${summary.subject}` : ""].join("");
  const payload = {
    body: {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
  };

  const response = await safeFetch(api, {
    method: "POST",
    headers: { authorization, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message:
        response.status === 404
          ? `No issue ${key}, or the account cannot see it.`
          : `Jira returned ${response.status} ${response.statusText}.`,
    };
  }

  return {
    ok: true,
    status: response.status,
    message: `Commented on ${key}.`,
    preview: JSON.stringify(payload),
  };
}

// ---------------------------------------------------------------- github

async function commentGithub(
  context: DispatchContext,
  settings: Record<string, string>,
  secrets: Record<string, string | undefined>,
  summary: ChangeSummary,
): Promise<ProviderResult> {
  if (!summary.pullRequest) {
    return {
      ok: true,
      message: "No pull request associated with this change, so there is nowhere to comment.",
    };
  }

  const remote = parseRemote(context.workspace);
  if (!remote) {
    return { ok: false, message: "The workspace has no GitHub remote to comment on." };
  }

  const host = settings.host?.trim() || remote.host;
  const api = host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  const url = `${api}/repos/${remote.owner}/${remote.repo}/issues/${summary.pullRequest}/comments`;

  const body = markdownReview(summary);

  const response = await safeFetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secrets.token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ body }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      message: `GitHub returned ${response.status} ${response.statusText}.`,
      ...(text ? { detail: text.slice(0, 300) } : {}),
    };
  }

  return {
    ok: true,
    status: response.status,
    message: `Posted the model review on #${summary.pullRequest}.`,
    preview: body,
  };
}

function parseRemote(
  workspace: LoadedWorkspace,
): { owner: string; repo: string; host: string } | undefined {
  // Kept local rather than imported from git.ts so the dispatcher does not need a shell call
  // just to learn the remote; the config already records it where one is configured.
  const url = (workspace.config as { remote?: string }).remote;
  if (!url) return undefined;

  const ssh = /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (ssh) return { host: ssh[1]!, owner: ssh[2]!, repo: ssh[3]! };

  const https = /^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  if (https) return { host: https[1]!, owner: https[2]!, repo: https[3]! };

  return undefined;
}

/**
 * The pull request comment.
 *
 * Markdown rather than the Slack text, because the audience is different: a reviewer is deciding
 * whether to approve, so the migration and the governance verdict matter more than the headline.
 */
export function markdownReview(summary: ChangeSummary): string {
  const lines: string[] = ["## Model review", "", summarySentence(summary), ""];

  if (summary.objects.length > 0) {
    lines.push("| | Object | Kind | Model |", "|---|---|---|---|");
    for (const object of summary.objects.slice(0, 25)) {
      lines.push(`| ${symbol(object.change)} | \`${object.name}\` | ${object.kind} | ${object.model ?? "-"} |`);
    }
    if (summary.objects.length > 25) lines.push(`| | …and ${summary.objects.length - 25} more | | |`);
    lines.push("");
  }

  /*
    The diagram goes above the consequences, not below.

    A reviewer who does not model for a living needs to see the shape before they can judge the
    impact, and GitHub collapses nothing by default, so ordering is the only control over what
    gets read first.
  */
  if (summary.erd) {
    lines.push("### Shape", "", "```mermaid", summary.erd, "```", "");
  }

  const breaks = summary.downstream.filter((entry) => entry.severity === "breaks");
  const rewrites = summary.downstream.filter((entry) => entry.severity === "rewrites");

  if (breaks.length > 0 || rewrites.length > 0) {
    lines.push("### Downstream impact", "");
    for (const entry of [...breaks, ...rewrites].slice(0, 20)) {
      const marker = entry.severity === "breaks" ? "**breaks**" : "rewrites";
      lines.push(`- ${marker} \`${entry.dependent}\`, ${entry.reason}`);
    }
    lines.push("");
  }

  if (summary.migration.length > 0) {
    lines.push("### Migration", "");
    for (const entry of summary.migration) {
      lines.push(
        entry.requiresRecreate
          ? `**\`${entry.table}\` cannot be altered in place, it must be rebuilt.**`
          : `\`${entry.table}\`:`,
        "",
        "```sql",
        ...entry.statements,
        "```",
        "",
      );
    }
  } else if (summary.objects.length > 0) {
    lines.push("### Migration", "", "No schema migration required.", "");
  }

  if (summary.governance.length > 0) {
    lines.push("### Governance", "", "| Model | Classified | Needs a decision |", "|---|---|---|");
    for (const entry of summary.governance) {
      const share = Math.round((entry.classified / entry.total) * 100);
      /*
        `unrecognised` is the second column rather than the raw unclassified count, because it is
        the only number that is actionable. Everything the classifier can already guess is not
        work; what nothing recognises is.
      */
      lines.push(
        `| \`${entry.model}\` | ${entry.classified} / ${entry.total} (${share}%) | ${entry.unrecognised} |`,
      );
    }
    lines.push("");
  }

  if (summary.errors.length > 0) {
    lines.push("### Validation", "");
    for (const error of summary.errors.slice(0, 20)) {
      lines.push(`- \`${error.code}\` ${error.message}${error.file ? ` (\`${error.file}\`)` : ""}`);
    }
    lines.push("");
  }

  lines.push("<sub>Posted by strata.</sub>");

  /*
    GitHub refuses a comment body over 65536 characters with a 422, which would turn a large but
    perfectly ordinary merge into a failed delivery. Truncating is the better failure: the top of
    this document is ordered most-useful-first, so what survives is the part worth reading.
  */
  const body = lines.join("\n");
  if (body.length <= COMMENT_LIMIT) return body;

  const notice = "\n\n…truncated. Open the model in strata for the rest.\n\n<sub>Posted by strata.</sub>";
  return body.slice(0, COMMENT_LIMIT - notice.length) + notice;
}
