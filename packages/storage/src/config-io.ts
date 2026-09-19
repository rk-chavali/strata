import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument, type Document } from "yaml";
import { CONFIG_FILENAME } from "./config.js";

/**
 * Editing `strata.config.yaml` in place.
 *
 * Uses the YAML document API rather than parse-then-restringify so that comments
 * and formatting survive. A tool that silently strips a team's explanatory
 * comments out of their config is a tool they stop trusting with their files, * and this repo belongs to them, not us.
 */

export async function readConfigDocument(root: string): Promise<Document> {
  const text = await readFile(join(root, CONFIG_FILENAME), "utf8");
  return parseDocument(text);
}

export async function updateConfig(root: string, mutate: (doc: Document) => void): Promise<void> {
  const doc = await readConfigDocument(root);
  mutate(doc);
  await writeFile(join(root, CONFIG_FILENAME), doc.toString({ lineWidth: 0 }), "utf8");
}

/** Persist a new layout preset, preserving everything else in the file. */
export async function setLayoutPreset(root: string, preset: string): Promise<void> {
  await updateConfig(root, (doc) => {
    doc.setIn(["layout", "preset"], preset);
  });
}
