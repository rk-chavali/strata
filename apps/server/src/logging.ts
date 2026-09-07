import { randomBytes } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Structured logs, correlation ids, and an error handler that does not leak.
 *
 * Two problems this closes, and they are the same problem seen from opposite ends.
 *
 * **The operator could not see failures.** The route wrapper caught everything unmapped, returned
 * the message to the browser and logged nothing at all. So a 500 in production left no trace, and
 * "propose failed last Tuesday" was unanswerable. For a tool whose entire pitch is that its
 * history is inspectable, having no record of its own failures was the wrong shape.
 *
 * **The browser could see too much.** A raw `Error.message` from Node carries absolute paths
 * (`ENOENT ... open '/workspace/models/...'`), and from `fetch` it carries the URL that was
 * attempted. On the integration routes that message is the response oracle that turns a blind
 * request into a readable one. So the client now gets a flat sentence plus a request id, and the
 * detail goes to the log where it belongs.
 *
 * **One line per request, JSON, on stdout.** Not a logging framework: a container's log is a
 * stream of lines, every platform collects stdout, and JSON is what a collector can index. Adding
 * a dependency to produce lines this shape would be a poor trade for a server with two runtime
 * dependencies.
 */

export interface LogFields {
  [key: string]: unknown;
}

/** Whether to emit a line per completed request. Noisy on a busy instance, so it is opt-in. */
const REQUEST_LOG = process.env.STRATA_LOG_REQUESTS === "true";

/**
 * Emit one structured line.
 *
 * `console` is deliberately avoided: it formats objects for humans and can interleave partial
 * writes under load. One `write` of one string is atomic enough for line-oriented collection.
 */
export function log(level: "info" | "warn" | "error", message: string, fields: LogFields = {}): void {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    level,
    message,
    ...redact(fields),
  });
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

/**
 * Keys whose values never belong in a log line.
 *
 * A denylist rather than an allowlist because the fields passed here are written by hand at each
 * call site, so the risk is a new call site forgetting rather than an unbounded object arriving
 * from outside. The check is on the key name, and it is case-insensitive and substring-based so
 * `githubToken`, `apiKey` and `session_secret` all match.
 */
const SECRET_KEYS = ["password", "token", "secret", "apikey", "api_key", "authorization", "cookie"];

function redact(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    const lower = key.toLowerCase().replace(/[^a-z]/g, "");
    out[key] = SECRET_KEYS.some((secret) => lower.includes(secret.replace(/[^a-z]/g, "")))
      ? "[redacted]"
      : value;
  }
  return out;
}

export interface RequestContext {
  id: string;
  startedAt: number;
}

/**
 * A request carrying its correlation id.
 *
 * An explicit interface rather than a `declare module` augmentation of Express. The augmentation
 * only resolves when the exact `@types/express-serve-static-core` version is present at the path
 * TypeScript expects, which makes the build depend on a transitive type package staying where it
 * is. `AuthedRequest` already extends `Request` the same way for `user`, so this matches how the
 * codebase already does it.
 */
export interface ContextualRequest extends Request {
  context?: RequestContext;
}

/**
 * Give every request an id, and log the ones worth logging.
 *
 * The id goes into the response header as well as the log line, so a user reporting a failure can
 * read the id off the error the UI shows them and an operator can find the exact line. That turns
 * "it broke sometime this morning" into one `grep`.
 */
export function requestLogger(): RequestHandler {
  return (req: ContextualRequest, res: Response, next: NextFunction) => {
    const context: RequestContext = { id: randomBytes(8).toString("hex"), startedAt: Date.now() };
    req.context = context;
    res.setHeader("x-request-id", context.id);

    res.on("finish", () => {
      /*
        Always log a failure; log a success only when asked.

        A healthy instance serving a canvas produces hundreds of 200s a minute and none of them
        are interesting. A 4xx or 5xx always is, and logging those unconditionally means the
        default configuration still answers "what went wrong" without an operator having turned
        anything on first.
      */
      const failed = res.statusCode >= 400;
      if (!failed && !REQUEST_LOG) return;

      log(failed ? "warn" : "info", "request", {
        requestId: context.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - context.startedAt,
      });
    });

    next();
  };
}

/**
 * The last handler in the chain.
 *
 * Registered because `tenantMiddleware` calls `next(error)` and, without this, that path fell
 * through to Express's built-in handler: an HTML stack trace, or a bare 500, either way a
 * different shape from the JSON every other route returns. A client that parses one error format
 * and receives another shows the user nothing useful.
 */
export function errorHandler(): (
  error: unknown,
  req: ContextualRequest,
  res: Response,
  next: NextFunction,
) => void {
  return (error, req, res, next) => {
    if (res.headersSent) {
      // Too late to change the response. Hand back to Express, which will close the connection.
      next(error);
      return;
    }
    respondWithServerError(error, req, res);
  };
}

/**
 * The shared 500 response.
 *
 * Used by both the route wrapper and the error handler, so the two cannot drift into logging
 * different things or leaking in one path and not the other.
 */
export function respondWithServerError(
  error: unknown,
  req: ContextualRequest,
  res: Response,
): void {
  const requestId = req.context?.id;

  log("error", "unhandled", {
    requestId,
    method: req.method,
    path: req.path,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  res.status(500).json({
    error: "Something went wrong on the server. The details are in the server log.",
    requestId,
  });
}
