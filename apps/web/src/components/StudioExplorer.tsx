import { useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { api } from "../api";
import { iconFor } from "../app/CommandPalette";
import { Icon, type IconName } from "../ui";
import type { GraphView, MemberView, NodeView } from "../types";

/**
 * Everything in this model, as a tree you can navigate without leaving the canvas.
 *
 * The objects table answers "what is in here" well and "where is it" badly: it is a flat
 * list, so a table's columns are not in it at all, and finding `dim_customer.email` means
 * opening a dialog on `dim_customer` first. A tree holds both levels at once, which is why
 * every modelling tool has one docked beside the diagram.
 *
 * Two decisions worth stating, because the obvious alternatives are worse:
 *
 *   - **Grouped by kind, not by file.** A file tree is already available under the
 *     Repository toggle and answers a different question. Here the grouping is the
 *     metamodel's: tables, then the things that are not tables.
 *   - **Search matches columns too, and reveals them.** Typing `email` should find the
 *     column, not just tables whose *name* contains "email", because "which table has
 *     the email in it" is the actual question, and it is the one a flat object list
 *     cannot answer.
 */

/** An object with no box on the diagram: mappings, glossary terms, subject areas. */
interface OffCanvasObject {
  id: string;
  kind: string;
  name: string;
}

interface Props {
  graph: GraphView;
  model: string;
  refreshKey: number;
  selectedId?: string;
  selectedMember?: string;
  onSelect: (id: string) => void;
  /** Selecting a column selects its table *and* tells the canvas which row to highlight. */
  onSelectMember: (id: string, path: string | undefined) => void;
  /** Double-click, or Enter, open the object's own editor rather than just selecting it. */
  onOpen: (id: string) => void;
  filter: string;
}

export function StudioExplorer({
  graph,
  model,
  refreshKey,
  selectedId,
  selectedMember,
  onSelect,
  onSelectMember,
  onOpen,
  filter,
}: Props): JSX.Element {
  const [offCanvas, setOffCanvas] = useState<OffCanvasObject[]>([]);

  /**
   * The objects the graph does not carry.
   *
   * `graph.nodes` is only what the diagram can draw. Mappings, glossary terms, subject
   * areas and naming standards are two-thirds of the object kinds and none of them have a
   * box, so without this fetch the tree would claim a model with 40 objects has 12.
   */
  useEffect(() => {
    let cancelled = false;
    const onDiagram = new Set(graph.nodes.map((node) => node.id));

    api
      .listObjects({})
      .then((result) => {
        if (cancelled) return;
        setOffCanvas(
          result.items
            .filter((item) => item.model === model && !onDiagram.has(item.id))
            .map((item) => ({ id: item.id, kind: item.kind, name: item.name })),
        );
      })
      .catch(() => {
        if (!cancelled) setOffCanvas([]);
      });

    return () => {
      cancelled = true;
    };
    // `graph.nodes` is derived from the same fetch the parent already did; keying on its
    // length rather than the array avoids refetching on every position nudge.
  }, [model, refreshKey, graph.nodes.length]);

  const query = filter.trim().toLowerCase();

  /**
   * What survives the filter, and why a node survives.
   *
   * A node stays when its own name matches *or* any of its columns do, and in the second
   * case it opens automatically showing only the matching columns. Filtering to a table
   * and then making you expand it to find out which column matched is the behaviour that
   * makes people give up on tree search.
   */
  const nodes = useMemo(() => {
    if (!query) return graph.nodes.map((node) => ({ node, matchedMembers: undefined }));

    const result: { node: NodeView; matchedMembers: MemberView[] | undefined }[] = [];
    for (const node of graph.nodes) {
      const nameHit = node.name.toLowerCase().includes(query);
      const memberHits = node.members.filter((member) => member.name.toLowerCase().includes(query));
      if (nameHit) result.push({ node, matchedMembers: memberHits.length > 0 ? memberHits : undefined });
      else if (memberHits.length > 0) result.push({ node, matchedMembers: memberHits });
    }
    return result;
  }, [graph.nodes, query]);

  const others = useMemo(
    () => (query ? offCanvas.filter((item) => item.name.toLowerCase().includes(query)) : offCanvas),
    [offCanvas, query],
  );

  /** Off-canvas objects grouped by kind, so `mapping` and `glossaryTerm` get their own headings. */
  const byKind = useMemo(() => {
    const groups = new Map<string, OffCanvasObject[]>();
    for (const item of others) {
      const bucket = groups.get(item.kind);
      if (bucket) bucket.push(item);
      else groups.set(item.kind, [item]);
    }
    for (const bucket of groups.values()) bucket.sort((a, b) => a.name.localeCompare(b.name));
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [others]);

  const nothing = nodes.length === 0 && byKind.length === 0;

  if (nothing) {
    return (
      <p className="tree__empty muted small">
        {query ? `Nothing matches "${filter.trim()}".` : "This model has no objects yet."}
      </p>
    );
  }

  const primaryLabel = graph.model.tier === "physical" ? "Tables" : graph.model.tier === "logical" ? "Entities" : "Concepts";

  return (
    <div className="tree" role="tree" aria-label="Model objects">
      {nodes.length > 0 ? (
        <Group label={primaryLabel} count={nodes.length} defaultOpen>
          {nodes.map(({ node, matchedMembers }) => (
            <NodeBranch
              key={node.id}
              node={node}
              matchedMembers={matchedMembers}
              selected={node.id === selectedId}
              selectedMember={node.id === selectedId ? selectedMember : undefined}
              onSelect={onSelect}
              onSelectMember={onSelectMember}
              onOpen={onOpen}
              /* A search that matched a column has to show the column, or the match is invisible. */
              forceOpen={Boolean(matchedMembers)}
            />
          ))}
        </Group>
      ) : null}

      {byKind.map(([kind, items]) => (
        <Group key={kind} label={kindLabel(kind, items.length)} count={items.length} defaultOpen={Boolean(query)}>
          {items.map((item) => (
            <div
              key={item.id}
              role="treeitem"
              aria-selected={item.id === selectedId}
              tabIndex={0}
              className={`tree__row${item.id === selectedId ? " is-selected" : ""}`}
              onClick={() => onSelect(item.id)}
              onDoubleClick={() => onOpen(item.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onOpen(item.id);
                else if (event.key === " ") {
                  event.preventDefault();
                  onSelect(item.id);
                }
              }}
            >
              <span className="tree__indent" />
              <Icon name={iconFor(item.kind)} size={12} className="tree__kind" />
              <span className="tree__name truncate">{item.name}</span>
            </div>
          ))}
        </Group>
      ))}
    </div>
  );
}

/** One table or entity, with its columns underneath. */
function NodeBranch({
  node,
  matchedMembers,
  selected,
  selectedMember,
  onSelect,
  onSelectMember,
  onOpen,
  forceOpen,
}: {
  node: NodeView;
  matchedMembers: MemberView[] | undefined;
  selected: boolean;
  selectedMember: string | undefined;
  onSelect: (id: string) => void;
  onSelectMember: (id: string, path: string | undefined) => void;
  onOpen: (id: string) => void;
  forceOpen: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const expanded = open || forceOpen;
  const members = matchedMembers ?? node.members;

  return (
    <>
      <div
        role="treeitem"
        aria-selected={selected}
        aria-expanded={expanded}
        tabIndex={0}
        className={`tree__row${selected && !selectedMember ? " is-selected" : ""}`}
        onClick={() => onSelect(node.id)}
        onDoubleClick={() => onOpen(node.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onOpen(node.id);
          else if (event.key === "ArrowRight") setOpen(true);
          else if (event.key === "ArrowLeft") setOpen(false);
          else if (event.key === " ") {
            event.preventDefault();
            onSelect(node.id);
          }
        }}
      >
        <button
          type="button"
          className="tree__twist"
          aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
          disabled={node.members.length === 0}
          onClick={(event) => {
            // Without this the row's own click handler also fires and the disclosure
            // doubles as a selection, so expanding always moves the canvas selection too.
            event.stopPropagation();
            setOpen((value) => !value);
          }}
        >
          {node.members.length > 0 ? (
            <Icon name={expanded ? "chevronDown" : "chevronRight"} size={10} />
          ) : null}
        </button>

        <Icon name={iconFor(node.kind)} size={12} className="tree__kind" />
        <span className="tree__name truncate">{node.name}</span>
        {node.members.length > 0 ? <span className="tree__count">{node.members.length}</span> : null}
      </div>

      {expanded
        ? members.map((member) => (
            <div
              key={member.path}
              role="treeitem"
              aria-selected={selected && selectedMember === member.path}
              tabIndex={0}
              className={`tree__row tree__row--member${
                selected && selectedMember === member.path ? " is-selected" : ""
              }`}
              /* Nested STRUCT fields indent by their depth, so `address.postcode` reads as
                 living inside `address` rather than as a sibling of it. */
              style={{ paddingLeft: `calc(var(--s7) + ${member.depth * 10}px)` }}
              onClick={() => onSelectMember(node.id, member.path)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectMember(node.id, member.path);
                }
              }}
            >
              <span className={`tree__flag${member.isPrimaryKey ? " tree__flag--pk" : member.isForeignKey ? " tree__flag--fk" : ""}`}>
                {member.isPrimaryKey ? "PK" : member.isForeignKey ? "FK" : ""}
              </span>
              <span className="tree__name truncate">{member.name}</span>
              <span className="tree__type mono truncate">{member.type}</span>
              {member.classification ? (
                <Icon name="lock" size={10} className="tree__sensitive" />
              ) : null}
            </div>
          ))
        : null}
    </>
  );
}

/** A collapsible heading with a count. */
function Group({
  label,
  count,
  defaultOpen,
  children,
}: {
  label: string;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen ?? false);

  return (
    <section className="tree__group">
      <button type="button" className="tree__grouphead" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={10} />
        <span className="tree__grouplabel">{label}</span>
        <span className="tree__count">{count}</span>
      </button>
      {open ? children : null}
    </section>
  );
}

/**
 * Plural headings that read as English.
 *
 * `glossaryTerms` in a heading is a field name leaking into the interface; "Glossary
 * terms" is what the thing is called. The fallback pluralises rather than dropping to the
 * raw kind, so a metamodel addition still reads sanely before anyone updates this map.
 */
const KIND_PLURAL: Record<string, string> = {
  mapping: "Mappings",
  glossaryTerm: "Glossary terms",
  subjectArea: "Subject areas",
  namingStandard: "Naming standards",
  domain: "Attribute types",
  relationship: "Relationships",
  diagram: "Diagrams",
  concept: "Concepts",
  entity: "Entities",
  table: "Tables",
};

function kindLabel(kind: string, count: number): string {
  const known = KIND_PLURAL[kind];
  if (known) return known;
  const spaced = kind.replace(/([a-z])([A-Z])/g, "$1 $2");
  const title = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return count === 1 ? title : `${title}s`;
}

/** The panel's own header controls: a search box that filters the tree. */
export function ExplorerSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}): JSX.Element {
  return (
    <div className="tree__search">
      <Icon name="search" size={12} className="tree__searchicon" />
      <input
        className="input input--flush"
        value={value}
        placeholder="Search tables and columns…"
        aria-label="Search this model"
        onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <button type="button" className="tree__clear" aria-label="Clear search" onClick={() => onChange("")}>
          <Icon name="close" size={11} />
        </button>
      ) : null}
    </div>
  );
}

/** Re-exported so the panel header can show the same icon the tree uses. */
export const EXPLORER_ICON: IconName = "list";
