import type { Mapping, ObjectGraph } from "@strata/metamodel";

/**
 * Where a column comes from, and what breaks if you change it.
 *
 * One traversal, walked in two directions. Upstream answers "where does this value come
 * from", the question every analyst asks and no diagram answers. Downstream answers "what
 * breaks if I drop this", which is the question you want answered *before* you merge, not
 * after a pipeline fails at 3am.
 *
 * The edges come from four places, and the first is the one that makes this column-level
 * rather than table-level:
 *
 *   1. **Mappings.** `columnMappings[].sources` is `["alias.column"]`, and `sources[]` binds
 *      each alias to a real table. That is a genuine column-to-column edge, with the SQL
 *      expression attached, which is what lets the lineage view say *how* a value was
 *      derived rather than merely that it was.
 *   2. **Foreign keys.** A table-level edge: dropping a referenced column breaks the join.
 *   3. **`attributeRef` / `entityRef`.** The physical-to-logical link. Renaming a logical
 *      attribute has to surface every physical column claiming to implement it.
 *   4. **Model `derivedFrom`.** The tier chain, so impact can cross models.
 *
 * Nothing here reads SQL. `customSql` on a mapping is deliberately reported as opaque
 * rather than parsed: a lineage graph that silently omits the columns it could not parse is
 * worse than one that admits the gap, because the omission looks like an answer.
 */

export type EdgeKind = "mapping" | "foreignKey" | "implements" | "derivedFrom";

export interface LineageRef {
  objectId: string;
  objectName: string;
  kind: string;
  model?: string;
  /** Column or attribute name, when the edge is column-level. */
  column?: string;
}

export interface LineageEdge {
  from: LineageRef;
  to: LineageRef;
  kind: EdgeKind;
  /** The mapping that carries this edge, when there is one. */
  via?: { id: string; name: string };
  /** The SQL that produces the target from the source, when it is not a passthrough. */
  expression?: string;
  /** The prose business rule, when the mapping states one. */
  rule?: string;
}

export interface LineageResult {
  /** What was asked about. */
  focus: LineageRef;
  direction: "upstream" | "downstream";
  edges: LineageEdge[];
  /** Every distinct object touched, so a client can lay out nodes without re-deriving them. */
  nodes: LineageRef[];
  /** How many hops out the walk actually went. */
  depth: number;
  /** True when the walk stopped at the depth limit rather than running out of graph. */
  truncated: boolean;
  /**
   * Mappings in the traversal that use `customSql`, so the answer can be honest about the
   * part it cannot see through.
   */
  opaque: { id: string; name: string; target: string }[];
}

/** How much a change to the focus would hurt, per affected object. */
export type ImpactSeverity = "breaks" | "rewrites" | "informational";

export interface ImpactEntry extends LineageRef {
  /** Hops from the focus. 1 is a direct consumer. */
  distance: number;
  severity: ImpactSeverity;
  /** Plain sentence naming the actual consequence. */
  reason: string;
  via?: { id: string; name: string };
}

export interface ImpactResult {
  focus: LineageRef;
  entries: ImpactEntry[];
  /** Counts by severity, so a UI can lead with the number that matters. */
  counts: Record<ImpactSeverity, number>;
  truncated: boolean;
  opaque: { id: string; name: string; target: string }[];
}

const MAX_DEPTH = 6;

interface ResolvedEdge extends LineageEdge {
  /** Index keys, precomputed so the walk is a map lookup rather than a scan. */
  fromKey: string;
  toKey: string;
}

function key(objectId: string, column?: string): string {
  // Columns are compared case-insensitively because BigQuery treats them that way and a
  // mapping written `S.Customer_Id` must still match the column `customer_id`.
  return column ? `${objectId}::${column.toLowerCase()}` : objectId;
}

/**
 * Every edge in the workspace, built once.
 *
 * Built whole rather than lazily expanded from the focus. Lazy expansion needs a reverse
 * index to walk downstream anyway, and building that is the same work as building this, * so the simpler version wins, and it is reusable across both directions.
 */
function buildEdges(graph: ObjectGraph): {
  edges: ResolvedEdge[];
  opaque: Map<string, { id: string; name: string; target: string }>;
} {
  const edges: ResolvedEdge[] = [];
  const opaque = new Map<string, { id: string; name: string; target: string }>();

  const refTo = (objectId: string, column?: string): LineageRef | undefined => {
    const loaded = graph.get(objectId);
    if (!loaded) return undefined;
    const object = loaded.object;
    return {
      objectId,
      objectName: object.name,
      kind: object.kind,
      ...("model" in object && object.model ? { model: object.model } : {}),
      ...(column ? { column } : {}),
    };
  };

  const push = (
    from: LineageRef | undefined,
    to: LineageRef | undefined,
    rest: Omit<LineageEdge, "from" | "to">,
  ): void => {
    if (!from || !to) return;
    edges.push({
      from,
      to,
      ...rest,
      fromKey: key(from.objectId, from.column),
      toKey: key(to.objectId, to.column),
    });
  };

  for (const loaded of graph.all()) {
    const object = loaded.object;
    const model = "model" in object ? object.model : undefined;
    const ctx = model ? { model } : {};

    if (object.kind === "mapping") {
      const mapping = object as Mapping;
      const target = graph.resolve(mapping.target, ctx)?.target;
      if (!target) continue;

      if (mapping.customSql) {
        opaque.set(mapping.id, { id: mapping.id, name: mapping.name, target: target.object.name });
      }

      /** alias → source object, so `s.customer_id` can be resolved to a real column. */
      const byAlias = new Map<string, string>();
      for (const source of mapping.sources) {
        const resolved = graph.resolve(source.ref, ctx)?.target;
        if (resolved) byAlias.set(source.alias.toLowerCase(), resolved.object.id);
      }

      for (const columnMapping of mapping.columnMappings) {
        for (const reference of columnMapping.sources) {
          /*
            `alias.column`, or a bare column when the mapping has a single source.

            Splitting on the *first* dot rather than the last: a nested target is
            `alias.struct.field`, and taking the last dot would read `struct` as the alias.
          */
          const dot = reference.indexOf(".");
          const alias = dot === -1 ? [...byAlias.keys()][0] : reference.slice(0, dot).toLowerCase();
          const column = dot === -1 ? reference : reference.slice(dot + 1);
          const sourceId = alias ? byAlias.get(alias) : undefined;
          if (!sourceId) continue;

          push(refTo(sourceId, column), refTo(target.object.id, columnMapping.target), {
            kind: "mapping",
            via: { id: mapping.id, name: mapping.name },
            ...(columnMapping.expression ? { expression: columnMapping.expression } : {}),
            ...(columnMapping.rule ? { rule: columnMapping.rule } : {}),
          });
        }

        /*
          A target column with no sources still belongs in the graph.

          Surrogate keys, audit timestamps and constants are produced by the mapping itself.
          Omitting them would make the lineage view claim the column does not exist, which
          is the one thing worse than saying "generated here".
        */
        if (columnMapping.sources.length === 0 && columnMapping.expression) {
          push(
            refTo(mapping.id),
            refTo(target.object.id, columnMapping.target),
            {
              kind: "mapping",
              via: { id: mapping.id, name: mapping.name },
              expression: columnMapping.expression,
              ...(columnMapping.rule ? { rule: columnMapping.rule } : {}),
            },
          );
        }
      }
      continue;
    }

    if (object.kind === "table") {
      for (const fk of object.foreignKeys ?? []) {
        const parent = graph.resolve(fk.references.table, ctx)?.target;
        if (!parent) continue;

        // Positionally paired, which is how the metamodel defines them.
        fk.columns.forEach((childColumn, index) => {
          const parentColumn = fk.references.columns[index];
          push(
            refTo(parent.object.id, parentColumn),
            refTo(object.id, childColumn),
            { kind: "foreignKey" },
          );
        });
      }

      // Physical implements logical: the column claims an attribute, the table an entity.
      for (const column of object.columns ?? []) {
        if (!column.attributeRef) continue;
        const resolved = graph.resolve(column.attributeRef, ctx);
        if (!resolved) continue;
        push(
          refTo(resolved.target.object.id, resolved.memberPath),
          refTo(object.id, column.name),
          { kind: "implements" },
        );
      }

      if (object.entityRef) {
        const entity = graph.resolve(object.entityRef, ctx)?.target;
        push(refTo(entity?.object.id ?? ""), refTo(object.id), { kind: "implements" });
      }
      continue;
    }

    if (object.kind === "model" && object.derivedFrom) {
      const parent = graph.resolve(object.derivedFrom, {})?.target;
      push(refTo(parent?.object.id ?? ""), refTo(object.id), { kind: "derivedFrom" });
    }
  }

  return { edges, opaque };
}

/**
 * Walk the edge set from one point, in one direction.
 *
 * Breadth-first with a visited set, so a cycle, two mappings that feed each other, which a
 * real warehouse does have, terminates instead of recursing forever.
 */
function walk(
  edges: ResolvedEdge[],
  start: string[],
  direction: "upstream" | "downstream",
  maxDepth: number,
): { edges: ResolvedEdge[]; depth: number; truncated: boolean; distances: Map<string, number> } {
  const index = new Map<string, ResolvedEdge[]>();
  for (const edge of edges) {
    const from = direction === "downstream" ? edge.fromKey : edge.toKey;
    const bucket = index.get(from);
    if (bucket) bucket.push(edge);
    else index.set(from, [edge]);
  }

  const seen = new Set<string>(start);
  const distances = new Map<string, number>();
  const collected: ResolvedEdge[] = [];
  let frontier = [...start];
  let depth = 0;
  let truncated = false;

  while (frontier.length > 0) {
    if (depth >= maxDepth) {
      truncated = true;
      break;
    }
    depth += 1;
    const next: string[] = [];

    for (const node of frontier) {
      for (const edge of index.get(node) ?? []) {
        collected.push(edge);
        const other = direction === "downstream" ? edge.toKey : edge.fromKey;
        if (seen.has(other)) continue;
        seen.add(other);
        distances.set(other, depth);
        next.push(other);

        /*
          A column edge also reaches its table.

          Without this, asking about `stg_customer.email_address` would find the mapping
          that consumes it but never reach `dim_customer` itself, so "what breaks" would
          miss the table whose shape actually changes.
        */
        const bare = other.includes("::") ? other.slice(0, other.indexOf("::")) : undefined;
        if (bare && !seen.has(bare)) {
          seen.add(bare);
          distances.set(bare, depth);
          next.push(bare);
        }
      }
    }

    frontier = next;
  }

  return { edges: collected, depth, truncated, distances };
}

function focusRef(graph: ObjectGraph, objectId: string, column?: string): LineageRef | undefined {
  const loaded = graph.get(objectId);
  if (!loaded) return undefined;
  const object = loaded.object;
  return {
    objectId,
    objectName: object.name,
    kind: object.kind,
    ...("model" in object && object.model ? { model: object.model } : {}),
    ...(column ? { column } : {}),
  };
}

/** Everything that feeds, or is fed by, one object or column. */
export function lineage(
  graph: ObjectGraph,
  objectId: string,
  options: { column?: string; direction?: "upstream" | "downstream"; depth?: number } = {},
): LineageResult | undefined {
  const focus = focusRef(graph, objectId, options.column);
  if (!focus) return undefined;

  const direction = options.direction ?? "upstream";
  const { edges, opaque } = buildEdges(graph);

  /**
   * Asking about a table means asking about everything in it.
   *
   * Foreign-key and mapping edges are column-keyed, so a bare table id has no outgoing
   * edges at all, walking from it alone reported that dropping `dim_customer` affects
   * nothing, while dropping one of its columns correctly reported two breakages. Seeding
   * with the table *and* each of its columns is what makes the table-level question mean
   * "any of this changes" rather than "the table object itself is referenced".
   */
  const start = [key(objectId, options.column)];
  if (!options.column) {
    const object = graph.get(objectId)?.object;
    const members =
      object?.kind === "table"
        ? (object.columns ?? []).map((column) => column.name)
        : object?.kind === "entity"
          ? (object.attributes ?? []).map((attribute) => attribute.name)
          : [];
    for (const member of members) start.push(key(objectId, member));
  }

  const result = walk(edges, start, direction, Math.min(options.depth ?? MAX_DEPTH, MAX_DEPTH));

  /** Distinct objects, keyed by object+column so a table and its column are both nodes. */
  const nodes = new Map<string, LineageRef>();
  const touched = new Set<string>();
  for (const edge of result.edges) {
    nodes.set(key(edge.from.objectId, edge.from.column), edge.from);
    nodes.set(key(edge.to.objectId, edge.to.column), edge.to);
    if (edge.via) touched.add(edge.via.id);
  }
  nodes.set(key(focus.objectId, focus.column), focus);

  return {
    focus,
    direction,
    edges: result.edges.map(({ fromKey: _f, toKey: _t, ...edge }) => edge),
    nodes: [...nodes.values()],
    depth: result.depth,
    truncated: result.truncated,
    // Only the opaque mappings actually reached, not every one in the workspace.
    opaque: [...opaque.values()].filter((entry) => touched.has(entry.id)),
  };
}

/**
 * What breaks if you change this, ranked.
 *
 * Downstream lineage plus a judgement about each hit. The judgement is the point: a list of
 * everything transitively downstream is technically an impact analysis and practically a
 * wall of names. What a reviewer needs is "these three break, these two need rewriting, the
 * rest just mention it".
 */
export function impact(
  graph: ObjectGraph,
  objectId: string,
  options: { column?: string; depth?: number } = {},
): ImpactResult | undefined {
  const result = lineage(graph, objectId, { ...options, direction: "downstream" });
  if (!result) return undefined;

  const entries = new Map<string, ImpactEntry>();

  for (const edge of result.edges) {
    const target = edge.to;
    const id = key(target.objectId, target.column);

    /*
      The focus never appears in its own impact list.

      With a table-level focus that means excluding *every* column of it, not just the bare
      id: a self-referencing foreign key would otherwise report the table as breaking itself,
      which is noise at best and alarming at worst.
    */
    if (target.objectId === objectId && (!options.column || id === key(objectId, options.column))) {
      continue;
    }

    const { severity, reason } = assess(edge, options.column);
    const distance = distanceOf(result, target);
    const existing = entries.get(id);

    // Keep the worst verdict for a given object: an object that both breaks and is merely
    // mentioned is a break, and reporting the milder one would bury it.
    if (!existing || rank(severity) > rank(existing.severity)) {
      entries.set(id, {
        ...target,
        distance,
        severity,
        reason,
        ...(edge.via ? { via: edge.via } : {}),
      });
    }
  }

  const list = [...entries.values()].sort(
    (a, b) => rank(b.severity) - rank(a.severity) || a.distance - b.distance || a.objectName.localeCompare(b.objectName),
  );

  const counts: Record<ImpactSeverity, number> = { breaks: 0, rewrites: 0, informational: 0 };
  for (const entry of list) counts[entry.severity] += 1;

  return {
    focus: result.focus,
    entries: list,
    counts,
    truncated: result.truncated,
    opaque: result.opaque,
  };
}

function rank(severity: ImpactSeverity): number {
  return severity === "breaks" ? 3 : severity === "rewrites" ? 2 : 1;
}

/** Distance of a node from the focus, defaulting to 1 for a direct edge. */
function distanceOf(result: LineageResult, ref: LineageRef): number {
  // The walk already computed these, but they are not on the public result; a direct edge
  // is distance 1 and anything reached only through another edge is at least 2. Recomputing
  // exactly would mean re-walking, and the ordering only needs the first hop distinguished.
  return result.edges.some(
    (edge) =>
      edge.to.objectId === ref.objectId &&
      edge.to.column === ref.column &&
      edge.from.objectId === result.focus.objectId,
  )
    ? 1
    : 2;
}

/**
 * How badly one edge is affected.
 *
 * The distinction that matters is between an edge that *reads the thing directly* and one
 * that merely sits downstream. Dropping a column breaks the mapping that selects it; a
 * table three hops away is affected but nobody has to edit it.
 */
function assess(edge: LineageEdge, column: string | undefined): { severity: ImpactSeverity; reason: string } {
  if (edge.kind === "foreignKey") {
    return {
      severity: "breaks",
      reason: `\`${edge.to.objectName}\` joins to this on a foreign key; changing it invalidates the constraint.`,
    };
  }

  if (edge.kind === "implements") {
    return {
      severity: "rewrites",
      reason: `\`${edge.to.objectName}\`${edge.to.column ? `.${edge.to.column}` : ""} declares that it implements this; the reference would need updating.`,
    };
  }

  if (edge.kind === "derivedFrom") {
    return {
      severity: "informational",
      reason: `\`${edge.to.objectName}\` is derived from this model.`,
    };
  }

  // A mapping edge. An expression means the SQL names the column, so it has to be edited by
  // hand; a straight passthrough only breaks if the column disappears.
  if (edge.expression) {
    return {
      severity: "rewrites",
      reason: `\`${edge.via?.name ?? "a mapping"}\` computes \`${edge.to.column ?? edge.to.objectName}\` with an expression that reads this: ${edge.expression}`,
    };
  }

  return {
    severity: "breaks",
    reason: column
      ? `\`${edge.via?.name ?? "a mapping"}\` selects this column into \`${edge.to.objectName}.${edge.to.column}\`.`
      : `\`${edge.via?.name ?? "a mapping"}\` reads this table.`,
  };
}
