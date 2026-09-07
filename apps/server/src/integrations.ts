/**
 * Integration providers.
 *
 * The point of a registry rather than four hardcoded features: git is strata's *substrate*, and
 * everything else is a *surface*. Confluence, Jira, Slack and GitHub are all "somewhere the
 * model needs to show up", and treating them as one pluggable shape means adding the fifth is a
 * config entry rather than a new page.
 *
 * Two decisions worth stating, because they were argued rather than assumed.
 *
 * **Every provider is defined by an automation, not a button.** A "publish to Confluence" button
 * is export with extra steps, we already generate self-contained HTML, and a page pasted once
 * rots the next day. What makes an integration worth having is that it fires on an event, so the
 * wiki page is always what `main` says. Each provider therefore declares which `events` it
 * responds to, and a provider that responds to none would not earn its place.
 *
 * **Config splits across two homes on purpose.** Non-secret settings, the Confluence space key,
 * the Jira project, the webhook URL, live in `strata.config.yaml`, so they are versioned and
 * reviewed like the model. Credentials go in the SecretStore, encrypted at rest, and are never
 * returned to the client. Putting the space key in the secret store would hide a reviewable
 * decision; putting the token in the config would commit it.
 */

import { safeFetch } from "./ssrf.js";

/** When a provider can act. */
export type IntegrationEvent =
  /** A pull request was merged into the default branch. */
  | "merged"
  /** A proposal was opened. */
  | "proposed"
  /** Validation found errors on the current branch. */
  | "validationFailed";

export interface ProviderField {
  key: string;
  label: string;
  /** `secret` fields are write-only: stored encrypted, never sent back. */
  type: "text" | "url" | "secret";
  placeholder?: string;
  hint?: string;
  required?: boolean;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  /** One line on what it does, shown on the card, so it must say the automation. */
  summary: string;
  /** The longer why, shown when the provider is expanded. */
  detail: string;
  icon: string;
  fields: ProviderField[];
  events: IntegrationEvent[];
  /**
   * What the provider promises to do. Stated as capability strings rather than inferred from the
   * fields, because two providers with identical config can do different things.
   */
  capabilities: string[];
}

/**
 * The providers.
 *
 * Deliberately four, and deliberately not "link out to X". Each one describes an automation that
 * would otherwise be a human remembering to do something.
 */
export const PROVIDERS: ProviderDefinition[] = [
  {
    id: "webhook",
    name: "Webhook",
    summary: "POST the change summary to any URL when a proposal merges.",
    detail:
      "The most useful integration and the least glamorous. A data team notices a schema change in the channel they already read, not by opening a modelling tool, so this posts what changed, which tables are affected downstream, and whether anything needs a migration. Works with Slack and Teams incoming webhooks as-is, and with anything else that accepts JSON.",
    icon: "flow",
    fields: [
      {
        key: "url",
        label: "Webhook URL",
        type: "secret",
        placeholder: "https://hooks.slack.com/services/…",
        hint: "Treated as a secret: an incoming webhook URL is a credential, anyone holding it can post to the channel.",
        required: true,
      },
      {
        key: "format",
        label: "Payload format",
        type: "text",
        placeholder: "slack",
        hint: "`slack` sends a `text` field Slack and Teams render. `json` sends the raw change summary.",
      },
    ],
    events: ["merged", "validationFailed"],
    capabilities: [
      "Posts a summary of every merged model change",
      "Names the downstream tables the change affects",
      "Flags when a change needs a migration rather than a rebuild",
    ],
  },
  {
    id: "confluence",
    name: "Confluence",
    summary: "Republish the data dictionary as a page every time a proposal merges.",
    detail:
      "Only worth having as an automation. We already export self-contained HTML, so a one-off publish is export with extra steps, and a page pasted into a wiki is out of date the next time anyone merges. Pointed at a page id, this overwrites it on every merge, so the wiki always shows what `main` says. That is the difference between documentation and a snapshot.",
    icon: "doc",
    fields: [
      { key: "baseUrl", label: "Site URL", type: "url", placeholder: "https://acme.atlassian.net/wiki", required: true },
      { key: "email", label: "Atlassian account email", type: "text", placeholder: "you@acme.com", required: true },
      {
        key: "token",
        label: "API token",
        type: "secret",
        hint: "Create one at id.atlassian.com under Security → API tokens. Needs permission to update the target page.",
        required: true,
      },
      { key: "spaceKey", label: "Space key", type: "text", placeholder: "DATA" },
      {
        key: "pageId",
        label: "Page id to overwrite",
        type: "text",
        placeholder: "123456789",
        hint: "The page is replaced, not appended to. Point it at a page nobody edits by hand.",
      },
    ],
    events: ["merged"],
    capabilities: [
      "Overwrites one Confluence page with the current data dictionary on merge",
      "Keeps the wiki in step with the default branch without anyone remembering to",
    ],
  },
  {
    id: "jira",
    name: "Jira",
    summary: "Trace every model change back to the ticket that asked for it.",
    detail:
      "Traceability, not ticketing. A ticket key in the branch name or a commit trailer means `dim_customer` gained a column *because of DATA-1234*, and six months later, when someone asks why the column exists, the answer is one click rather than an archaeology exercise. strata can do this better than a SaaS modelling tool because changes already go through pull requests, so the link is already in the history; this reads it and shows it per object. Creating tickets from warnings is deliberately not included, it is a worse version of copy and paste.",
    icon: "link",
    fields: [
      { key: "baseUrl", label: "Site URL", type: "url", placeholder: "https://acme.atlassian.net", required: true },
      { key: "email", label: "Atlassian account email", type: "text", placeholder: "you@acme.com", required: true },
      { key: "token", label: "API token", type: "secret", required: true },
      {
        key: "projectKeys",
        label: "Project keys",
        type: "text",
        placeholder: "DATA, PLATFORM",
        hint: "Comma separated. Used to recognise a ticket key in a branch name or commit message.",
      },
    ],
    events: ["merged", "proposed"],
    /*
      Only what the dispatcher actually does.

      This list said the provider "shows the ticket that last changed each object, with its
      summary and status". Nothing in the codebase ever reads from Jira; the only call is a
      comment POST. The card is rendered verbatim in the UI, so that string was the product
      promising a feature to the person configuring it. Reading issues back is planned, and the
      line goes back when the code does.
    */
    capabilities: [
      "Recognises a ticket key in a branch name or commit trailer",
      "Comments on the ticket when its change merges",
    ],
  },
  {
    id: "github",
    name: "GitHub",
    summary: "Open pull requests, and post the model review onto them.",
    detail:
      "Partly built already, proposals open pull requests through this token. Configured as a provider it also gains the review comment: the ALTER script a change implies, the downstream impact, and the governance verdict, posted onto the pull request so a reviewer who does not model for a living can read consequences instead of a YAML diff.",
    icon: "pr",
    fields: [
      {
        key: "token",
        label: "Personal access token",
        type: "secret",
        hint: "Needs `repo` scope. Can also be supplied as GITHUB_TOKEN or mounted via STRATA_GITHUB_TOKEN_FILE, which take precedence.",
        required: true,
      },
      { key: "host", label: "Host", type: "text", placeholder: "github.com", hint: "Change for GitHub Enterprise." },
    ],
    events: ["proposed", "merged", "validationFailed"],
    /*
      "Reports the governance verdict as a status" is gone for the same reason as the Jira line
      above: `commentGithub` posts an issue comment and nothing else. No commit status and no
      check run is ever created.
    */
    capabilities: [
      "Opens pull requests from the app",
      "Posts the implied migration and downstream impact as a review comment",
    ],
  },
];

// The non-secret config shape lives in `@strata/storage` as `IntegrationSettingsSchema`, beside the
// rest of `strata.config.yaml`. Declaring it twice would mean two schemas to keep in step, and the
// storage one is the schema that actually parses the file.

export interface IntegrationState {
  provider: ProviderDefinition;
  enabled: boolean;
  /** Non-secret settings, safe to send to the client. */
  settings: Record<string, string>;
  /**
   * Which secret fields have a value, and where it came from. Never the value itself.
   *
   * Sent as presence plus a four-character hint so the UI can say "configured" without ever
   * holding a credential it could leak into a log, a screenshot or a bug report.
   */
  secrets: Record<string, { configured: boolean; hint?: string; source?: "environment" | "stored" }>;
  events: IntegrationEvent[];
}

/** The secret store key for one provider field, e.g. `jira.token`. */
export function secretKey(providerId: string, field: string): string {
  return `${providerId}.${field}`;
}

export function providerById(id: string): ProviderDefinition | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/** Fields a provider stores as secrets. */
export function secretFields(provider: ProviderDefinition): ProviderField[] {
  return provider.fields.filter((field) => field.type === "secret");
}

/**
 * Whether a provider has everything it needs to run.
 *
 * Checked against the *required* fields rather than "any field set", because a half-configured
 * provider that reports itself ready fails at the moment it is needed, which is on a merge,
 * when nobody is watching.
 */
export function isReady(
  provider: ProviderDefinition,
  settings: Record<string, string>,
  secrets: Record<string, { configured: boolean }>,
): boolean {
  return provider.fields
    .filter((field) => field.required)
    .every((field) =>
      field.type === "secret" ? secrets[field.key]?.configured === true : Boolean(settings[field.key]?.trim()),
    );
}

// ---------------------------------------------------------------- connection tests

export interface TestResult {
  ok: boolean;
  /** What happened, in a sentence an operator can act on. */
  message: string;
  /** Extra detail: the account name, the page title, the repo, proof it reached the right place. */
  detail?: string;
}

/**
 * Check a provider's credentials actually work.
 *
 * A read-only call in every case. The test must never create, comment or publish anything: an
 * operator pressing "Test" is asking a question, and a test that posted a message to a channel to
 * prove it could would be a genuinely unpleasant surprise.
 */
export async function testProvider(
  provider: ProviderDefinition,
  settings: Record<string, string>,
  secrets: Record<string, string | undefined>,
): Promise<TestResult> {
  try {
    switch (provider.id) {
      case "confluence":
        return await testAtlassian(settings.baseUrl, settings.email, secrets.token, "/rest/api/space");
      case "jira":
        return await testAtlassian(settings.baseUrl, settings.email, secrets.token, "/rest/api/3/myself");
      case "github":
        return await testGithub(secrets.token, settings.host);
      case "webhook":
        /*
          Deliberately not called.

          The only way to test an incoming webhook is to post to it, and posting to it means
          writing into someone's channel. Validating the shape is the honest limit of what a test
          can do here without side effects.
        */
        return validateWebhook(secrets.url);
      default:
        return { ok: false, message: `\`${provider.id}\` has no connection test.` };
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function testAtlassian(
  baseUrl: string | undefined,
  email: string | undefined,
  token: string | undefined,
  path: string,
): Promise<TestResult> {
  if (!baseUrl || !email || !token) {
    return { ok: false, message: "Site URL, email and API token are all required." };
  }

  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  const response = await safeFetch(url, {
    headers: {
      // Atlassian Cloud uses basic auth with the email and an API token, not a bearer token.
      authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
      accept: "application/json",
    },
  });

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      message: "Atlassian rejected the credentials. Check the email matches the token's account.",
    };
  }
  if (!response.ok) {
    return { ok: false, message: `Atlassian returned ${response.status} ${response.statusText}.` };
  }

  const body = (await response.json()) as { displayName?: string; size?: number };
  return {
    ok: true,
    message: "Connected.",
    ...(body.displayName
      ? { detail: `Authenticated as ${body.displayName}` }
      : typeof body.size === "number"
        ? { detail: `${body.size} space(s) visible` }
        : {}),
  };
}

async function testGithub(token: string | undefined, host: string | undefined): Promise<TestResult> {
  if (!token) return { ok: false, message: "A personal access token is required." };

  const api = !host || host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  const response = await safeFetch(`${api}/user`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });

  if (response.status === 401) return { ok: false, message: "GitHub rejected the token." };
  if (!response.ok) {
    return { ok: false, message: `GitHub returned ${response.status} ${response.statusText}.` };
  }

  const body = (await response.json()) as { login?: string };
  /*
    The scope header is worth surfacing.

    A token that authenticates but lacks `repo` will pass this test and then fail when a pull
    request is opened, which is the worst time to find out.
  */
  const scopes = response.headers.get("x-oauth-scopes") ?? "";
  const hasRepo = scopes.split(/,\s*/).includes("repo");

  return {
    ok: true,
    message: hasRepo ? "Connected." : "Connected, but the token has no `repo` scope, so it cannot open pull requests.",
    ...(body.login ? { detail: `Authenticated as ${body.login}${scopes ? ` · scopes: ${scopes}` : ""}` } : {}),
  };
}

function validateWebhook(url: string | undefined): TestResult {
  if (!url) return { ok: false, message: "A webhook URL is required." };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: "That is not a valid URL." };
  }

  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      message: "Use an https URL, a webhook URL is a credential and would be sent in clear over http.",
    };
  }

  return {
    ok: true,
    message: "The URL looks valid. Not called, because testing a webhook means posting to it.",
    detail: `Will POST to ${parsed.host}${parsed.pathname.replace(/\/[^/]{8,}/g, "/…")}`,
  };
}
