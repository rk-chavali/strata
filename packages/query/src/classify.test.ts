import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkspace } from "@strata/storage";
import { DATA_CATEGORIES, SENSITIVITY_LEVELS } from "@strata/metamodel";
import { classificationCoverage, suggestClassifications } from "./classify.js";

/**
 * Classification suggestions.
 *
 * The failure that matters here is the **false positive**, not the miss. A suggestion proposes
 * column-level security; a wrong one either locks a column nobody needed locked or teaches a
 * reviewer to click "accept all" without reading, and the second is how a real PII column gets
 * waved through six months later.
 *
 * So the guards below are mostly about restraint: word boundaries, leaving classified columns
 * alone, and producing only values the schema will actually accept.
 */

let root: string;

async function write(relative: string, content: string): Promise<void> {
  const absolute = join(root, relative);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

/** A table with the given columns, written and loaded. */
async function withColumns(yaml: string): Promise<ReturnType<typeof suggestClassifications>> {
  await write(
    "models/t.yaml",
    `id: tbl
kind: table
name: customers
model: warehouse
columns:
${yaml}
`,
  );
  return suggestClassifications((await loadWorkspace(root)).graph);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strata-classify-"));
  await write("strata.config.yaml", `version: 1\nname: w\nroots:\n  - "."\n`);
  await write("models/model.yaml", `id: mdl\nkind: model\nname: warehouse\ntier: physical\n`);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("recognising the obvious", () => {
  it("classifies an email as contact PII and a subject identifier", async () => {
    const [found] = await withColumns(`  - id: c1
    name: email_address
    dataType: STRING`);

    expect(found!.suggested.categories).toEqual(["contact", "pii"]);
    expect(found!.suggested.sensitivity).toBe("confidential");
    // Subject identifier drives erasure mapping, the whole point of marking it.
    expect(found!.suggested.subjectIdentifier).toBe(true);
  });

  it("treats a government identifier as restricted", async () => {
    const [found] = await withColumns(`  - id: c1
    name: ssn
    dataType: STRING`);
    expect(found!.suggested.sensitivity).toBe("restricted");
    expect(found!.suggested.categories).toContain("pii");
  });

  it("classifies a card number as PCI and financial", async () => {
    const [found] = await withColumns(`  - id: c1
    name: card_number
    dataType: STRING`);
    expect(found!.suggested.categories).toEqual(["pci", "financial"]);
  });

  it("explains which rule fired", async () => {
    // A reviewer has to be able to argue with the rule rather than with an oracle.
    const [found] = await withColumns(`  - id: c1
    name: date_of_birth
    dataType: DATE`);
    expect(found!.reason).toContain("date of birth");
  });

  it("matches email before postal address, so ordering holds", async () => {
    /*
      `email_address` contains `address`. If the postal rule ran first it would be classified as
      a location, which is both wrong and the kind of wrong nobody notices in a list of fifty.
    */
    const [found] = await withColumns(`  - id: c1
    name: email_address
    dataType: STRING`);
    expect(found!.suggested.categories).not.toContain("location");
  });
});

describe("restraint", () => {
  it("does not match a pattern inside a longer word", async () => {
    // `lesson_id` contains `ssn`. Unanchored patterns propose locking down random columns.
    const found = await withColumns(`  - id: c1
    name: lesson_id
    dataType: STRING
  - id: c2
    name: transaction_id
    dataType: STRING`);
    expect(found).toEqual([]);
  });

  it("leaves a column that already states a classification alone", async () => {
    /*
      Somebody made that call, possibly after an argument. A suggester that second-guesses
      recorded decisions is one people switch off.
    */
    const found = await withColumns(`  - id: c1
    name: email_address
    dataType: STRING
    classification:
      sensitivity: public`);
    expect(found).toEqual([]);
  });

  it("leaves a column that inherits from a domain alone", async () => {
    await write(
      "models/domain.yaml",
      `id: dom
kind: domain
name: email_domain
classification:
  sensitivity: confidential
  categories: [contact]
`,
    );
    const found = await withColumns(`  - id: c1
    name: email_address
    dataType: STRING
    domain: email_domain`);
    // It is already classified, just not in its own file.
    expect(found).toEqual([]);
  });

  it("says nothing about ordinary warehouse plumbing", async () => {
    const found = await withColumns(`  - id: c1
    name: customer_key
    dataType: INT64
  - id: c2
    name: load_timestamp
    dataType: TIMESTAMP
  - id: c3
    name: is_current
    dataType: BOOL`);
    expect(found).toEqual([]);
  });
});

describe("schema safety", () => {
  it("only ever suggests values the schema accepts", async () => {
    /*
      The categories vocabulary is a closed enum, and a suggestion outside it is silently rejected
      on save, the column stays unclassified while the UI reports success.
    */
    const found = await withColumns(`  - id: c1
    name: email_address
    dataType: STRING
  - id: c2
    name: ssn
    dataType: STRING
  - id: c3
    name: latitude
    dataType: FLOAT64
  - id: c4
    name: salary
    dataType: NUMERIC
  - id: c5
    name: password_hash
    dataType: STRING
  - id: c6
    name: ip_address
    dataType: STRING`);

    expect(found.length).toBeGreaterThan(0);
    for (const suggestion of found) {
      for (const category of suggestion.suggested.categories ?? []) {
        expect(DATA_CATEGORIES).toContain(category);
      }
      if (suggestion.suggested.sensitivity) {
        expect(SENSITIVITY_LEVELS).toContain(suggestion.suggested.sensitivity);
      }
    }
  });

  it("ranks high confidence first", async () => {
    const found = await withColumns(`  - id: c1
    name: city
    dataType: STRING
  - id: c2
    name: ssn
    dataType: STRING`);

    expect(found[0]!.confidence).toBe("high");
    expect(found[0]!.column).toBe("ssn");
  });

  it("addresses a nested STRUCT field by its full path", async () => {
    // The path is what an edit uses; a top-level guess would write to the wrong place.
    const found = await withColumns(`  - id: c1
    name: contact
    dataType: STRUCT
    fields:
      - id: c1a
        name: email_address
        dataType: STRING`);

    expect(found).toHaveLength(1);
    // Dotted, parent first, the form the dictionary and the member patch both address by.
    expect(found[0]!.path).toBe("contact.email_address");
    expect(found[0]!.column).toBe("email_address");
  });
});

describe("coverage", () => {
  it("separates what is done, what can be proposed, and what needs a person", async () => {
    await withColumns(`  - id: c1
    name: email_address
    dataType: STRING
  - id: c2
    name: customer_key
    dataType: INT64
  - id: c3
    name: loyalty_band
    dataType: STRING
    classification:
      sensitivity: internal`);

    const report = classificationCoverage((await loadWorkspace(root)).graph);

    expect(report.total).toBe(3);
    expect(report.classified).toBe(1);
    expect(report.suggestions).toBe(1);
    /*
      The number a governance lead actually plans against: the work left after every obvious case
      has been proposed.
    */
    expect(report.unrecognised).toBe(1);
  });
});
