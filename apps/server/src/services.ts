/**
 * The long-lived instances this process owns, and the accessors that resolve them per tenant.
 *
 * Separated from `index.ts` so that route modules can reach the auth store, the credential
 * store and the audit log without importing the file that registers every route. The comments
 * below are the reason the accessors are functions rather than constants, and that distinction
 * has already cost one production defect, so it moved here intact rather than being summarised.
 */
import { AuthStore } from "./auth.js";
import { AuditLog } from "./audit.js";
import { DeliveryLog } from "./deliveries.js";
import { Presence } from "./presence.js";
import { SecretStore } from "./secrets.js";
import { Stores } from "./stores.js";
import { LoginThrottle } from "./throttle.js";
import { AUTH_DISABLED, DATA_DIR } from "./env.js";

export const auth = new AuthStore(DATA_DIR, AUTH_DISABLED);

/**
 * Instance state, resolved per tenant.
 *
 * Called rather than referenced -- `secrets()` not `secrets` -- and that is the point. A module
 * constant is exactly how the credential store came to be shared by every visitor in the hosted
 * mode: one instance, built at import time, before any request exists to have a tenant. Making
 * these functions means the tenant is read at the moment of use, the same way `getWorkspace()`
 * already does it, and there is no way to accidentally capture the wrong one.
 *
 * In single-tenant self-hosting every call returns the same instance against the same directory,
 * so nothing changes for the deployment that most people run.
 */
export const stores = new Stores(DATA_DIR);
export const secrets = (): SecretStore => stores.secrets();
export const presence = (): Presence => stores.presence();
export const deliveries = (): DeliveryLog => stores.deliveries();
export const audit = (): AuditLog => stores.audit();

/** Backoff on the sign-in route. See `throttle.ts` for why it is only on that route. */
export const loginThrottle = new LoginThrottle();
