/**
 * Resolving the credentials the outbound features run on, per request.
 *
 * One rule governs all of these and it is written out at length below: with a tenant in
 * context the environment is not consulted at all. The precedence used to run the other way,
 * which meant every tenant of a multi-tenant deployment silently spent the operator's model
 * key and introspected the operator's GCP project, working perfectly and billing somebody else.
 */
import express from "express";
import { type GcpAuth } from "./bigquery.js";
import { type Completion } from "./skills.js";
import { type CloudRequest } from "./guards.js";
import { secrets } from "./services.js";
import { currentTenant } from "./tenancy.js";

/**
 * An operator-supplied credential from the environment, or nothing when a tenant is in context.
 *
 * **The precedence was backwards for multi-tenancy, and silently so.** `STRATA_SKILLS_API_KEY`
 * and `STRATA_GCP_ACCESS_TOKEN` were read before the secret store, which is right for
 * self-hosting: one operator, one instance, one set of credentials, and an environment variable
 * is how a secret manager presents itself. Put the same code in front of several tenants and it
 * means every one of them silently spends the *operator's* model key and introspects the
 * operator's GCP project. Nobody would see it happen; the feature would simply work, on somebody
 * else's credential and somebody else's bill.
 *
 * So the environment is consulted only when there is no tenant. With one, the tenant's own
 * encrypted store is the only source there is, and a tenant who has configured nothing gets the
 * feature reported as unconfigured rather than quietly borrowing.
 *
 * `currentTenant()` rather than a parameter, for the reason `tenancy.ts` gives at length: a
 * value threaded through call sites has exactly one failure mode, and it is a silent one.
 */
export function operatorEnv(name: string): string | undefined {
  if (currentTenant()) return undefined;
  return process.env[name]?.trim() || undefined;
}

/**
 * The GitHub token to act with, for this caller.
 *
 * **In hosted mode the right credential is the caller's own, and it was never reached.** A cloud
 * session already carries the OAuth token that cloned the repository, but every git operation
 * resolved its token from the secret store instead, which for a tenant is empty and for the
 * instance is the operator's. So Propose in the managed cloud had no usable credential at all:
 * the push failed, and the one thing the product exists to do did not happen.
 *
 * Preferring the session token is also the only way the permission is *real*. A token minted for
 * this person is refused by GitHub for a repository they may only read, so a viewer cannot push
 * no matter what this process believes about their role. Falling back to an operator token would
 * do the opposite, quietly lending write access to somebody who was never granted it.
 *
 * Self-hosting is unchanged: no cloud session, so this is `secrets().githubToken()` exactly as
 * before, including its file and environment precedence.
 */
export async function githubTokenFor(req: express.Request): Promise<string | undefined> {
  const session = (req as CloudRequest).cloud;
  if (session?.token) return session.token;
  return secrets().githubToken();
}

/**
 * How agent skills reach a language model, or `undefined` when the operator has not said.
 *
 * Resolved per run rather than captured at boot so a key added to the secret store takes effect
 * without a restart. Returning `undefined` is a first-class outcome: agent skills then report
 * themselves *skipped*, which is the honest answer, a governance control that reported success
 * because nothing ran would be a green tick nobody earned.
 *
 * Anthropic's API shape, because that is the model family this tool is developed against. The
 * key is never logged and never sent to the browser.
 */
export async function agentCompletion(): Promise<Completion | undefined> {
  const key = operatorEnv("STRATA_SKILLS_API_KEY") || (await secrets().get("skills.apiKey"));
  if (!key) return undefined;

  const model = process.env.STRATA_SKILLS_MODEL?.trim() || "claude-sonnet-5";

  return async ({ prompt, context }) => {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        /*
          The output contract is stated here rather than left to each skill author.

          One finding per line beats JSON for an advisory control: a model that produces slightly
          malformed JSON yields nothing at all, whereas slightly malformed lines still yield most
          of the findings.
        */
        system:
          "You are reviewing a data model. Report each problem on its own line as " +
          "`OBJECT: what is wrong`. Reply with exactly `OK` if you find nothing. " +
          "Do not add preamble, headings or commentary.",
        messages: [{ role: "user", content: `${prompt}\n\n--- MODEL ---\n${context}` }],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new Error(`the model provider returned ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as { content?: { type: string; text?: string }[] };
    return (body.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
  };
}

/**
 * Google Cloud credentials, or `undefined` when the operator has not supplied any.
 *
 * Resolved per request rather than captured at boot, so a key added to the secret store takes
 * effect without a restart. Two forms, and the order is deliberate:
 *
 *   1. `STRATA_GCP_ACCESS_TOKEN`, a short-lived token, typically from
 *      `gcloud auth print-access-token`. The easiest thing to try, and it expires on its own.
 *   2. A service account JSON key in the secret store under `gcp.serviceAccount`, encrypted at
 *      rest like every other credential. Signed locally into a JWT; the key never leaves this
 *      process except as a signature.
 *
 * Returning `undefined` is a first-class outcome, not an error: the routes then say plainly that
 * no credentials are configured, which is far more useful than a 401 from Google.
 */
export async function gcpAuth(): Promise<GcpAuth | undefined> {
  const token = operatorEnv("STRATA_GCP_ACCESS_TOKEN");
  if (token) return { kind: "token", token };

  const raw = await secrets().get("gcp.serviceAccount");
  if (!raw) return undefined;

  try {
    const key = JSON.parse(raw) as {
      client_email?: string;
      private_key?: string;
      token_uri?: string;
    };
    if (!key.client_email || !key.private_key) return undefined;

    return {
      kind: "serviceAccount",
      clientEmail: key.client_email,
      privateKey: key.private_key,
      /*
        The key file names its own token endpoint, and it is honoured.

        Standard in every service account key Google issues, and it is not decoration: keys minted
        for a non-public partition, or an instance behind VPC Service Controls, carry a different
        one. Ignoring it silently sends the assertion to the public endpoint, which then rejects
        it, with an error about the credentials rather than about the endpoint.
      */
      ...(key.token_uri ? { tokenUri: key.token_uri } : {}),
    };
  } catch {
    /*
      A malformed key is treated as absent rather than thrown.

      The operator pasted something that is not the JSON key file, and the routes' "no credentials
      configured" message plus its hint is a better explanation than a JSON parse error.
    */
    return undefined;
  }
}
