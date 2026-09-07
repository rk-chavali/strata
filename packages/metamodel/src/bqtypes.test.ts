import { describe, expect, it } from "vitest";
import {
  canonicalizeType,
  classifyTypeChange,
  formatBigQueryType,
  parseBigQueryType,
  tryParseBigQueryType,
} from "./bqtypes.js";

describe("parseBigQueryType", () => {
  it("parses scalars and normalises aliases", () => {
    expect(parseBigQueryType("STRING")).toEqual({ base: "STRING", parameters: [] });
    expect(parseBigQueryType("INTEGER").base).toBe("INT64");
    expect(parseBigQueryType("boolean").base).toBe("BOOL");
    expect(parseBigQueryType("DECIMAL").base).toBe("NUMERIC");
  });

  it("parses type parameters, including MAX", () => {
    expect(parseBigQueryType("NUMERIC(18, 2)").parameters).toEqual([18, 2]);
    expect(parseBigQueryType("STRING(MAX)").parameters).toEqual([-1]);
  });

  it("parses arrays and nested arrays of structs", () => {
    const parsed = parseBigQueryType("ARRAY<STRUCT<id INT64, label STRING>>");
    expect(parsed.base).toBe("ARRAY");
    expect(parsed.elementType?.base).toBe("STRUCT");
    expect(parsed.elementType?.fields?.map((f) => f.name)).toEqual(["id", "label"]);
  });

  it("parses anonymous struct fields", () => {
    const parsed = parseBigQueryType("STRUCT<INT64, STRING>");
    expect(parsed.fields?.map((f) => f.name)).toEqual([undefined, undefined]);
    expect(parsed.fields?.map((f) => f.type.base)).toEqual(["INT64", "STRING"]);
  });

  it("parses a struct field whose type itself takes parameters", () => {
    const parsed = parseBigQueryType("STRUCT<amount NUMERIC(18, 2)>");
    expect(parsed.fields?.[0]?.name).toBe("amount");
    expect(parsed.fields?.[0]?.type.parameters).toEqual([18, 2]);
  });

  it("rejects unknown types and trailing junk", () => {
    expect(tryParseBigQueryType("VARCHAR")).toHaveProperty("error");
    expect(tryParseBigQueryType("INT64 EXTRA")).toHaveProperty("error");
    expect(tryParseBigQueryType("")).toHaveProperty("error");
  });

  it("round-trips through format", () => {
    for (const type of ["STRING", "NUMERIC(18, 2)", "ARRAY<INT64>", "STRUCT<a INT64, b STRING>"]) {
      expect(formatBigQueryType(parseBigQueryType(type))).toBe(type);
    }
  });

  it("canonicalises aliases but leaves unparseable input alone", () => {
    expect(canonicalizeType("integer")).toBe("INT64");
    expect(canonicalizeType("VARCHAR(10)")).toBe("VARCHAR(10)");
  });
});

describe("classifyTypeChange", () => {
  it("treats an identical type as no change, aliases included", () => {
    expect(classifyTypeChange("INT64", "INT64")).toBe("none");
    expect(classifyTypeChange("INTEGER", "INT64")).toBe("none");
  });

  it("allows BigQuery's supported widenings in place", () => {
    expect(classifyTypeChange("INT64", "NUMERIC")).toBe("safe");
    expect(classifyTypeChange("NUMERIC", "BIGNUMERIC")).toBe("safe");
    expect(classifyTypeChange("NUMERIC(10, 2)", "NUMERIC(18, 2)")).toBe("safe");
  });

  it("flags narrowing as destructive", () => {
    expect(classifyTypeChange("NUMERIC(18, 4)", "NUMERIC(10, 2)")).toBe("destructive");
    expect(classifyTypeChange("STRING(100)", "STRING(10)")).toBe("destructive");
  });

  it("requires a rebuild for anything it cannot do in place", () => {
    expect(classifyTypeChange("STRING", "INT64")).toBe("requiresRebuild");
    expect(classifyTypeChange("STRUCT<a INT64>", "STRING")).toBe("requiresRebuild");
  });

  it("treats appending a nested STRUCT field as safe, since BigQuery allows it", () => {
    expect(classifyTypeChange("STRUCT<a INT64>", "STRUCT<a INT64, b STRING>")).toBe("safe");
  });

  it("treats removing a STRUCT field as destructive and reordering as a rebuild", () => {
    expect(classifyTypeChange("STRUCT<a INT64, b STRING>", "STRUCT<a INT64>")).toBe("destructive");
    expect(classifyTypeChange("STRUCT<a INT64, b STRING>", "STRUCT<b STRING, a INT64>")).toBe("requiresRebuild");
  });

  it("recurses into nested struct fields", () => {
    expect(classifyTypeChange("STRUCT<a NUMERIC(10, 2)>", "STRUCT<a NUMERIC(18, 2)>")).toBe("safe");
    expect(classifyTypeChange("STRUCT<a NUMERIC(18, 2)>", "STRUCT<a NUMERIC(10, 2)>")).toBe("destructive");
  });

  it("refuses to relax an array element type in place", () => {
    // The equivalent scalar change is safe, but arrays cannot be altered.
    expect(classifyTypeChange("ARRAY<INT64>", "ARRAY<NUMERIC>")).toBe("requiresRebuild");
    expect(classifyTypeChange("ARRAY<INT64>", "ARRAY<INT64>")).toBe("none");
  });

  it("treats an unbounded string narrowed to a fixed length as destructive", () => {
    expect(classifyTypeChange("STRING", "STRING(10)")).toBe("destructive");
    expect(classifyTypeChange("STRING(10)", "STRING")).toBe("safe");
    expect(classifyTypeChange("STRING(10)", "STRING(MAX)")).toBe("safe");
  });

  it("errs towards a rebuild when a type cannot be parsed", () => {
    expect(classifyTypeChange("MYSTERY", "STRING")).toBe("requiresRebuild");
  });
});
