import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkspace, type LoadedWorkspace } from "@strata/storage";
import { advise, adviceSummary } from "./advisor.js";

/**
 * Cost advice, against real models on disk.
 *
 * The hard part of this feature is not finding problems, it is *not* reporting non-problems. A
 * cost advisor that tells you to partition a four-hundred-row dimension is one people switch off
 * in a week, and then it is worth nothing on the day it would have caught something real.
 *
 * So roughly half of these tests assert silence: that a dimension is left alone, that a
 * suggestion is withheld when it could not be acted on, and that a table nobody reads is ranked
 * below one four pipelines scan.
 */

let root: string;

async function write(relative: string, content: string): Promise<void> {
  const absolute = join(root, relative);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

const load = (): Promise<LoadedWorkspace> => loadWorkspace(root);

async function advice(): Promise<ReturnType<typeof advise>> {
  return advise((await load()).graph);
}

function codes(findings: ReturnType<typeof advise>): string[] {
  return findings.map((finding) => finding.code);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "strata-advisor-"));

  await write(
    "strata.config.yaml",
    `version: 1
name: warehouse
roots:
  - "."
`,
  );
  await write(
    "models/model.yaml",
    `id: mdl
kind: model
name: warehouse
tier: physical
`,
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("partitioning", () => {
  it("flags a growing table with no partition and names the column to use", async () => {
    await write(
      "models/fct_orders.yaml",
      `id: tbl_fct
kind: table
name: fct_orders
model: warehouse
columns:
  - id: c1
    name: order_ts
    dataType: TIMESTAMP
  - id: c2
    name: amount
    dataType: NUMERIC
`,
    );

    const [finding] = await advice();

    expect(finding!.code).toBe("cost/noPartition");
    // Naming the column is the difference between advice and a complaint.
    expect(finding!.suggestion).toContain("order_ts");
  });

  it("leaves a dimension alone", async () => {
    /*
      The rule that keeps this feature usable. A `dim_` table is small by construction, and
      advising a partition on it is the noise that teaches people to ignore the whole page.
    */
    await write(
      "models/dim_customer.yaml",
      `id: tbl_dim
kind: table
name: dim_customer
model: warehouse
columns:
  - id: c1
    name: created_at
    dataType: TIMESTAMP
  - id: c2
    name: customer_key
    dataType: INT64
`,
    );

    expect(await advice()).toEqual([]);
  });

  it("does not suggest a partition it cannot name a column for", async () => {
    // A suggestion nobody can act on is worse than silence; this reports the *absence* instead.
    await write(
      "models/raw_events.yaml",
      `id: tbl_raw
kind: table
name: raw_events
model: warehouse
columns:
  - id: c1
    name: payload
    dataType: STRING
`,
    );

    const found = await advice();
    expect(codes(found)).toEqual(["cost/noPartitionCandidate"]);
    expect(found[0]!.severity).toBe("low");
  });

  it("flags a partition that does not require a filter", async () => {
    await write(
      "models/fct_sales.yaml",
      `id: tbl_s
kind: table
name: fct_sales
model: warehouse
columns:
  - id: c1
    name: sold_on
    dataType: DATE
partitioning:
  type: time
  field: sold_on
  granularity: DAY
`,
    );

    expect(codes(await advice())).toContain("cost/partitionFilterNotRequired");
  });

  it("says nothing when the partition already requires a filter", async () => {
    await write(
      "models/fct_sales.yaml",
      `id: tbl_s
kind: table
name: fct_sales
model: warehouse
columns:
  - id: c1
    name: sold_on
    dataType: DATE
partitioning:
  type: time
  field: sold_on
  granularity: DAY
  requireFilter: true
`,
    );

    expect(await advice()).toEqual([]);
  });
});

describe("clustering", () => {
  it("reports more than four clustering columns as a hard failure", async () => {
    /*
      Not advice, BigQuery rejects the DDL. Surfaced here because it is found by the same pass,
      and someone reading clustering advice should not have to look elsewhere to discover their
      clustering is invalid.
    */
    await write(
      "models/fct_wide.yaml",
      `id: tbl_w
kind: table
name: fct_wide
model: warehouse
columns:
  - id: c1
    name: a
    dataType: STRING
  - id: c2
    name: sold_on
    dataType: DATE
clustering: [a, b, c, d, e]
partitioning:
  type: time
  field: sold_on
  requireFilter: true
`,
    );

    const found = await advice();
    expect(codes(found)).toContain("cost/tooManyClusteringColumns");
    expect(found.find((f) => f.code === "cost/tooManyClusteringColumns")!.severity).toBe("high");
  });

  it("suggests clustering a fact on its foreign keys", async () => {
    await write(
      "models/fct_order_line.yaml",
      `id: tbl_fol
kind: table
name: fct_order_line
model: warehouse
columns:
  - id: c1
    name: customer_key
    dataType: INT64
  - id: c2
    name: sold_on
    dataType: DATE
foreignKeys:
  - name: fk_customer
    columns: [customer_key]
    references:
      table: dim_customer
      columns: [customer_key]
partitioning:
  type: time
  field: sold_on
  requireFilter: true
`,
    );

    const found = await advice();
    const clustering = found.find((f) => f.code === "cost/noClustering");
    expect(clustering).toBeDefined();
    expect(clustering!.suggestion).toContain("customer_key");
  });

  it("notes clustering that duplicates the partition column", async () => {
    // The partition already segregates those values, so this spends one of only four slots twice.
    await write(
      "models/fct_x.yaml",
      `id: tbl_x
kind: table
name: fct_x
model: warehouse
columns:
  - id: c1
    name: sold_on
    dataType: DATE
clustering: [sold_on]
partitioning:
  type: time
  field: sold_on
  requireFilter: true
`,
    );

    expect(codes(await advice())).toContain("cost/clusteringOnPartitionColumn");
  });
});

describe("ranking", () => {
  it("raises severity for a table pipelines actually scan", async () => {
    /*
      The judgement the whole feature turns on. An unpartitioned table nothing reads costs
      storage; one that two pipelines scan costs two full scans per run.
    */
    await write(
      "models/raw_a.yaml",
      `id: tbl_a
kind: table
name: raw_a
model: warehouse
columns:
  - id: c1
    name: seen_at
    dataType: TIMESTAMP
`,
    );
    await write(
      "models/raw_b.yaml",
      `id: tbl_b
kind: table
name: raw_b
model: warehouse
columns:
  - id: c2
    name: seen_at
    dataType: TIMESTAMP
`,
    );
    await write(
      "models/target.yaml",
      `id: tbl_t
kind: table
name: dim_target
model: warehouse
columns:
  - id: c3
    name: k
    dataType: INT64
`,
    );
    // Two mappings read raw_a; none read raw_b.
    await write(
      "models/m1.yaml",
      `id: map1
kind: mapping
name: load_one
model: warehouse
target: dim_target
sources:
  - alias: a
    ref: raw_a
columnMappings:
  - target: k
    sources: [a.seen_at]
`,
    );
    await write(
      "models/m2.yaml",
      `id: map2
kind: mapping
name: load_two
model: warehouse
target: dim_target
sources:
  - alias: a
    ref: raw_a
columnMappings:
  - target: k
    sources: [a.seen_at]
`,
    );

    const found = await advice();
    const a = found.find((f) => f.objectName === "raw_a")!;
    const b = found.find((f) => f.objectName === "raw_b")!;

    expect(a.readers).toBe(2);
    expect(a.severity).toBe("high");
    expect(b.severity).toBe("medium");
    // Worst first, so the expensive one is what you see.
    expect(found.indexOf(a)).toBeLessThan(found.indexOf(b));
    expect(a.message).toContain("2 pipelines read it");
    // Singular agrees too: "1 pipeline reads it", not "1 pipeline read it".
    expect(b.message).toContain("no partitioning.");
  });

  it("summarises by severity", async () => {
    await write(
      "models/fct_orders.yaml",
      `id: tbl_fct
kind: table
name: fct_orders
model: warehouse
columns:
  - id: c1
    name: order_ts
    dataType: TIMESTAMP
`,
    );

    const summary = adviceSummary(await advice());
    expect(summary.medium).toBe(1);
    expect(summary.high).toBe(0);
  });

  it("says nothing about a workspace with no physical tables", async () => {
    expect(await advice()).toEqual([]);
  });
});
