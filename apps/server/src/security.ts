import type { RequestHandler } from "express";
import type { CorsOptions } from "cors";
import { trimTrailingSlashes } from "./ssrf.js";

/**
 * Response headers and cross-origin policy.
 *
 * **Same-origin by default.** The previous configuration reflected any `Origin` and allowed
 * credentials. That was largely defused by the session cookie being `SameSite=Lax`, so the cookie
 * is not attached to a cross-site request in the first place. But it was a hole waiting for a
 * future change to open: the day anyone adds a token-in-header scheme for the API, reflecting
 * every origin becomes full cross-origin access with credentials. A self-hosted app that serves
 * its own UI from its own origin has no reason to allow any of it, so the default is now nothing,
 * and `STRATA_ALLOWED_ORIGINS` is the explicit, reviewable way to add one.
 *
 * **A content security policy, because this UI renders attacker-supplied content.** Column names,
 * table descriptions and glossary definitions all arrive by pull request and all get rendered.
 * The generated HTML already escapes them, deliberately and with the reasoning recorded. A policy
 * is the second layer: it is the difference between a missed escape being an incident and being
 * a nuisance.
 */

/**
 * Origins permitted to call the API cross-site.
 *
 * Empty by default. The UI is served from the same origin as the API, so the browser never sends
 * an `Origin` the API has to permit. The list exists for the deployment that genuinely splits
 * them, and for local development where Vite serves on 5173 and the API on 4000.
 */
export function allowedOrigins(): string[] {
  const raw = process.env.STRATA_ALLOWED_ORIGINS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((origin) => trimTrailingSlashes(origin.trim()))
    .filter(Boolean);
}

export function corsOptions(origins = allowedOrigins()): CorsOptions {
  return {
    credentials: true,
    origin(requestOrigin, callback) {
      /*
        No `Origin` header means same-origin, or a non-browser client such as curl or the CLI.
        Both are permitted: this is not authentication, and refusing them would break the CLI
        without stopping anything.
      */
      if (!requestOrigin) {
        callback(null, true);
        return;
      }

      // The `Origin` header is attacker-controlled, so this one is the reason the helper exists.
      const normalised = trimTrailingSlashes(requestOrigin);
      if (origins.includes(normalised)) {
        callback(null, true);
        return;
      }

      /*
        Refuse by omitting the header rather than raising.

        An error here becomes a 500 with a stack trace, which reads as "the server is broken"
        when the correct message is "this origin is not on the list". Omitting the header lets
        the browser produce its own, accurate, CORS error.
      */
      callback(null, false);
    },
  };
}

/**
 * Security headers on every response.
 *
 * Written by hand rather than pulling in helmet. The server has two runtime dependencies and that
 * is a genuine strength worth keeping; this is nine headers, and writing them here means the
 * policy is readable in one place instead of assembled from defaults somebody has to look up.
 */
export function securityHeaders(): RequestHandler {
  const csp = contentSecurityPolicy();

  return (_req, res, next) => {
    res.setHeader("Content-Security-Policy", csp);

    // Stop the browser guessing a content type. A YAML file served as text must not be sniffed
    // into something executable.
    res.setHeader("X-Content-Type-Options", "nosniff");

    // Clickjacking. `frame-ancestors` in the policy above is the modern control; this is the
    // fallback for anything that does not honour it.
    res.setHeader("X-Frame-Options", "DENY");

    // Do not leak the workspace path or an object id in the Referer when someone clicks an
    // external link out of a description field.
    res.setHeader("Referrer-Policy", "no-referrer");

    // Nothing here needs a camera, a microphone or a location.
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    );

    // Only meaningful over HTTPS, and only set when the operator has said they terminate TLS,
    // because sending it over plain http on localhost would pin a developer's browser to https
    // for the whole origin.
    if (process.env.STRATA_COOKIE_SECURE === "true") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }

    next();
  };
}

/**
 * The policy itself.
 *
 * `'unsafe-inline'` on styles is a genuine concession rather than an oversight: the ERD canvas
 * positions every node with an inline `style` attribute, and there are hundreds of them changing
 * on every drag. Nonce-ing those is not practical, and style injection is a far smaller prize
 * than script injection, which is not permitted at all.
 *
 * `img-src` admits `data:` and `blob:` because diagram export renders to a data URI before it is
 * offered as a download.
 */
function contentSecurityPolicy(): string {
  const extra = process.env.STRATA_CSP_CONNECT_SRC?.trim();

  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    /*
      `connect-src` covers the server-sent events stream the UI holds open for presence and live
      updates. Extended by configuration for the deployment that puts the API on another origin,
      which is the same deployment that needs STRATA_ALLOWED_ORIGINS.
    */
    `connect-src 'self'${extra ? ` ${extra}` : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
