/**
 * Who may call a route, and whether the deployment offers it at all.
 *
 * Two independent gates, deliberately kept together because the order between them is the
 * whole design: the deployment gate runs in front of the role gate, so no amount of privilege
 * inside the app can re-enable a capability the host operator switched off. The long comments
 * below record why, and each one is anchored to a defect that shipped.
 */
import express from "express";
import { requireRole, type AuthedRequest, type GuardHandler } from "./auth.js";
import { type AuditAction } from "./audit.js";
import type { CloudSession } from "./cloud.js";
import { FEATURES, NO_FEATURES, TENANT_DIR, type FeatureSet } from "./env.js";
import { audit, auth } from "./services.js";

/**
 * Which features this *caller* gets, as opposed to which the deployment permits.
 *
 * `FEATURES` answers a deployment-wide question and was the only answer there was, which is
 * wrong the moment one process serves more than one person. The hosted product and the anonymous
 * trial run the same image, so a signed-in customer who opened their own private repository was
 * handed the same locked-down feature set as a stranger who had proved nothing. That is why
 * integrations, skills and BigQuery were invisible in the managed cloud: not a bug in the
 * integrations, a deployment flag doing a job it cannot do.
 *
 * The split is by what the caller has proved, not by what they clicked:
 *
 * **Single-tenant is untouched.** No tenant directory means self-hosting, where the operator and
 * the user are the same organisation and `STRATA_FEATURES` is the whole answer. This is the
 * deployment most people run and its behaviour does not change at all.
 *
 * **Anonymous in a multi-tenant deployment gets nothing**, whatever the environment says. This is
 * deliberately not merely a default. Integrations let whoever configures them make the server
 * fetch a URL of their choosing, and on a public trial that is every stranger on the internet
 * pointed at the host's own network, where the metadata endpoint hands out the node's
 * credentials to anything that can reach it. Until now the only thing standing between a trial
 * visitor and that was an operator remembering to set `STRATA_FEATURES=""` on the right service,
 * a single env var whose failure is silent and which had already been got wrong in production.
 * Making it structural means a misconfigured trial is still a safe trial.
 *
 * **An authenticated caller gets the deployment's list.** `STRATA_FEATURES` stays a ceiling that
 * nothing here raises, so an operator who genuinely wants BigQuery off everywhere still gets it
 * off everywhere. What changes is that proving who you are is now what lifts you off the floor.
 */
export function featuresFor(req: express.Request): FeatureSet {
  if (!TENANT_DIR) return FEATURES;

  // A repository in the session means GitHub confirmed this person's access to it.
  if ((req as CloudRequest).cloud?.repo) return FEATURES;

  /*
    A local account, for a multi-tenant deployment that runs its own sign-in. `auth.disabled` is
    checked because with auth off `req.user` is a stand-in for "nobody signed in", which is the
    trial, and treating that as authenticated would hand the floor away to exactly the caller it
    exists to contain.
  */
  if (!auth.disabled && (req as AuthedRequest).user) return FEATURES;

  return NO_FEATURES;
}

export interface CloudRequest extends express.Request {
  cloud?: CloudSession | undefined;
}

export const readers = requireRole(auth, "viewer");
export const editors = requireRole(auth, "editor");
export const admins = requireRole(auth, "admin");

/**
 * Refuse a route whose feature this deployment does not permit.
 *
 * **This is the half that was missing.** `FEATURES` was parsed at boot and used in exactly one
 * place: filling in the capability map on `/api/workspace`. So the UI faithfully reported
 * integrations as unavailable while every integration route continued to serve requests. A
 * deployment that set `STRATA_FEATURES=skills` to keep a trial visitor from pointing the server at
 * an arbitrary URL got the label and none of the protection.
 *
 * **Distinct from a role, and from config an admin can flip.** An admin toggle is a preference
 * inside one instance. This is the operator of the *host* saying a capability is not available
 * here at all, and no amount of privilege inside the app should re-enable it. That is why the
 * check is by deployment and why it sits in front of the role guard.
 *
 * **404 rather than 403.** A 403 says "this exists and you may not have it", which invites
 * somebody to go looking for the permission. A feature that is off for the deployment does not
 * exist for that deployment, and saying so is both more honest and less interesting.
 */
export function requireFeature(name: keyof FeatureSet): GuardHandler {
  const guard: GuardHandler = (req, res, next) => {
    /*
      Resolved inside the guard, per request, rather than captured when the route is built.

      Capturing would reintroduce exactly the bug this file already learned once: a value read at
      import time, before any request exists to have a caller, that then answers for everybody.
      `featuresFor` is cheap, so there is nothing to gain by hoisting it and a silent
      authorization error to lose.
    */
    if (featuresFor(req)[name]) {
      next();
      return;
    }
    res.status(404).json({
      error: `the \`${name}\` feature is not enabled on this deployment`,
      feature: name,
    });
  };

  // Read by the route audit, so a new integrations route without a gate fails the suite.
  guard.strataFeature = name;
  return guard;
}

export const integrationsOn = requireFeature("integrations");
export const skillsOn = requireFeature("skills");
export const bigqueryOn = requireFeature("bigquery");

/**
 * Record a privileged action.
 *
 * **Awaited, not fired and forgotten.** The first version did not await, on the reasoning that an
 * audit write must never turn a successful password change into an error. That reasoning is
 * sound and is already handled one level down: `AuditLog.record` swallows its own failures and
 * reports them to stderr. What not awaiting actually bought was a race, where an action could be
 * visible in its own response before it was visible in the log.
 *
 * For a log whose entire job is answering "who did this, and when", an entry that may or may not
 * have landed yet is not much of an answer. A file append on the handful of privileged routes
 * costs well under a millisecond, and these are not the hot path.
 */
export async function recordAudit(
  req: AuthedRequest,
  action: AuditAction,
  fields: { target?: string; ok?: boolean; detail?: string } = {},
): Promise<void> {
  await audit().record({
    action,
    ok: fields.ok ?? true,
    ...(fields.target ? { target: fields.target } : {}),
    ...(fields.detail ? { detail: fields.detail } : {}),
    ...(req.user
      ? { actor: { id: req.user.id, username: req.user.username, role: req.user.role } }
      : {}),
    ...(req.context?.id ? { requestId: req.context.id } : {}),
    ...(req.ip ? { ip: req.ip } : {}),
  });
}
