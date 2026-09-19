/**
 * Generate the JSON Schema for a Strata model file, from the zod schemas themselves.
 *
 * Model files are YAML that a person types by hand, and until now nothing told them what
 * was allowed until `strata check` ran, or worse, until a key was quietly unrecognised.
 * A published JSON Schema moves that feedback into the editor: completion on every field,
 * a red squiggle on a typo, hover documentation, all from the file the modeller is already
 * looking at. It is also the interop story, because a schema is the one artifact another
 * tool can read without depending on Strata at all.
 *
 * Generated rather than written. A hand-maintained copy of an eleven-kind discriminated
 * union would drift from `object.ts` within a release, and a schema that lies is worse than
 * no schema: it red-squiggles fields that are real. `schema.test.ts` fails if the committed
 * file and the zod schemas disagree, so drift is a failing test rather than a bug report.
 *
 * The generator is a devDependency and runs here, never in the server or the CLI. What
 * ships is the JSON file this writes.
 *
 *   pnpm --filter @strata/metamodel schema
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ObjectSchema } from "../src/object.js";

/** Where the schema is published, and what a model file's `$schema` should point at. */
export const SCHEMA_ID = "https://strata-docs.chavali-r.workers.dev/schema/strata.schema.json";

/** Committed here so the repository is the source of truth, and served from `docs/`. */
export const SCHEMA_PATH = join("docs", "schema", "strata.schema.json");

/**
 * Let a model file carry keys this version of the schema does not define.
 *
 * zod strips unknown keys, so the generator correctly emits `additionalProperties: false`
 * on every object. That is true of the zod schema and false of the file format. The loader
 * keeps unrecognised keys precisely so a file written by a newer Strata survives a round
 * trip, and an editor told those keys were invalid would put a red line under a file that
 * is completely correct, on the version of the tool that is behind.
 *
 * The strictness has not gone anywhere. `strata check` still reports an unrecognised key as
 * a warning, which is the right severity for something that is either a typo or the future.
 */
function allowForwardCompatibleKeys(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) allowForwardCompatibleKeys(item);
    return;
  }
  if (node === null || typeof node !== "object") return;

  const record = node as Record<string, unknown>;
  if (record.additionalProperties === false) record.additionalProperties = true;
  for (const value of Object.values(record)) allowForwardCompatibleKeys(value);
}

export function buildObjectJsonSchema(): Record<string, unknown> {
  const generated = zodToJsonSchema(ObjectSchema, {
    name: "StrataObject",
    $refStrategy: "root",
  });
  allowForwardCompatibleKeys(generated);

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: SCHEMA_ID,
    title: "Strata model object",
    description:
      "One object in a Strata model repository: a model, concept, entity, table, " +
      "relationship, mapping, domain, glossary term, naming standard, subject area or " +
      "diagram. Generated from the zod schemas in @strata/metamodel; do not edit by hand.",
    ...generated,
  };
}

/** Stable text: sorted nothing, indented two, newline terminated, so the diff is the change. */
export function renderSchema(schema: Record<string, unknown>): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

/*
  `pathToFileURL`, not a `file://` template: on Windows the script path is `C:\...`, and
  pasting that after `file://` yields a URL that never equals `import.meta.url`, so the
  script would import cleanly in the test and then silently refuse to write when run.
*/
const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const target = join(repoRoot, SCHEMA_PATH);
  await writeFile(target, renderSchema(buildObjectJsonSchema()), "utf8");
  process.stdout.write(`wrote ${SCHEMA_PATH}\n`);
}
