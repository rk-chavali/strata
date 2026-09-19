import { describe, expect, it } from "vitest";
import { parseObject } from "@strata/metamodel";
import { parseYamlFile, serializeObject } from "./serialize.js";
import {
  CONFIG_VERSION,
  UnsupportedVersionError,
  assertSupportedVersion,
  parseWorkspaceConfig,
} from "./config.js";

/**
 * Whether a model file survives being opened and saved by a Strata that does not fully
 * understand it.
 *
 * This is the property the whole product rests on. The model is files in a git repository,
 * those files outlive any one version of the tool, and more than one version will be
 * pointed at the same repository: a teammate who has not upgraded, a CI runner pinned a
 * release behind, a laptop that has been offline for a month. If the older one quietly
 * rewrites the file without the parts it did not recognise, the loss arrives as a deletion
 * in a pull request that no human wrote and no reviewer can explain.
 *
 * These tests read a file the way the loader does and write it back the way the saver does,
 * with nothing in between, because the failure was never in either half on its own. Parsing
 * kept working and serializing kept working; it was the trip through both that lost data.
 */

const newerStrata = `
id: tbl_fct_order
kind: table
name: fct_order
model: shop_warehouse
description: One row per order line.
columns:
  - id: col_order_id
    name: order_id
    dataType: STRING
    maskingPolicy: sha256
  - id: col_total
    name: total_amount
    dataType: NUMERIC
retentionPolicy: 7y
`;

/** Read a YAML document the way the workspace loader does, then write it back. */
function roundTrip(yaml: string): { text: string; unrecognised: string[] } {
  const parsed = parseYamlFile(yaml);
  expect(parsed.errors).toEqual([]);

  const result = parseObject(parsed.documents[0]?.value);
  expect(result.error).toBeUndefined();

  return { text: serializeObject(result.object), unrecognised: result.unrecognised ?? [] };
}

describe("a model file written by a newer Strata", () => {
  it("keeps a top-level field this version has no schema for", () => {
    const { text } = roundTrip(newerStrata);

    expect(text).toContain("retentionPolicy: 7y");
  });

  it("keeps a field inside a column, where losing one is worst", () => {
    /*
      Columns are where a new release is most likely to add something, and a column is the
      one place a silent drop does damage beyond the file: `maskingPolicy` going missing
      turns generated DDL into an unmasked column nobody noticed was masked before.
    */
    const { text } = roundTrip(newerStrata);

    expect(text).toContain("maskingPolicy: sha256");
  });

  it("still says out loud which fields it did not understand", () => {
    // Preserving them is not the same as pretending to support them. `strata check` should
    // report both, or a genuine typo becomes invisible the moment it stops being deleted.
    const { unrecognised } = roundTrip(newerStrata);

    expect(unrecognised).toEqual(["columns[0].maskingPolicy", "retentionPolicy"]);
  });

  it("does not disturb the fields it does understand", () => {
    const { text } = roundTrip(newerStrata);

    expect(text).toContain("name: fct_order");
    expect(text).toContain("description: One row per order line.");
    expect(text).toContain("dataType: NUMERIC");
  });

  it("is stable on a second trip, so an unchanged file produces no diff", () => {
    // A round trip that keeps fields but reorders them on every save is still unusable:
    // every open-and-save would churn the repository.
    const first = roundTrip(newerStrata).text;
    const second = roundTrip(first).text;

    expect(second).toBe(first);
  });
});

describe("workspace version gate", () => {
  const base = { name: "shop", version: CONFIG_VERSION };

  it("accepts the version it was built for", () => {
    expect(parseWorkspaceConfig(base).version).toBe(CONFIG_VERSION);
  });

  it("defaults an omitted version rather than failing", () => {
    expect(parseWorkspaceConfig({ name: "shop" }).version).toBe(CONFIG_VERSION);
  });

  it("refuses a workspace from the future by name, not by zod error", () => {
    /*
      The point of the gate. `z.literal` rejected these too, but with "invalid literal
      value, expected 1" thrown out of a union, which tells a user nothing about what to do.
      It also meant no version 2 could ever ship: every installed Strata would have failed
      on it in a way indistinguishable from a corrupt file.
    */
    expect(() => parseWorkspaceConfig({ ...base, version: CONFIG_VERSION + 1 })).toThrow(
      UnsupportedVersionError,
    );
    expect(() => assertSupportedVersion(CONFIG_VERSION + 1)).toThrow(/Upgrade Strata/);
  });

  it("still rejects a version that is not a version at all", () => {
    expect(() => parseWorkspaceConfig({ ...base, version: 0 })).toThrow();
    expect(() => parseWorkspaceConfig({ ...base, version: "two" })).toThrow();
  });
});
