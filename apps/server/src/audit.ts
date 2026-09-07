import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Role } from "./auth.js";

/**
 * Who did the privileged things, and when.
 *
 * Distinct from the delivery log, which records what integrations sent, and distinct from
 * `git log`, which records what happened to the *model*. This records what happened to the
 * *instance*: who disabled a governance rule, who rotated a credential, who promoted somebody to
 * administrator, who turned the merge watcher off.
 *
 * **Why it is worth its own file.** Model changes are already auditable, and beautifully so, by
 * the design of the whole product. Instance changes are not auditable at all: an admin who
 * disables a blocking skill leaves no trace anywhere, and the next pull request merges without
 * the control that everybody believes is running. That silence is the gap this closes.
 *
 * **Append-only, JSONL, in the data directory.** The same reasoning as the delivery log: a file
 * an operator can `tail` beats a table they need a client for, and instance state does not belong
 * in the model repo. Append rather than rewrite, so a crash mid-write costs the last line rather
 * than the file.
 *
 * **Deliberately not tamper-proof.** An administrator with shell access on the container can edit
 * this file, and pretending otherwise would be theatre. It answers "what changed and who changed
 * it" for an honest operator and for an incident review. Real tamper resistance means shipping
 * the lines off the box, which is the operator's own logging pipeline's job, and the structured
 * log line this also emits is what that pipeline consumes.
 */

/**
 * The actions worth recording.
 *
 * A closed set rather than a free string, so a reader can filter without guessing at spellings
 * and so adding a new privileged route is a deliberate decision to record it.
 */
export type AuditAction =
  | "user.create"
  | "user.update"
  | "user.delete"
  | "user.role"
  | "auth.setup"
  | "auth.login"
  | "auth.login.failed"
  // An invitation creates an account without an administrator present at the moment it happens,
  // so the record of who issued it and what it became is the only trail there is.
  | "auth.invite.created"
  | "auth.invite.revoked"
  | "auth.invite.redeemed"
  | "secret.set"
  | "secret.clear"
  | "integration.save"
  | "integration.delete"
  | "integration.test"
  | "skill.save"
  | "skill.delete"
  | "settings.update"
  | "layout.apply"
  | "workspace.init"
  | "git.remote"
  | "git.discard"
  | "bigquery.apply"
  /* Reverse engineering writes objects into the repo from a live warehouse, so who pointed it
     at which dataset is worth the same record as who applied a taxonomy. */
  | "import.bigquery";

export interface AuditEntry {
  at: string;
  action: AuditAction;
  /** Who did it. Absent when authentication is disabled for the deployment. */
  actor?: { id: string; username: string; role: Role };
  /** What it was done to: a username, a provider id, a skill name, a setting key. */
  target?: string;
  /** Whether the action succeeded. A refused attempt is worth recording too. */
  ok: boolean;
  /** One short sentence. Never a secret value, and never a password. */
  detail?: string;
  /** Correlation id, matching the request log line for the same request. */
  requestId?: string;
  /** Source address, as recorded by the request logger. */
  ip?: string;
}

/** How many entries `list` reads back. The file itself is never truncated. */
const READ_LIMIT = 500;

export class AuditLog {
  constructor(private readonly dataDir: string) {}

  private get file(): string {
    return join(this.dataDir, "audit.jsonl");
  }

  /**
   * Record one action.
   *
   * Never throws. An audit write that fails must not turn a successful password change into a
   * 500 for the user who made it, and a governance record is not worth breaking the thing it
   * records. The failure goes to stderr, where the operator's log pipeline sees it.
   */
  async record(entry: Omit<AuditEntry, "at">): Promise<void> {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    try {
      await mkdir(this.dataDir, { recursive: true });
      await appendFile(this.file, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      process.stderr.write(
        `audit write failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  /**
   * Recent entries, newest first.
   *
   * A malformed line is skipped rather than fatal, for the same reason as the delivery log: the
   * file is append-only and a crash can truncate the last line. Refusing to show any history
   * because of one bad line would be the wrong trade.
   */
  async list(limit = READ_LIMIT, filter?: { action?: AuditAction; actor?: string }): Promise<AuditEntry[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return [];
    }

    const entries: AuditEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as AuditEntry;
        if (filter?.action && parsed.action !== filter.action) continue;
        if (filter?.actor && parsed.actor?.username !== filter.actor) continue;
        entries.push(parsed);
      } catch {
        continue;
      }
    }

    return entries.reverse().slice(0, limit);
  }
}
