import { describe, expect, it } from "vitest";
import { ObjectGraph } from "./graph.js";
import { lintNames, matchesCasing, splitWords, suggestName, toCasing, toPhysicalName, unabbreviatedWords } from "./naming.js";
import { parseObject, type AnyObject } from "./object.js";
import type { NamingRule, NamingStandard } from "./domain.js";

function obj(input: Record<string, unknown>): AnyObject {
  const result = parseObject(input);
  if (!result.object) throw new Error(`fixture is invalid: ${result.error}`);
  return result.object;
}

describe("word splitting and casing", () => {
  it("splits names however they are cased", () => {
    expect(splitWords("customer_id")).toEqual(["customer", "id"]);
    expect(splitWords("CustomerAccount")).toEqual(["Customer", "Account"]);
    expect(splitWords("dimCustomer")).toEqual(["dim", "Customer"]);
    expect(splitWords("Customer Account")).toEqual(["Customer", "Account"]);
  });

  it("recognises each casing style", () => {
    expect(matchesCasing("customer_id", "snake_case")).toBe(true);
    expect(matchesCasing("CustomerId", "snake_case")).toBe(false);
    expect(matchesCasing("CUSTOMER_ID", "SCREAMING_SNAKE")).toBe(true);
    expect(matchesCasing("customerId", "camelCase")).toBe(true);
    expect(matchesCasing("CustomerId", "PascalCase")).toBe(true);
    expect(matchesCasing("Customer Account", "Title Case")).toBe(true);
    expect(matchesCasing("anything at all", "any")).toBe(true);
  });

  it("converts between casings", () => {
    const words = splitWords("Customer Account");
    expect(toCasing(words, "snake_case")).toBe("customer_account");
    expect(toCasing(words, "PascalCase")).toBe("CustomerAccount");
    expect(toCasing(words, "camelCase")).toBe("customerAccount");
    expect(toCasing(words, "SCREAMING_SNAKE")).toBe("CUSTOMER_ACCOUNT");
  });
});

describe("toPhysicalName", () => {
  const standard = obj({
    id: "nst_1",
    kind: "namingStandard",
    name: "corporate",
    abbreviations: { Identifier: "id", Organisation: "org", Number: "num" },
  }) as NamingStandard;

  it("applies the abbreviation dictionary", () => {
    expect(toPhysicalName("Customer Identifier", standard)).toBe("customer_id");
    expect(toPhysicalName("Organisation Number", standard)).toBe("org_num");
  });

  it("leaves words with no approved abbreviation alone", () => {
    expect(toPhysicalName("Customer Name", standard)).toBe("customer_name");
  });

  it("falls back to snake_case with no standard", () => {
    expect(toPhysicalName("Customer Identifier")).toBe("customer_identifier");
  });

  it("reports words that should have been abbreviated", () => {
    expect(unabbreviatedWords("customer_identifier", standard)).toEqual(["identifier"]);
    expect(unabbreviatedWords("customer_id", standard)).toEqual([]);
  });
});

describe("lintNames", () => {
  const standard = {
    id: "nst_1",
    kind: "namingStandard",
    name: "corporate",
    abbreviations: {},
    rules: [
      { appliesTo: ["table", "column"], casing: "snake_case", severity: "error" },
      { appliesTo: ["entity"], casing: "PascalCase", severity: "error" },
      { appliesTo: ["table"], requiredPrefix: ["dim_", "fct_", "stg_"], severity: "warning" },
      { appliesTo: ["column"], forbiddenWords: ["temp", "test"], severity: "warning" },
      { appliesTo: ["column"], maxLength: 20, severity: "warning" },
    ],
  };

  function lint(...inputs: Record<string, unknown>[]) {
    const graph = ObjectGraph.from([standard, ...inputs].map((i) => ({ object: obj(i) })));
    return lintNames(graph);
  }

  const physicalModel = {
    id: "mdl_wh",
    kind: "model",
    name: "warehouse",
    tier: "physical",
    namingStandard: "corporate",
    target: { project: "p", dataset: "d" },
  };

  it("flags a table that is not snake_case", () => {
    const codes = lint(physicalModel, {
      id: "tbl_1",
      kind: "table",
      name: "DimCustomer",
      model: "warehouse",
      columns: [{ id: "c1", name: "customer_key", dataType: "INT64" }],
    }).map((d) => d.code);
    expect(codes).toContain("naming/case");
  });

  it("suggests the corrected name in the message", () => {
    const finding = lint(physicalModel, {
      id: "tbl_1",
      kind: "table",
      name: "DimCustomer",
      model: "warehouse",
    }).find((d) => d.code === "naming/case");
    expect(finding?.message).toContain("dim_customer");
  });

  it("flags a missing required prefix", () => {
    const codes = lint(physicalModel, {
      id: "tbl_1",
      kind: "table",
      name: "customer",
      model: "warehouse",
    }).map((d) => d.code);
    expect(codes).toContain("naming/prefix");
  });

  it("accepts a table that follows every rule", () => {
    expect(
      lint(physicalModel, {
        id: "tbl_1",
        kind: "table",
        name: "dim_customer",
        model: "warehouse",
        columns: [{ id: "c1", name: "customer_key", dataType: "INT64" }],
      }),
    ).toEqual([]);
  });

  it("checks nested struct field names too", () => {
    const findings = lint(physicalModel, {
      id: "tbl_1",
      kind: "table",
      name: "dim_customer",
      model: "warehouse",
      columns: [
        {
          id: "c1",
          name: "address",
          dataType: "STRUCT",
          fields: [{ id: "c2", name: "postCode", dataType: "STRING" }],
        },
      ],
    });
    expect(findings.map((d) => d.code)).toContain("naming/case");
    expect(findings.find((d) => d.code === "naming/case")?.path).toBe("columns.address.postCode");
  });

  it("flags discouraged words and over-long names", () => {
    const codes = lint(physicalModel, {
      id: "tbl_1",
      kind: "table",
      name: "stg_customer",
      model: "warehouse",
      columns: [
        { id: "c1", name: "temp_value", dataType: "STRING" },
        { id: "c2", name: "a_very_long_column_name_indeed", dataType: "STRING" },
      ],
    }).map((d) => d.code);
    expect(codes).toContain("naming/forbiddenWord");
    expect(codes).toContain("naming/length");
  });

  it("applies tier-specific rules only to the matching tier", () => {
    const logicalModel = {
      id: "mdl_core",
      kind: "model",
      name: "core",
      tier: "logical",
      namingStandard: "corporate",
    };
    // PascalCase applies to entities, snake_case to tables. The same word must be
    // acceptable in one tier and not the other.
    expect(lint(logicalModel, { id: "ent_1", kind: "entity", name: "Customer", model: "core" })).toEqual([]);
    expect(
      lint(logicalModel, { id: "ent_1", kind: "entity", name: "customer_account", model: "core" }).map((d) => d.code),
    ).toContain("naming/case");
  });

  it("skips models that do not point at a standard, rather than imposing defaults", () => {
    // Linting an inherited estate against our conventions on day one would bury
    // the user in findings, which is how linters get switched off.
    expect(
      lint(
        { id: "mdl_x", kind: "model", name: "legacy", tier: "physical", target: { project: "p" } },
        { id: "tbl_1", kind: "table", name: "SomeOldTable", model: "legacy" },
      ),
    ).toEqual([]);
  });

  it("honours severity overrides and strict mode", () => {
    const graph = ObjectGraph.from(
      [standard, physicalModel, { id: "tbl_1", kind: "table", name: "customer", model: "warehouse" }].map((i) => ({
        object: obj(i),
      })),
    );
    expect(lintNames(graph, { severities: { "naming/prefix": "off" } }).map((d) => d.code)).not.toContain(
      "naming/prefix",
    );
    const strict = lintNames(graph, { strict: true }).find((d) => d.code === "naming/prefix");
    expect(strict?.severity).toBe("error");
  });
});

describe("suggestName", () => {
  /** A rule with only the fields a case cares about; the rest default the way zod would. */
  function rule(patch: Partial<NamingRule>): NamingRule {
    return {
      appliesTo: [],
      tiers: [],
      requiredPrefix: [],
      requiredSuffix: [],
      forbiddenWords: [],
      severity: "warning",
      ...patch,
    };
  }

  it("recases a name that only breaks the casing rule", () => {
    expect(suggestName("CustomerKey", rule({ casing: "snake_case" }))).toBe("customer_key");
  });

  it("adds a required prefix without disturbing the casing", () => {
    expect(suggestName("customer", rule({ casing: "snake_case", requiredPrefix: ["dim_"] }))).toBe(
      "dim_customer",
    );
  });

  it("attaches the prefix literally rather than putting it through the casing", () => {
    // `dim_` run through PascalCase becomes `Dim`, which satisfies no rule. The prefix has to
    // be applied after casing, and this is the assertion that keeps that ordering honest.
    expect(suggestName("customer", rule({ casing: "PascalCase", requiredPrefix: ["dim_"] }))).toBe(
      "dim_Customer",
    );
  });

  it("adds a required suffix", () => {
    expect(suggestName("valid", rule({ requiredSuffix: ["_at"] }))).toBe("valid_at");
  });

  it("drops a forbidden word", () => {
    expect(suggestName("new_column", rule({ forbiddenWords: ["new"] }))).toBe("column");
  });

  it("replaces a forbidden word with its approved abbreviation rather than deleting it", () => {
    const standard = { abbreviations: { identifier: "id" } } as unknown as NamingStandard;

    // Deleting the word would turn `customer_identifier` into `customer`, silently changing
    // what the column means. The dictionary exists precisely to prevent that.
    expect(
      suggestName("customer_identifier", rule({ forbiddenWords: ["identifier"] }), standard),
    ).toBe("customer_id");
  });

  it("refuses to suggest an empty name", () => {
    // `test` under a rule forbidding "test" has no mechanical fix, and `""` is not one.
    expect(suggestName("test", rule({ forbiddenWords: ["test"] }))).toBeUndefined();
  });

  it("truncates to the length limit", () => {
    expect(suggestName("a_very_long_column_name", rule({ maxLength: 10 }))?.length).toBeLessThanOrEqual(10);
  });

  it("keeps a required suffix when truncating", () => {
    const result = suggestName("a_very_long_timestamp_column_at", rule({ maxLength: 12, requiredSuffix: ["_at"] }));

    // Truncating from the end would remove the very suffix the rule demands, producing a
    // "fix" that fails the rule it was generated for.
    expect(result?.endsWith("_at")).toBe(true);
    expect(result!.length).toBeLessThanOrEqual(12);
  });

  it("gives up when the limit cannot hold the mandatory suffix", () => {
    expect(suggestName("anything", rule({ maxLength: 2, requiredSuffix: ["_at"] }))).toBeUndefined();
  });

  it("says nothing when the name already complies", () => {
    expect(suggestName("customer_key", rule({ casing: "snake_case" }))).toBeUndefined();
  });

  it("says nothing for a pattern rule, because a regex does not imply a name", () => {
    // A regular expression describes a set of acceptable names; it does not say which member
    // was meant. Guessing would produce a confident wrong rename behind a one-click button.
    expect(suggestName("whatever", rule({ pattern: "^[a-z]+_v[0-9]+$" }))).toBeUndefined();
  });

  it("satisfies every violated rule at once rather than one at a time", () => {
    const result = suggestName(
      "NewCustomerThing",
      rule({ casing: "snake_case", forbiddenWords: ["new"], requiredPrefix: ["dim_"] }),
    );

    expect(result).toBe("dim_customer_thing");
  });
});

describe("lintNames autofix", () => {
  it("attaches the suggestion to the diagnostic as a fix", () => {
    const graph = new ObjectGraph();
    graph.add(
      obj({
        id: "std_1",
        kind: "namingStandard",
        name: "house",
        rules: [{ appliesTo: ["column"], forbiddenWords: ["new"] }],
      }),
    );
    graph.add(
      obj({ id: "mdl_1", kind: "model", name: "wh", tier: "physical", namingStandard: "house" }),
    );
    graph.add(
      obj({
        id: "tbl_1",
        kind: "table",
        name: "t",
        model: "wh",
        columns: [{ id: "c1", name: "new_column", dataType: "STRING" }],
      }),
    );

    const found = lintNames(graph).find((item) => item.code === "naming/forbiddenWord");
    expect(found?.fix).toEqual({ path: "columns.new_column", value: "column" });
  });

  it("leaves a finding with no mechanical fix unfixable rather than guessing", () => {
    const graph = new ObjectGraph();
    graph.add(
      obj({
        id: "std_1",
        kind: "namingStandard",
        name: "house",
        rules: [{ appliesTo: ["column"], forbiddenWords: ["test"] }],
      }),
    );
    graph.add(
      obj({ id: "mdl_1", kind: "model", name: "wh", tier: "physical", namingStandard: "house" }),
    );
    graph.add(
      obj({
        id: "tbl_1",
        kind: "table",
        name: "t",
        model: "wh",
        columns: [{ id: "c1", name: "test", dataType: "STRING" }],
      }),
    );

    const found = lintNames(graph).find((item) => item.code === "naming/forbiddenWord");
    expect(found).toBeDefined();
    expect(found?.fix).toBeUndefined();
  });
});
