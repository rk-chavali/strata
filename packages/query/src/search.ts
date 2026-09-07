import { walkColumns, type ObjectGraph } from "@strata/metamodel";

/**
 * Search the whole workspace, not just object names.
 *
 * The palette already found objects by name, which answers the easy question. The questions it
 * could not answer are the ones people actually type: "which table has the email address in
 * it", "where did we write down what a chargeback is". Both need columns and descriptions in
 * the index, and neither is answerable from a list of object names.
 *
 * Faceted rather than one ranked list, because a hit on a *column* and a hit on a *description*
 * mean different things and lead to different places. Collapsing them would make the result
 * list shorter and less useful, you would have to read each row to work out what kind of match
 * it was.
 *
 * Scanned on demand rather than pre-indexed. A workspace is a few thousand objects held in
 * memory; a full scan is sub-millisecond, and an index would be a second source of truth to
 * keep in step with every edit.
 */

export type HitKind = "model" | "object" | "field" | "description" | "glossary";

export interface SearchHit {
  kind: HitKind;
  /** What matched, shown as the row's title. */
  label: string;
  objectId: string;
  objectName: string;
  objectKind: string;
  model?: string;
  /** For a field hit, the dotted path so the client can select it. */
  path?: string;
  /** The type, for a field; the tier, for a model. Shown as the row's meta line. */
  meta?: string;
  /** The matching text, trimmed around the match, for a description hit. */
  excerpt?: string;
  /** Lower is better. */
  score: number;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  /** Per-facet totals *before* the limit, so the UI can say "showing 20 of 84". */
  counts: Record<HitKind, number>;
  truncated: boolean;
}

const DEFAULT_LIMIT = 60;

/**
 * Rank a match by where it landed.
 *
 * An exact name is what you meant; a prefix is probably what you meant; a match buried in the
 * middle of a description is a guess. Without this the results are alphabetical by accident of
 * file order, and the thing you typed the full name of can sit below thirty partial matches.
 */
function scoreOf(haystack: string, needle: string, base: number): number {
  const lower = haystack.toLowerCase();
  if (lower === needle) return base;
  if (lower.startsWith(needle)) return base + 1;
  // Word-boundary match beats a match inside a word: `order` should rank `order_line` above
  // `reorder_flag`.
  if (new RegExp(`(^|[_\\s.-])${escapeRegex(needle)}`).test(lower)) return base + 2;
  return base + 3;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A window of text around the match, so a description hit shows why it matched. */
function excerptAround(text: string, needle: string, width = 90): string {
  const at = text.toLowerCase().indexOf(needle);
  if (at === -1) return text.slice(0, width);

  const start = Math.max(0, at - Math.floor((width - needle.length) / 2));
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

export function search(graph: ObjectGraph, rawQuery: string, limit = DEFAULT_LIMIT): SearchResult {
  const needle = rawQuery.trim().toLowerCase();
  const counts: Record<HitKind, number> = {
    model: 0,
    object: 0,
    field: 0,
    description: 0,
    glossary: 0,
  };

  if (needle.length < 2) {
    // One character matches most of a real model, which is not an answer.
    return { query: rawQuery, hits: [], counts, truncated: false };
  }

  const hits: SearchHit[] = [];
  const push = (hit: SearchHit): void => {
    counts[hit.kind] += 1;
    hits.push(hit);
  };

  for (const loaded of graph.all()) {
    const object = loaded.object;
    const model = "model" in object ? object.model : undefined;
    const common = {
      objectId: object.id,
      objectName: object.name,
      objectKind: object.kind,
      ...(model ? { model } : {}),
    };

    if (object.name.toLowerCase().includes(needle)) {
      if (object.kind === "model") {
        push({
          ...common,
          kind: "model",
          label: object.name,
          meta: `${object.tier}${object.namespace ? ` · ${object.namespace}` : ""}`,
          score: scoreOf(object.name, needle, 0),
        });
      } else {
        push({
          ...common,
          kind: object.kind === "glossaryTerm" ? "glossary" : "object",
          label: object.name,
          meta: object.kind,
          score: scoreOf(object.name, needle, 10),
        });
      }
    }

    /*
      A description hit is reported separately from a name hit on the same object.

      They are different answers: "the table is called this" and "the table is *about* this".
      Deduplicating them would hide the second whenever the first happened to also match.
    */
    if (object.description && object.description.toLowerCase().includes(needle)) {
      push({
        ...common,
        kind: "description",
        label: object.name,
        meta: object.kind,
        excerpt: excerptAround(object.description, needle),
        score: 40,
      });
    }

    if (object.kind === "glossaryTerm" && object.definition?.toLowerCase().includes(needle)) {
      push({
        ...common,
        kind: "glossary",
        label: object.name,
        meta: "glossary term",
        excerpt: excerptAround(object.definition, needle),
        score: 30,
      });
    }

    // Fields: the question a name-only search cannot answer.
    if (object.kind === "table") {
      for (const { column, path } of walkColumns(object.columns ?? [])) {
        if (column.name.toLowerCase().includes(needle)) {
          push({
            ...common,
            kind: "field",
            label: `${object.name}.${path}`,
            path,
            meta: column.dataType,
            score: scoreOf(column.name, needle, 20),
          });
        } else if (column.description?.toLowerCase().includes(needle)) {
          push({
            ...common,
            kind: "description",
            label: `${object.name}.${path}`,
            path,
            meta: column.dataType,
            excerpt: excerptAround(column.description, needle),
            score: 45,
          });
        }
      }
    }

    /*
      Mapping column rules are prose worth finding.

      "Email addresses are lower-cased so they compare reliably" is exactly the sentence
      someone searches for months later, and it lives on a `columnMapping.rule`, not on any
      object or column description. Leaving it out meant the model contained the answer and
      the search could not reach it.
    */
    if (object.kind === "mapping") {
      for (const columnMapping of object.columnMappings ?? []) {
        const haystack = `${columnMapping.rule ?? ""} ${columnMapping.expression ?? ""}`;
        if (!haystack.toLowerCase().includes(needle)) continue;
        push({
          ...common,
          kind: "description",
          label: `${object.name} → ${columnMapping.target}`,
          meta: "mapping rule",
          excerpt: excerptAround(columnMapping.rule ?? columnMapping.expression ?? "", needle),
          score: 46,
        });
      }
    }

    if (object.kind === "entity") {
      for (const attribute of object.attributes ?? []) {
        if (attribute.name.toLowerCase().includes(needle)) {
          push({
            ...common,
            kind: "field",
            label: `${object.name}.${attribute.name}`,
            path: attribute.name,
            meta: attribute.logicalType ?? attribute.domain ?? "",
            score: scoreOf(attribute.name, needle, 20),
          });
        } else if (attribute.description?.toLowerCase().includes(needle)) {
          push({
            ...common,
            kind: "description",
            label: `${object.name}.${attribute.name}`,
            path: attribute.name,
            excerpt: excerptAround(attribute.description, needle),
            score: 45,
          });
        }
      }
    }
  }

  hits.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));

  return {
    query: rawQuery,
    hits: hits.slice(0, limit),
    counts,
    truncated: hits.length > limit,
  };
}
