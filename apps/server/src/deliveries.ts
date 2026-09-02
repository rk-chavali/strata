import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IntegrationEvent } from "./integrations.js";

/**
 * What each integration actually did, and when.
 *
 * The half of the feature that makes it trustworthy. An integration you cannot audit is one you
 * disable the first time you suspect it: without a record, "did the wiki update on Tuesday's
 * merge?" is unanswerable, and the honest answer to an unanswerable question is to stop relying
 * on it. So every attempt is recorded, the successes as much as the failures, because a log that
 * only contains failures cannot distinguish "working" from "never ran".
 *
 * Deliberately a file, not a database. strata's whole premise is that its state is inspectable, and
 * a JSONL file someone can `tail` fits that better than a table they need a client for. It lives
 * in the data directory rather than the repo because it is instance state, not model state, two
 * strata instances against the same repo have different delivery histories, and committing one
 * would produce a merge conflict on every merge.
 */

export interface Delivery {
  id: string;
  provider: string;
  event: IntegrationEvent;
  /** ISO 8601. */
  at: string;
  ok: boolean;
  /** The HTTP status, when the attempt got far enough to have one. */
  status?: number;
  /** One sentence an operator can act on. */
  message: string;
  detail?: string;
  durationMs: number;
  /** The change the delivery described, as a sentence. */
  summary?: string;
  sha?: string;
  shortSha?: string;
  /**
   * A truncated preview of what was sent.
   *
   * Truncated rather than complete because a Confluence body is the entire data dictionary, and
   * a log that grows by a megabyte per merge is one that gets deleted.
   */
  preview?: string;
}

/** How many attempts are kept. Older ones are dropped on write. */
const MAX_ENTRIES = 200;

/** How much of a payload is retained for the preview. */
const PREVIEW_LIMIT = 2000;

export class DeliveryLog {
  constructor(private readonly dataDir: string) {}

  private get file(): string {
    return join(this.dataDir, "deliveries.jsonl");
  }

  /**
   * Every recorded attempt, newest first.
   *
   * A malformed line is skipped rather than fatal. This file is append-only and could be
   * truncated mid-write by a crash or a full disk; losing the last line is acceptable, and
   * refusing to show any history because of it is not.
   */
  async list(limit = MAX_ENTRIES): Promise<Delivery[]> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      // No deliveries yet. An empty history is an ordinary state, not an error.
      return [];
    }

    const entries: Delivery[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as Delivery);
      } catch {
        continue;
      }
    }

    return entries.reverse().slice(0, limit);
  }

  /** Record one attempt. */
  async record(delivery: Omit<Delivery, "id" | "at"> & { at?: string }): Promise<Delivery> {
    const entry: Delivery = {
      ...delivery,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: delivery.at ?? new Date().toISOString(),
      ...(delivery.preview ? { preview: truncate(delivery.preview) } : {}),
    };

    /*
      Read, append, rewrite, rather than appending in place.

      An append would be cheaper, but the file has to be capped somewhere or it grows without
      limit, and capping requires a rewrite anyway. At 200 entries the whole file is a few
      hundred kilobytes and this happens once per merge, so the simpler code wins.
    */
    const existing = (await this.list(MAX_ENTRIES)).reverse();
    const kept = [...existing, entry].slice(-MAX_ENTRIES);

    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.file, kept.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");

    return entry;
  }

  /**
   * The most recent attempt per provider.
   *
   * What the integrations page leads with: "last delivered 3 hours ago" is the one fact that
   * distinguishes a configured integration from a working one.
   */
  async latestByProvider(): Promise<Record<string, Delivery>> {
    const latest: Record<string, Delivery> = {};
    // `list` is newest first, so the first sighting of a provider is its most recent attempt.
    for (const delivery of await this.list()) {
      if (!latest[delivery.provider]) latest[delivery.provider] = delivery;
    }
    return latest;
  }
}

function truncate(value: string): string {
  return value.length <= PREVIEW_LIMIT ? value : `${value.slice(0, PREVIEW_LIMIT)}\n… truncated`;
}
