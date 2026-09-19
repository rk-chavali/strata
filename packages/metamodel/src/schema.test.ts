import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildObjectJsonSchema, renderSchema, SCHEMA_PATH } from "../scripts/build-schema.js";
import { OBJECT_KINDS, parseObject } from "./object.js";

/**
 * The published JSON Schema, held to the two promises that make it worth publishing.
 *
 * It must match the zod schemas, or it red-squiggles fields that are real and a modeller
 * learns to ignore their editor. And it must accept the files Strata itself ships, or the
 * very first thing a new user opens is covered in false errors.
 *
 * Neither is guaranteed by generating it. The generator translates zod into JSON Schema,
 * and a translation can be wrong; the committed artifact can also fall behind the source
 * the moment someone edits `object.ts` without rerunning the generator. So the first test
 * is a drift gate and the rest are fidelity checks against real files.
 */

const repoRoot = join(import.meta.dirname, "..", "..", "..");

function readCommitted(): string {
  return readFileSync(join(repoRoot, SCHEMA_PATH), "utf8");
}

/** Every YAML file in the shipped example workspace, recursively. */
function exampleFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return exampleFiles(path);
    return /\.ya?ml$/.test(entry) ? [path] : [];
  });
}

const validator = new Ajv({ allErrors: true, strict: false }).compile(buildObjectJsonSchema());

describe("the committed JSON Schema", () => {
  it("matches what the zod schemas generate right now", () => {
    /*
      The drift gate, and the reason this artifact can be trusted at all. It fails the moment
      `object.ts` changes without `pnpm --filter @strata/metamodel schema` being rerun, which
      turns a silently stale published schema into a red test on the pull request that caused
      it. CI already runs this suite, so no new workflow step is needed.
    */
    expect(readCommitted()).toBe(renderSchema(buildObjectJsonSchema()));
  });

  it("covers every kind the metamodel defines, with no kind left behind", () => {
    const branches = buildObjectJsonSchema().definitions as {
      StrataObject: { anyOf: { properties: { kind: { const: string } } }[] };
    };
    const covered = branches.StrataObject.anyOf.map((b) => b.properties.kind.const).sort();

    expect(covered).toEqual([...OBJECT_KINDS].sort());
  });
});

describe("the JSON Schema against the files Strata ships", () => {
  const files = exampleFiles(join(repoRoot, "examples"));

  it("finds example files to check, so a rename cannot empty this suite", () => {
    // Without this, moving `examples/` would turn every test below into a silent pass.
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => [f.slice(repoRoot.length + 1).replace(/\\/g, "/"), f] as const))(
    "accepts %s",
    (_label, path) => {
      const parsed = parse(readFileSync(path, "utf8")) as unknown;

      // `strata.config.yaml` is a different schema; this one describes model objects.
      if (!parsed || typeof parsed !== "object" || !("kind" in parsed)) return;

      // Anything zod accepts, the published schema must accept too. A disagreement here is
      // a translation bug, and it would reach users as an editor error on a valid file.
      expect(parseObject(parsed).error).toBeUndefined();
      expect(validator(parsed), JSON.stringify(validator.errors, null, 2)).toBe(true);
    },
  );
});

describe("the JSON Schema on files it should reject", () => {
  const table = {
    id: "tbl_fct_order",
    kind: "table",
    name: "fct_order",
    model: "shop_warehouse",
  };

  it("rejects an object with no kind, the one field the union turns on", () => {
    expect(validator({ id: "x", name: "y" })).toBe(false);
  });

  it("rejects a kind that is not a kind", () => {
    expect(validator({ ...table, kind: "tabel" })).toBe(false);
  });

  it("rejects a column list that is not a list", () => {
    expect(validator({ ...table, columns: "order_id" })).toBe(false);
  });

  it("allows an unrecognised key, matching what the loader actually does", () => {
    /*
      Deliberate, and the schema would be wrong to disagree. The loader preserves keys it has
      no field for so a file from a newer Strata survives a round trip, so an editor must not
      call one an error. `strata check` still reports it as a warning.
    */
    expect(validator({ ...table, retentionPolicy: "7y" })).toBe(true);
  });
});
