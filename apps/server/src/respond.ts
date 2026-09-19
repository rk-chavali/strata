/**
 * The one place a thrown error becomes an HTTP status.
 *
 * Every route body is wrapped in `handler`, so the mapping from a domain error to the code the
 * UI branches on lives here rather than in a hundred try/catch blocks. Anything unmapped is
 * logged in full server-side and summarised for the client, because returning `error.message`
 * to the browser once handed out absolute filesystem paths and attempted URLs.
 */
import express from "express";
import { AuthError, type AuthedRequest } from "./auth.js";
import { CloudError } from "./cloud.js";
import { ConflictError, NotFoundError, ValidationError } from "./edit.js";
import { GitError } from "./git.js";
import { respondWithServerError } from "./logging.js";
import { MailError } from "./mailer.js";
import { BlockedUrlError } from "./ssrf.js";

export function handler(
  fn: (req: AuthedRequest, res: express.Response) => Promise<void>,
): express.RequestHandler {
  return (req, res) => {
    fn(req as AuthedRequest, res).catch((error: unknown) => {
      // Map domain errors onto the status codes the UI branches on, so the user sees
      // "this changed on disk" rather than a generic failure.
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message });
      } else if (error instanceof ConflictError) {
        res.status(409).json({ error: error.message });
      } else if (error instanceof ValidationError) {
        res.status(422).json({ error: error.message, issues: error.issues ?? [] });
      } else if (
        error instanceof AuthError ||
        error instanceof CloudError ||
        error instanceof MailError
      ) {
        res.status(error.status).json({ error: error.message });
      } else if (error instanceof GitError) {
        res.status(400).json({ error: error.message, command: error.command });
      } else if (error instanceof BlockedUrlError) {
        /*
          A refused outbound URL is the operator's mistake to fix, not a server fault, so it is a
          422 with the reason. The message names the host and how to allow it deliberately: the
          alternative is somebody staring at a form that will not save, with no idea that the
          address it resolves to is the problem.
        */
        res.status(422).json({ error: error.message });
      } else {
        /*
          Everything unmapped: logged in full server-side, summarised for the client.

          Returning `error.message` here used to hand the browser absolute filesystem paths from
          `ENOENT`, and the attempted URL from a failed `fetch`. On the integration routes that
          made a blind request into a readable one. The request id in the response is how a user
          and an operator find the same line.
        */
        respondWithServerError(error, req, res);
      }
    });
  };
}
