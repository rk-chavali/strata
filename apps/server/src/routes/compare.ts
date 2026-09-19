/**
 * Comparing two models, and the migration between them.
 *
 * Split out of `index.ts`, where these routes sat among a hundred others. The paths are
 * unchanged and the router is mounted at the root, so what a caller sees is identical;
 * what changes is that this group can now be read, and edited, without scrolling past
 * every other group in the server.
 */
import { Router } from "express";
import { readers } from "../guards.js";
import { handler } from "../respond.js";
import { getWorkspace } from "../workspacecache.js";
import { generateAlter, renderAlterScript } from "@strata/ddl";
import { type Table, compareModels } from "@strata/metamodel";
import { type LoadedWorkspace } from "@strata/storage";

export const compareRoutes = Router();

// ---------------------------------------------------------------- compare

/**
 * Pairs worth comparing, so the view opens on something useful.
 *
 * A picker with every model against every other is a Cartesian product nobody wants to
 * read. The comparisons that mean something are between **adjacent tiers of the same
 * product**, that is where drift accumulates, because the two were designed together
 * and then edited apart.
 */
function suggestedPairs(workspace: LoadedWorkspace): { left: string; right: string; label: string }[] {
  const models = workspace.graph.models().map((entry) => entry.object);
  const byNamespace = new Map<string, typeof models>();

  for (const model of models) {
    const key = model.namespace ?? "";
    const bucket = byNamespace.get(key);
    if (bucket) bucket.push(model);
    else byNamespace.set(key, [model]);
  }

  const pairs: { left: string; right: string; label: string }[] = [];
  for (const [namespace, group] of byNamespace) {
    const at = (tier: string): typeof models => group.filter((model) => model.tier === tier);
    for (const [upper, lower] of [
      ["conceptual", "logical"],
      ["logical", "physical"],
    ] as const) {
      for (const left of at(upper)) {
        for (const right of at(lower)) {
          pairs.push({
            left: left.name,
            right: right.name,
            label: `${namespace ? `${namespace} · ` : ""}${upper} ↔ ${lower}`,
          });
        }
      }
    }
  }
  return pairs;
}

compareRoutes.get(
  "/api/compare/pairs",
  readers,
  handler(async (_req, res) => {
    const workspace = await getWorkspace();
    res.json({
      pairs: suggestedPairs(workspace),
      models: workspace.graph.models().map((entry) => ({
        name: entry.object.name,
        tier: entry.object.tier,
        ...(entry.object.namespace ? { namespace: entry.object.namespace } : {}),
      })),
    });
  }),
);

/**
 * The DDL that would migrate one physical model's tables into another's shape.
 *
 * The second half of a compare: the first says two things differ, this says what to run. Only
 * meaningful between two *physical* models, because ALTER statements are about warehouse objects, * a conceptual model has no tables to alter, and offering a migration for one would be nonsense
 * dressed as a feature.
 *
 * Tables are matched by name. `from` is the current shape and `to` is the desired one, so
 * comparing staging against mart produces the statements to make staging look like mart.
 */
compareRoutes.post(
  "/api/compare/migration",
  readers,
  handler(async (req, res) => {
    const workspace = await getWorkspace();
    const body = req.body as { from?: string; to?: string; dropColumns?: boolean };

    const from = body.from ? workspace.graph.modelNamed(body.from) : undefined;
    const to = body.to ? workspace.graph.modelNamed(body.to) : undefined;
    if (!from || !to) {
      res.status(404).json({ error: "both a `from` and a `to` model are required" });
      return;
    }

    for (const model of [from, to]) {
      if (model.tier !== "physical") {
        res.status(400).json({
          error: `\`${model.name}\` is a ${model.tier} model. A migration only exists between physical models, there are no tables to alter otherwise.`,
        });
        return;
      }
    }

    const tablesOf = (name: string): Map<string, Table> => {
      const map = new Map<string, Table>();
      for (const entry of workspace.graph.inModel(name)) {
        if (entry.object.kind === "table") map.set(entry.object.name, entry.object as Table);
      }
      return map;
    };

    const current = tablesOf(from.name);
    const desired = tablesOf(to.name);

    const scripts = [];
    for (const [name, target] of desired) {
      const existing = current.get(name);
      if (!existing) {
        /**
         * A table the other side does not have at all.
         *
         * Not an ALTER, there is nothing to alter, so it is reported as a creation and the
         * `CREATE TABLE` for it already comes from the ordinary DDL generator. Emitting a
         * half-migration that silently skipped new tables would be the misleading option.
         */
        scripts.push({
          table: name,
          missing: true,
          requiresRecreate: false,
          changes: [
            {
              code: "table/missing",
              severity: "recreate" as const,
              message: `\`${name}\` does not exist in ${from.name}. Create it from the generated DDL rather than altering it.`,
            },
          ],
          statements: [],
          sql: "",
        });
        continue;
      }

      const script = generateAlter(existing, target, {
        qualifiedName: [target.project ?? to.target?.project, target.dataset ?? to.target?.dataset, name]
          .filter(Boolean)
          .join("."),
        ...(body.dropColumns ? { dropColumns: true } : {}),
      });

      if (script.changes.length === 0) continue;
      scripts.push({ ...script, missing: false, sql: renderAlterScript(script) });
    }

    res.json({
      from: from.name,
      to: to.name,
      scripts,
      /** Tables in `from` with no counterpart in `to`, which a migration cannot speak about. */
      extraTables: [...current.keys()].filter((name) => !desired.has(name)),
    });
  }),
);

/** Drift between two models. Read-only, this reports, it never reconciles. */
compareRoutes.post(
  "/api/compare",
  readers,
  handler(async (req, res) => {
    const body = req.body as { left?: string; right?: string };
    const workspace = await getWorkspace();

    const names = new Set(workspace.graph.models().map((entry) => entry.object.name));
    for (const side of [body.left, body.right]) {
      if (!side || !names.has(side)) {
        res.status(404).json({ error: `no model named ${side ?? "(missing)"}` });
        return;
      }
    }
    if (body.left === body.right) {
      res.status(422).json({ error: "pick two different models" });
      return;
    }

    res.json(compareModels(workspace.graph, body.left!, body.right!));
  }),
);

