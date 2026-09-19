import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { api, ApiError } from "../api";
import { Page } from "../app/Page";
import { iconFor } from "../app/CommandPalette";
import { useWorkspace } from "../app/WorkspaceContext";
import type { Route, Router } from "../app/routes";
import {
  Badge,
  Button,
  EmptyState,
  Icon,
  IconButton,
  Loading,
  Menu,
  MenuTrigger,
  Segmented,
  ViewToggle,
  useDismiss,
  useFeedback,
  type MenuEntry,
} from "../ui";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { DiagnosticsDock } from "../components/DiagnosticsDock";
import { DictionaryGrid } from "../components/DictionaryGrid";
import { diagramToSvg, download, svgToPngBlob } from "../components/exportDiagram";
import { ErdCanvas, type AlignAxis, type CanvasHandle, type SelectionInfo } from "../components/ErdCanvas";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { PropertiesEmpty, PropertiesPanel } from "../components/PropertiesPanel";
import { ExplorerSearch, StudioExplorer } from "../components/StudioExplorer";
import { PanelSpine, StudioPanel, usePanelOpen, usePanelWidth } from "../components/StudioPanel";
import { FormatToolbar } from "../components/FormatToolbar";
import { ObjectDialog } from "../components/ObjectDialog";
import { RelateDialog } from "../components/RelateDialog";
import { RepositoryView } from "../components/RepositoryView";
import { HistoryList } from "../components/HistoryList";
import { OutputPage } from "./OutputPage";
import { ModelSettingsDialog } from "../components/ModelSettingsDialog";
import { SelectionToolbar } from "../components/SelectionToolbar";
import { ShapePalette, type Tool } from "../components/ShapePalette";
import {
  asNotation,
  NOTATIONS,
  NOTATION_HINT,
  NOTATION_LABEL,
  type Notation,
} from "../components/notation";
import { YamlDialog } from "../components/YamlDialog";
import type { DisplayLevel, MemberEdit } from "../components/EntityNode";
import type { Diagnostic, GraphView, NodeView, Tier } from "../types";
import { useShellActions } from "../app/AppShell";
import {
  addMemberStep,
  renameMemberStep,
  retypeMemberStep,
  useUndo,
} from "../app/useUndo";

/**
 * One model: its diagram, and its objects as a table.
 *
 * This is where the bulk of the old `App.tsx` went. Keeping the canvas callbacks next to
 * the canvas, rather than at the application root, threaded down through props, is what
 * lets the shell stay small and lets this page own its own selection state.
 *
 * The two tabs are not two views of one thing. The **diagram** is spatial: it answers "how
 * do these relate". The **objects** table is a list: it answers "what is in here, and which
 * of it is wrong". A modeller uses both, and the old explorer tried to be the second one
 * inside a 280px column while the canvas was the first.
 */

const TIER_LABEL: Record<Tier, string> = {
  conceptual: "Conceptual",
  logical: "Logical",
  physical: "Physical",
};

const DETAIL_OPTIONS: { value: DisplayLevel; label: string; title: string }[] = [
  { value: "entityOnly", label: "Names", title: "Box titles only" },
  { value: "keysOnly", label: "Keys", title: "Primary and foreign keys only" },
  { value: "attributes", label: "Fields", title: "Every field" },
  { value: "attributesWithTypes", label: "Types", title: "Every field with its type" },
];

interface Props {
  router: Router;
  route: Extract<Route, { name: "model" }>;
  /** Lifted so the shell's status bar can show the canvas's own state. */
  onStatusExtra: (node: JSX.Element | undefined) => void;
}

export function ModelPage({ router, route, onStatusExtra }: Props): JSX.Element {
  const ui = useFeedback();
  const { workspace, canEdit, refresh, refreshKey, write } = useWorkspace();

  const [graph, setGraph] = useState<GraphView | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [anchor, setAnchor] = useState<{ x: number; y: number } | undefined>();
  const [shapeSelection, setShapeSelection] = useState<SelectionInfo | undefined>();
  const [tool, setTool] = useState<Tool>("select");
  const [displayLevel, setDisplayLevel] = useState<DisplayLevel>("attributes");

  /**
   * The docked panels, and the column they are selected down to.
   *
   * Open state and width persist per person rather than per model: someone who works with
   * the explorer closed wants it closed on the next model too, and re-opening it on every
   * navigation is the behaviour that made the old floating explorer annoying enough to
   * remove.
   */
  const [explorerOpen, setExplorerOpen] = usePanelOpen("explorer", true);
  const [explorerWidth, setExplorerWidth] = usePanelWidth("explorer", 260);
  const [propsOpen, setPropsOpen] = usePanelOpen("properties", true);
  const [propsWidth, setPropsWidth] = usePanelWidth("properties", 300);
  const [explorerFilter, setExplorerFilter] = useState("");

  /** Which column of the selected object is in focus, as a member path. */
  const [selectedMember, setSelectedMember] = useState<string | undefined>();

  const [dockOpen, setDockOpen] = useState(false);

  /**
   * Undo, scoped to this model.
   *
   * Scoped rather than global because the stack holds inverse operations against specific
   * objects: carrying it across a navigation would let Ctrl+Z reverse an edit to a model you
   * are no longer looking at, with no visible effect on screen.
   */
  const undo = useUndo({
    scope: route.model,
    onChanged: refresh,
    onError: (message) => ui.toast({ tone: "error", message }),
    onDone: (message) => ui.toast({ tone: "success", message }),
  });

  /**
   * Every diagnostic in the workspace, so the dock can scope them to this model.
   *
   * The workspace summary carries counts only, which is enough for a badge and useless for
   * a list. Refetched on `refreshKey` so fixing an error makes it disappear from the dock
   * without a reload, the whole point of docking it beside the thing being fixed.
   */
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .diagnostics()
      .then((result) => {
        if (!cancelled) setDiagnostics(result.items);
      })
      .catch(() => {
        if (!cancelled) setDiagnostics([]);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  /** A new object means a new set of columns; keeping the old path selects a stale row. */
  useEffect(() => {
    setSelectedMember(undefined);
  }, [selectedId]);

  /**
   * The notation, held here and persisted to the diagram.
   *
   * Local state rather than reading `graph.diagram.notation` directly on every render, so
   * switching repaints in the same frame instead of after a write and a refetch, the
   * difference between a control that feels like a view toggle and one that feels like a
   * save. `undefined` means "whatever the diagram says", which is how a freshly loaded
   * diagram picks up its stored notation without this state having to be seeded.
   */
  const [notationOverride, setNotationOverride] = useState<Notation | undefined>();

  /**
   * Diagram or repository, the same model, rendered two ways.
   *
   * A toggle rather than a split. Halving a 1192px content area gives each side ~590px, and
   * an entity box is 260px wide, so a split diagram shows two boxes and a scrollbar. Both
   * views want the full width, which is why Harness toggles its console view instead of
   * docking it.
   */
  const [view, setView] = useState<"diagram" | "repository">("diagram");

  /**
   * The file the repository view opens on.
   *
   * This is what makes the toggle a *view* switch rather than a second navigation problem.
   * Harness's console view keeps you on the step you were looking at; here, selecting
   * `dim_customer` and toggling should land on `dim_customer.yaml`, not at the top of a
   * file tree you now have to search.
   *
   * The path is not on the graph, the canvas has no reason to know where an object is
   * stored, so it is fetched on demand from the object detail, once, at the moment of the
   * switch. Falling back to `undefined` is fine: the view opens on its empty state, which
   * explains what it is.
   */
  const [repoPath, setRepoPath] = useState<string | undefined>();

  const showRepository = useCallback(async () => {
    setView("repository");
    if (!selectedId) return;
    const detail = await api.object(selectedId).catch(() => undefined);
    if (detail?.file) setRepoPath(detail.file);
  }, [selectedId]);

  /**
   * A local switch wins; otherwise whatever the diagram was saved with.
   *
   * Reset when the diagram changes, so navigating from a diagram someone put in IDEF1X to
   * one saved as crow's foot shows the second one as it was stored rather than inheriting
   * the first one's override.
   */
  const notation = notationOverride ?? asNotation(graph?.diagram?.notation);

  useEffect(() => {
    setNotationOverride(undefined);
  }, [graph?.diagram?.id, route.model]);
  const [relate, setRelate] = useState<{ parentId: string; childId: string } | undefined>();
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | undefined>();
  const [yamlFor, setYamlFor] = useState<string | undefined>();
  const [inspecting, setInspecting] = useState<string | undefined>();
  /** The model's own settings, name, domain, tags, opened by the pencil in the title. */
  const [settingsOpen, setSettingsOpen] = useState(false);

  const canvasRef = useRef<CanvasHandle>(null);
  // The shell owns the single event stream; see the note on `ShellActions.presence`.
  const { presence } = useShellActions();

  const model = workspace?.models.find((candidate) => candidate.name === route.model);

  // ------------------------------------------------------------ load

  useEffect(() => {
    let cancelled = false;
    setLoadError(undefined);
    api
      .graph(route.model, route.diagram)
      .then((result) => {
        if (!cancelled) setGraph(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [route.model, route.diagram, refreshKey]);

  // Clear the selection when the model or diagram changes, an id from the previous graph
  // is meaningless here, and a stale selection puts the toolbar over empty space.
  useEffect(() => {
    setSelectedId(undefined);
    setShapeSelection(undefined);
  }, [route.model, route.diagram]);

  const selectedNode: NodeView | undefined = useMemo(
    () => graph?.nodes.find((node) => node.id === selectedId),
    [graph, selectedId],
  );

  // ------------------------------------------------------------ locks

  /**
   * Hold an advisory lock for as long as an editing dialog is open.
   *
   * A refused claim deliberately does not block the edit. The lock is a courtesy signal;
   * the revision check on save is what actually prevents a lost update. Anyone with the
   * editor role is entitled to change this object, and a colleague who left a tab open
   * should not be able to stop them.
   */
  const editingId = inspecting ?? yamlFor;
  useEffect(() => {
    if (!editingId || !canEdit || !presence.connectionId) return;

    void presence.claim(editingId).catch((err: unknown) => {
      if (err instanceof ApiError && err.isConflict) {
        ui.toast({
          title: "Someone else is in here",
          message: `${err.message}. You can still edit, if you both save, the second one gets a conflict rather than losing work.`,
          tone: "info",
          duration: 8000,
        });
      }
    });

    return () => presence.release(editingId);
  }, [editingId, canEdit, presence.connectionId, presence.claim, presence.release, ui]);

  // ------------------------------------------------------------ actions

  const handleRename = useCallback(
    (objectId: string, name: string) =>
      void write(async () => {
        const detail = await api.object(objectId);
        return api.updateObject(objectId, { ...detail.object, name }, detail.revision);
      }, "Rename failed"),
    [write],
  );

  const promptRename = useCallback(async () => {
    if (!selectedId || !selectedNode) return;
    const name = await ui.prompt({
      title: `Rename ${selectedNode.kind}`,
      label: "Name",
      initialValue: selectedNode.name,
      confirmLabel: "Rename",
    });
    if (name && name !== selectedNode.name) handleRename(selectedId, name);
  }, [handleRename, selectedId, selectedNode, ui]);

  const handleMemberEdit = useCallback(
    (objectId: string, edit: MemberEdit) => {
      const node = graph?.nodes.find((candidate) => candidate.id === objectId);
      const member = node?.members[edit.index];
      if (!member) return;

      void write(async () => {
        const result = await api.updateMember(objectId, {
          path: member.path,
          name: edit.name,
          type: edit.type,
        });

        /*
          Recorded only after the write succeeds, and only for what actually changed.

          Pushing before the request would put an entry on the stack for an edit that may have
          been rejected, and undoing *that* would apply a change nobody made.
        */
        if (edit.name && edit.name !== member.name) {
          undo.push(renameMemberStep(objectId, member.path, member.name, edit.name));
        } else if (edit.type && edit.type !== member.type) {
          undo.push(retypeMemberStep(objectId, member.path, member.type, edit.type));
        }
        return result;
      }, "Could not save that change");
    },
    [graph, write, undo],
  );

  const handleMemberAdd = useCallback(
    (objectId: string) =>
      void write(async () => {
        const result = await api.addMember(objectId);
        // The server mints the name, so the step has to be built from the response.
        undo.push(addMemberStep(objectId, result.name));
        return result;
      }, "Could not add"),
    [write, undo],
  );

  const handleDelete = useCallback(async () => {
    if (!selectedId || !selectedNode) return;
    const ok = await ui.confirm({
      title: `Delete ${selectedNode.kind}?`,
      message: `"${selectedNode.name}" will be removed. Review it in Changes before proposing.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    await write(() => api.deleteObject(selectedId), "Could not delete");
    setSelectedId(undefined);
  }, [selectedId, selectedNode, ui, write]);

  const handleCreate = useCallback(
    async (kind: string) => {
      const label = kind.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
      const name = await ui.prompt({
        title: `New ${label}`,
        label: "Name",
        placeholder: kind === "table" ? "dim_customer" : kind === "entity" ? "Customer" : "",
      });
      if (!name) return;

      const shared = kind === "domain" || kind === "namingStandard" || kind === "glossaryTerm";
      const created = await write(
        () => api.createObject({ kind, name, ...(shared ? {} : { model: route.model }) }),
        "Could not create",
      );

      if (!created?.object) return;
      if (kind === "diagram") {
        router.go({ name: "model", model: route.model, tab: "diagram", diagram: created.object.id });
      } else if (kind === "entity" || kind === "table" || kind === "concept") {
        setSelectedId(created.object.id);
      } else {
        // Everything else has no box on the canvas, so show its properties instead.
        setInspecting(created.object.id);
      }
    },
    [route.model, router, ui, write],
  );

  /**
   * Apply a formatting change to the selected shapes.
   *
   * Written straight to the diagram file, formatting is layout, so it never touches a
   * semantic file and never shows up as a model change in review.
   */
  const applyFormat = useCallback(
    (shapeIds: string[], patch: Record<string, unknown>) => {
      if (!graph) return;
      const ids = new Set(shapeIds);
      const next = graph.shapes.map((shape) =>
        ids.has(shape.id) ? { ...shape, format: { ...shape.format, ...patch } } : shape,
      );
      void write(() => api.saveLayout(route.model, { shapes: next }), "Could not apply formatting");
    },
    [graph, route.model, write],
  );

  /** Clear saved positions so the server's layered layout applies, then persist it. */
  const handleAutoLayout = useCallback(() => {
    if (!graph) return;
    void write(
      () =>
        api.saveLayout(route.model, {
          positions: graph.nodes.map((node) => ({ objectId: node.id, x: 0, y: 0 })),
        }),
      "Could not re-layout",
    );
  }, [graph, route.model, write]);

  /**
   * Act on a semantic edge.
   *
   * These change the model, not the drawing: deleting drops a foreign key or a
   * relationship object, and editing the label rewrites the verb phrase. Everything lands
   * in a file and shows up in the diff, which is why deletion asks first.
   */
  const handleEdgeCommand = useCallback(
    async (
      action: { type: string; edgeId: string; value?: string },
      edge: { kind: string; ownerId?: string; foreignKeyName?: string; label?: string },
    ) => {
      if (action.type === "delete") {
        const isForeignKey = edge.kind === "foreignKey";
        const ok = await ui.confirm({
          title: isForeignKey ? "Delete this foreign key?" : "Delete this relationship?",
          message: isForeignKey
            ? "The referencing column is kept, it may hold data, but the constraint and its assertion are removed."
            : "The relationship is removed. Attributes it migrated stay on the child entity.",
          confirmLabel: "Delete",
          danger: true,
        });
        if (!ok) return;

        if (isForeignKey && edge.ownerId && edge.foreignKeyName) {
          await write(
            () => api.deleteForeignKey(edge.ownerId as string, edge.foreignKeyName as string),
            "Could not delete",
          );
        } else if (edge.ownerId) {
          await write(() => api.deleteObject(edge.ownerId as string), "Could not delete");
        }
        return;
      }

      if (action.type === "label" && edge.kind === "relationship" && edge.ownerId) {
        const ownerId = edge.ownerId;
        void write(async () => {
          const detail = await api.object(ownerId);
          const parent = (detail.object.parent ?? {}) as Record<string, unknown>;
          return api.updateObject(
            ownerId,
            { ...detail.object, parent: { ...parent, verbPhrase: action.value || undefined } },
            detail.revision,
          );
        }, "Could not rename");
        return;
      }

      if (action.type === "cardinality" && edge.kind === "relationship" && edge.ownerId) {
        // Cycle rather than open a dialog: there are only four, and one click through them
        // is faster than a modal for a change this small.
        const ownerId = edge.ownerId;
        const order = ["zero-or-more", "one-or-more", "zero-or-one", "exactly-one"];
        void write(async () => {
          const detail = await api.object(ownerId);
          const child = (detail.object.child ?? {}) as Record<string, unknown>;
          const current = String(child.cardinality ?? "zero-or-more");
          const next = order[(order.indexOf(current) + 1) % order.length];
          return api.updateObject(
            ownerId,
            { ...detail.object, child: { ...child, cardinality: next } },
            detail.revision,
          );
        }, "Could not change cardinality");
        return;
      }

      if (action.type === "cardinality" && edge.kind === "foreignKey") {
        ui.toast({
          tone: "info",
          message:
            "A foreign key has no cardinality of its own, it is always many-to-one. Model it in the logical tier if you need to say more.",
        });
      }
    },
    [ui, write],
  );

  // ------------------------------------------------------------ context menus

  const openNodeMenu = useCallback(
    (event: React.MouseEvent, objectId: string, memberIndex?: number) => {
      event.preventDefault();
      event.stopPropagation();
      setSelectedId(objectId);

      const node = graph?.nodes.find((candidate) => candidate.id === objectId);
      const member = memberIndex === undefined ? undefined : node?.members[memberIndex];
      const memberWord = node?.kind === "table" ? "column" : "attribute";

      const items: MenuItem[] = member
        ? [
            { heading: member.path },
            {
              label: member.isPrimaryKey ? "Remove from primary key" : "Add to primary key",
              icon: "key",
              disabled: !canEdit || member.depth > 0,
              onSelect: () =>
                void write(() => api.toggleKey(objectId, member.name), "Could not change the key"),
            },
            {
              label: `Delete ${memberWord}`,
              icon: "trash",
              danger: true,
              disabled: !canEdit,
              onSelect: async () => {
                const ok = await ui.confirm({
                  title: `Delete ${memberWord}?`,
                  message: `"${member.path}" will be removed from ${node?.name}.`,
                  confirmLabel: "Delete",
                  danger: true,
                });
                if (ok) void write(() => api.deleteMember(objectId, member.path), "Could not delete");
              },
            },
            {},
            {
              label: "Edit object as YAML",
              icon: "code",
              disabled: !canEdit,
              onSelect: () => setYamlFor(objectId),
            },
          ]
        : [
            { heading: node?.name ?? "Object" },
            { label: "Rename", icon: "edit", disabled: !canEdit, onSelect: () => void promptRename() },
            {
              label: `Add ${memberWord}`,
              icon: "plus",
              disabled: !canEdit || (node?.kind !== "table" && node?.kind !== "entity"),
              onSelect: () => handleMemberAdd(objectId),
            },
            {
              label: "Properties",
              icon: "list",
              onSelect: () => setInspecting(objectId),
            },
            {
              label: "Edit as YAML",
              icon: "code",
              hint: "every field",
              disabled: !canEdit,
              onSelect: () => setYamlFor(objectId),
            },
            {},
            {
              label: "Delete",
              icon: "trash",
              danger: true,
              disabled: !canEdit,
              onSelect: () => void handleDelete(),
            },
          ];

      setMenu({ x: event.clientX, y: event.clientY, items });
    },
    [canEdit, graph, handleDelete, handleMemberAdd, promptRename, ui, write],
  );

  const openCanvasMenu = useCallback(
    (event: React.MouseEvent) => {
      const kind =
        model?.tier === "conceptual" ? "concept" : model?.tier === "logical" ? "entity" : "table";

      setMenu({
        x: event.clientX,
        y: event.clientY,
        items: [
          {
            label: `New ${kind}`,
            icon: kind === "table" ? "table" : "entity",
            disabled: !canEdit,
            onSelect: () => void handleCreate(kind),
          },
          {
            label: "New sticky note",
            icon: "note",
            disabled: !canEdit,
            onSelect: () => canvasRef.current?.addShape("note"),
          },
          {
            label: "New text",
            icon: "shapeText",
            disabled: !canEdit,
            onSelect: () => canvasRef.current?.addShape("text"),
          },
          {},
          { label: "Auto layout", icon: "grid", disabled: !canEdit, onSelect: handleAutoLayout },
          { label: "Fit to window", icon: "fit", onSelect: () => canvasRef.current?.fitView() },
        ],
      });
    },
    [canEdit, handleAutoLayout, handleCreate, model],
  );

  // ------------------------------------------------------------ keyboard

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      if (target && (/^(INPUT|TEXTAREA)$/.test(target.tagName) || target.isContentEditable)) return;

      /**
       * Delete acts on whichever kind of thing is selected.
       *
       * These are deliberately not the same operation. A shape is annotation, it lives
       * only in the diagram file, so it goes immediately. An entity or table is a governed
       * object whose removal shows up in a pull request, so it asks first.
       *
       * The shape branch used to be missing entirely: this handler required `selectedId`,
       * which is only ever set for entity nodes, so pressing Delete on a sticky note or a
       * text box did nothing here. React Flow's built-in delete then removed it from its
       * own state without persisting, which is why it reappeared on the next refetch.
       */
      if ((event.key === "Delete" || event.key === "Backspace") && canEdit) {
        if (shapeSelection) {
          event.preventDefault();
          canvasRef.current?.deleteSelectedShapes();
        } else if (selectedId) {
          event.preventDefault();
          void handleDelete();
        }
      }

      if (event.key === "Escape") {
        setSelectedId(undefined);
        setShapeSelection(undefined);
      }
    }

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canEdit, handleDelete, selectedId, shapeSelection]);

  // ------------------------------------------------------------ status bar

  /**
   * Contribute the diagram's shape to the shell's status bar.
   *
   * Only the counts. Zoom, fit and save state come through `canvasStatus` instead, * they change while you are working, and routing them through this state would
   * re-render the canvas on every wheel tick. Cleared on unmount so a count does not
   * survive a navigation to the problems page.
   */
  useEffect(() => {
    if (route.tab !== "diagram" || !graph) {
      onStatusExtra(undefined);
      return;
    }

    onStatusExtra(
      <span className="statusbar__item muted">
        {graph.nodes.length} box{graph.nodes.length === 1 ? "" : "es"} · {graph.edges.length}{" "}
        relationship{graph.edges.length === 1 ? "" : "s"}
      </span>,
    );

    return () => onStatusExtra(undefined);
  }, [graph, onStatusExtra, route.tab]);

  // ------------------------------------------------------------ render

  if (!model) {
    return (
      <Page title={route.model}>
        <EmptyState
          icon="warn"
          title="No such model"
          body={`Nothing in this workspace is called “${route.model}”. It may have been renamed, or the link may be from a different workspace.`}
          action={
            <Button variant="primary" icon="grid" onClick={() => router.go({ name: "overview" })}>
              Back to overview
            </Button>
          }
        />
      </Page>
    );
  }

  return (
    <Page
      /*
        The model's own name is the title.
        It used to be the *domain*, so the page for `retail_warehouse` was headed `retail`,
        the name of the thing you were editing appeared nowhere, and there was consequently
        nothing to put a rename control next to. The domain moved to the breadcrumb, where a
        parent scope belongs.
      */
      title={model.name}
      breadcrumb={[
        { label: "Models", onSelect: () => router.go({ name: "models" }) },
        ...(model.namespace
          ? [
              {
                label: model.namespace,
                onSelect: () => router.go({ name: "domain", domain: model.namespace as string, tab: "overview" }),
              },
            ]
          : []),
        { label: model.name },
      ]}
      onRename={canEdit ? () => setSettingsOpen(true) : undefined}
      tags={model.tags ?? []}
      meta={
        <>
          <span className="mono">{model.id}</span>
          <span>·</span>
          <span>
            {model.objectCount} object{model.objectCount === 1 ? "" : "s"}
          </span>
          {model.derivedFrom ? (
            <>
              <span>·</span>
              <span>derived from {model.derivedFrom}</span>
            </>
          ) : null}
          {model.description ? (
            <>
              <span>·</span>
              <span>{model.description}</span>
            </>
          ) : null}
        </>
      }
      badge={
        <>
          <span className={`dot dot--${model.tier}`} />
          <Badge tone="neutral">{TIER_LABEL[model.tier]}</Badge>
          {graph?.diagram && route.tab === "diagram" ? (
            <Badge tone="accent">{graph.diagram.name}</Badge>
          ) : null}
        </>
      }
      /*
        The tiers of this domain, top-right, the same slot and the same job as Harness's
        `Pipeline Studio | Input Sets | Triggers | Execution History`: siblings of the thing
        you are looking at, not options that modify it. As a segmented control in the actions
        cluster it was indistinguishable from the display settings beside it, which is how
        "go to the logical model" ended up looking like a checkbox.
      */
      views={<TierSwitcher router={router} current={model.name} />}
      /*
        The one control that decides how the body is rendered, in the centre.
        Harness gives `VISUAL | YAML` the middle of the header for exactly this reason. It is
        not an action and it is not metadata, so it belongs in neither cluster, and putting
        it in one of them is how five unrelated controls became one strip of grey pills.
      */
      centre={
        route.tab === "diagram" ? (
          <ViewToggle
            value={view}
            onChange={(next) =>
              next === "repository" ? void showRepository() : setView("diagram")
            }
            options={[
              {
                value: "diagram",
                icon: "grid",
                text: "Diagram",
                label: "Diagram, the model as a picture",
              },
              {
                value: "repository",
                icon: "code",
                text: "Repository",
                label: "Repository, the same model as files in your git repo",
              },
            ]}
          />
        ) : undefined
      }
      tabs={{
        items: [
          { id: "diagram", label: "Studio", icon: "grid" },
          { id: "objects", label: "Objects", icon: "list", count: model.objectCount },
          /*
            The dictionary sits next to Objects because they are the same kind of thing, a list, not a picture. Objects answers "what is in here"; the dictionary goes a
            level deeper and answers "what does each field hold, and how sensitive is it".
            Only tables and entities have fields, so a model of nothing but glossary terms
            would show an empty grid, which is correct, and says so.
          */
          { id: "dictionary", label: "Dictionary", icon: "doc" },
          /*
            Only the physical tier generates anything.
            DDL and SQLX come from tables, datasets and BigQuery types, none of which a
            conceptual or logical model has, so the tab is absent there rather than present
            and empty, which would read as "generation is broken for this model".
          */
          ...(model.tier === "physical"
            ? [{ id: "output" as const, label: "Output", icon: "doc" as const }]
            : []),
          { id: "history", label: "History", icon: "branch" },
        ],
        active: route.tab,
        onSelect: (tab) => router.go({ name: "model", model: route.model, tab }),
      }}
      flush={route.tab === "diagram"}
      /*
        Actions only. Detail level and notation used to sit here; they are canvas *display*
        options and now live on the canvas toolbar with the drawing tools, which is where
        Harness keeps the equivalent, nothing that only changes how the picture is drawn is
        in its header at all.
      */
      actions={
        <>
          {/*
            Export sits next to New rather than inside a kebab, because it is the action people
            come to this page to perform on behalf of someone else, a reviewer, an auditor,
            a slide. Burying it costs more than the header space it takes.
          */}
          <ExportMenu
            model={route.model}
            graph={graph}
            displayLevel={displayLevel}
            onError={(message) => ui.toast({ tone: "error", message })}
          />
          {canEdit ? (
            <NewObjectMenu tier={model.tier} onCreate={(kind) => void handleCreate(kind)} />
          ) : null}
        </>
      }
    >
      {route.tab === "output" ? (
        <OutputPage model={route.model} />
      ) : route.tab === "history" ? (
        /*
          What has landed on this model, most recent first.
          The counterpart to Harness's execution history: the same object, but its record
          rather than its current state. Scoped to this model's files, so a change to a
          sibling tier does not appear here.
        */
        <HistoryList model={route.model} limit={30} refreshKey={refreshKey} />
      ) : route.tab === "dictionary" ? (
        <DictionaryGrid
          model={route.model}
          refreshKey={refreshKey}
          canEdit={canEdit}
          /*
            Opening a field's object goes to the studio with it selected, rather than to a
            dialog. The grid is where you notice something is wrong; the studio is where you
            look at it in context.
          */
          onOpenObject={(id) => {
            setSelectedId(id);
            router.go({ name: "model", model: route.model, tab: "diagram" });
          }}
        />
      ) : route.tab === "objects" ? (
        <ObjectsTable
          model={route.model}
          onInspect={setInspecting}
          onEditYaml={setYamlFor}
          onSwitchToDiagram={() =>
            router.go({ name: "model", model: route.model, tab: "diagram" })
          }
          canEdit={canEdit}
        />
      ) : view === "repository" ? (
        /*
          The same model, as the files it actually is.
          Keyed on the path so switching selection on the diagram and toggling back re-opens
          the right file rather than reusing the previous editor's state.
        */
        <RepositoryView
          {...(repoPath ? { initialPath: repoPath } : {})}
          onPathChange={setRepoPath}
        />
      ) : loadError ? (
        <div style={{ padding: "var(--s7)" }}>
          <EmptyState
            icon="warn"
            title="Could not load the diagram"
            body={loadError}
            action={<Button variant="primary" icon="refresh" onClick={refresh}>Retry</Button>}
          />
        </div>
      ) : !graph ? (
        <Loading label="Loading the diagram…" />
      ) : (
        <div className="studio">
          {/*
            The explorer, docked left.

            Collapses to a labelled spine rather than to nothing. A panel that disappears
            entirely needs a menu item to get back, and the menu item is what nobody finds.
          */}
          {explorerOpen ? (
            <StudioPanel
              side="left"
              title="Explorer"
              icon="list"
              width={explorerWidth}
              onWidthChange={setExplorerWidth}
              onClose={() => setExplorerOpen(false)}
              sticky={<ExplorerSearch value={explorerFilter} onChange={setExplorerFilter} />}
            >
              <StudioExplorer
                graph={graph}
                model={route.model}
                refreshKey={refreshKey}
                {...(selectedId ? { selectedId } : {})}
                {...(selectedMember ? { selectedMember } : {})}
                onSelect={setSelectedId}
                onSelectMember={(id, path) => {
                  setSelectedId(id);
                  setSelectedMember(path);
                  // Selecting a column is also a request to see it, so make sure the panel
                  // that shows it is actually open.
                  if (!propsOpen) setPropsOpen(true);
                }}
                onOpen={(id) => {
                  setSelectedId(id);
                  if (!propsOpen) setPropsOpen(true);
                }}
                filter={explorerFilter}
              />
            </StudioPanel>
          ) : (
            <PanelSpine side="left" title="Explorer" icon="list" onOpen={() => setExplorerOpen(true)} />
          )}

          <div className="studio__centre">
            <div className="canvas-wrap studio__canvas">
              {/*
                Above the canvas, not on top of it. `.canvas-wrap` is a flex column, so the
                palette takes a row and the canvas takes the rest, which is why this has to
                come first in the markup rather than after the canvas as it used to, when it
                was absolutely positioned and source order did not matter.
              */}
              {/*
                Tools on the left, display options on the right, in one canvas-scoped bar.

                Detail level and notation used to sit in the page header beside the mode switch
                and the tier navigation, where four unrelated decisions read as one strip of grey
                pills. They only ever affect how the canvas draws, so they belong to the canvas, and being here they disappear for free in the repository view and on every other
                tab, without a condition to maintain.
              */}
              <div className="canvasbar">
                <ShapePalette tool={tool} onToolChange={setTool} disabled={!canEdit} />

                {/*
                  Undo lives with the tools rather than in the page header, because it undoes
                  what the tools did. The tooltip names the operation, so Ctrl+Z is never a guess.
                */}
                <span className="canvasbar__undo">
                  <IconButton
                    icon="refresh"
                    label={undo.nextUndo ? `Undo ${undo.nextUndo}` : "Nothing to undo"}
                    size="sm"
                    disabled={!undo.canUndo}
                    onClick={() => void undo.undo()}
                  />
                  {/* Mirrored via a wrapper, because IconButton takes no className. */}
                  <span className="is-flipped">
                    <IconButton
                      icon="refresh"
                      label={undo.nextRedo ? `Redo ${undo.nextRedo}` : "Nothing to redo"}
                      size="sm"
                      disabled={!undo.canRedo}
                      onClick={() => void undo.redo()}
                    />
                  </span>
                </span>

                <div className="canvasbar__view">
                  <Segmented
                    value={displayLevel}
                    onChange={setDisplayLevel}
                    options={DETAIL_OPTIONS}
                  />
                  <NotationSwitcher
                    value={notation}
                    canEdit={canEdit}
                    onChange={(next) => {
                      // Paint first, persist second. The write is a merge into the diagram on
                      // disk, so it cannot overwrite a colleague's box moves.
                      setNotationOverride(next);
                      void write(
                        () => api.saveLayout(route.model, { notation: next }),
                        "Could not save the notation",
                      );
                    }}
                  />
                </div>
              </div>

              <ErrorBoundary label="the diagram canvas" onRetry={refresh}>
                <ErdCanvas
                  ref={canvasRef}
                  key={`${graph.model.name}:${route.diagram ?? "all"}`}
                  graph={graph}
                  displayLevel={displayLevel}
                  notation={notation}
                  selectedId={selectedId}
                  canEdit={canEdit}
                  tool={tool}
                  snapToGrid
                  onToolUsed={() => setTool("select")}
                  onSelect={setSelectedId}
                  onChanged={refresh}
                  onMemberEdit={handleMemberEdit}
                  onMemberAdd={handleMemberAdd}
                  onRename={handleRename}
                  onContextMenu={openNodeMenu}
                  onCanvasContextMenu={openCanvasMenu}
                  onSelectionAnchor={setAnchor}
                  onShapeSelection={setShapeSelection}
                  onRelate={(parentId, childId) => setRelate({ parentId, childId })}
                  onEdgeCommand={handleEdgeCommand}
                  locks={presence.locks}
                  connectionId={presence.connectionId}
                />
              </ErrorBoundary>

              {selectedNode && anchor && !shapeSelection ? (
                <SelectionToolbar
                  x={anchor.x}
                  y={anchor.y}
                  kind={selectedNode.kind}
                  canEdit={canEdit}
                  onRename={() => void promptRename()}
                  onAddMember={() => handleMemberAdd(selectedNode.id)}
                  onEditYaml={() => setYamlFor(selectedNode.id)}
                  onDelete={() => void handleDelete()}
                />
              ) : null}

              {shapeSelection && canEdit ? (
                <FormatToolbar
                  x={shapeSelection.x}
                  y={shapeSelection.y}
                  format={shapeSelection.format}
                  selectionCount={shapeSelection.count}
                  onFormat={(patch) => applyFormat(shapeSelection.shapeIds, patch)}
                  onAlign={(axis: AlignAxis) => canvasRef.current?.alignSelection(axis)}
                  onDistribute={(axis) => canvasRef.current?.distributeSelection(axis)}
                  onDuplicate={() => canvasRef.current?.duplicateSelection()}
                  onDelete={() => canvasRef.current?.deleteSelectedShapes()}
                />
              ) : null}
            </div>

            {/*
              Problems, under the diagram rather than on their own page.

              Scoped to this model, so a broken reference in a sibling tier does not make
              this model look wrong.
            */}
            <DiagnosticsDock
              all={diagnostics}
              graph={graph}
              open={dockOpen}
              onOpenChange={setDockOpen}
              onSelect={(id) => {
                setSelectedId(id);
                if (!propsOpen) setPropsOpen(true);
              }}
              onFixed={refresh}
              canEdit={canEdit}
            />
          </div>

          {/* Properties, docked right, the panel that used to be a modal over the canvas. */}
          {propsOpen ? (
            <StudioPanel
              side="right"
              title="Properties"
              icon="settings"
              width={propsWidth}
              onWidthChange={setPropsWidth}
              onClose={() => setPropsOpen(false)}
            >
              {selectedId ? (
                <PropertiesPanel
                  key={selectedId}
                  objectId={selectedId}
                  {...(selectedNode ? { node: selectedNode } : {})}
                  {...(selectedMember ? { selectedMember } : {})}
                  onSelectMember={setSelectedMember}
                  onClose={() => setSelectedId(undefined)}
                  onSaved={refresh}
                  onEditYaml={setYamlFor}
                  onGoTo={setSelectedId}
                  canEdit={canEdit}
                />
              ) : (
                <PropertiesEmpty />
              )}
            </StudioPanel>
          ) : (
            <PanelSpine
              side="right"
              title="Properties"
              icon="settings"
              onOpen={() => setPropsOpen(true)}
            />
          )}
        </div>
      )}

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(undefined)} />
      ) : null}

      {inspecting ? (
        <ObjectDialog
          objectId={inspecting}
          onClose={() => setInspecting(undefined)}
          onSaved={refresh}
          onEditYaml={(id) => {
            setInspecting(undefined);
            setYamlFor(id);
          }}
        />
      ) : null}

      {yamlFor ? (
        <YamlDialog objectId={yamlFor} onClose={() => setYamlFor(undefined)} onSaved={refresh} />
      ) : null}

      {settingsOpen ? (
        <ModelSettingsDialog
          model={model}
          domains={
            [...new Set((workspace?.models ?? []).map((m) => m.namespace).filter(Boolean))] as string[]
          }
          onClose={() => setSettingsOpen(false)}
          onSaved={(name) => {
            setSettingsOpen(false);
            /*
              Follow the rename. The URL holds the model's name, so after renaming
              `retail_warehouse` the current route points at something that no longer
              exists, a reload would land on "no such model".
            */
            if (name !== model.name) {
              router.go({ name: "model", model: name, tab: route.tab }, { replace: true });
            }
            refresh();
          }}
        />
      ) : null}

      {relate && graph
        ? (() => {
            const parent = graph.nodes.find((node) => node.id === relate.parentId);
            const child = graph.nodes.find((node) => node.id === relate.childId);
            if (!parent || !child) return null;
            return (
              <RelateDialog
                modelName={model.name}
                tier={model.tier}
                parent={parent}
                child={child}
                onClose={() => setRelate(undefined)}
                onCreated={refresh}
              />
            );
          })()
        : null}
    </Page>
  );
}

// ---------------------------------------------------------------- tier switcher

/**
 * Move between the tiers of one domain.
 *
 * Kept beside the model's own title rather than in the global bar, because it is a
 * model-level control: it only means anything while a model is open, and in the top bar it
 * was permanently present and permanently ambiguous about what it applied to.
 */
/**
 * The notation the diagram is drawn in.
 *
 * A menu rather than a segmented control: four names plus a line of explanation each does
 * not fit on a toolbar, and the choice is made rarely, usually once per diagram, to match
 * whatever the reviewing audience is trained on. The explanation matters because "IDEF1X"
 * and "Barker" mean nothing to someone who has only seen crow's foot, and picking blind is
 * how you end up with a diagram nobody in the review can read.
 *
 * Read-only users still get the switcher. Notation is how the diagram is *displayed*; being
 * unable to save the preference is not a reason to be unable to read the diagram in the
 * notation you know.
 */
function NotationSwitcher({
  value,
  canEdit,
  onChange,
}: {
  value: Notation;
  canEdit: boolean;
  onChange: (notation: Notation) => void;
}): JSX.Element {
  const entries: MenuEntry[] = [
    { heading: "Notation" },
    ...NOTATIONS.map((candidate) => ({
      label: NOTATION_LABEL[candidate],
      meta: NOTATION_HINT[candidate],
      selected: candidate === value,
      onSelect: () => onChange(candidate),
    })),
  ];

  return (
    <MenuTrigger entries={entries} align="right" width={260}>
      {({ open, toggle }) => (
        <Button
          variant="default"
          size="sm"
          iconEnd="chevronDown"
          active={open}
          onClick={toggle}
          title={
            canEdit
              ? "The notation this diagram is drawn in, saved with the diagram"
              : "The notation this diagram is drawn in"
          }
        >
          {NOTATION_LABEL[value]}
        </Button>
      )}
    </MenuTrigger>
  );
}

function TierSwitcher({ router, current }: { router: Router; current: string }): JSX.Element | null {
  const { workspace } = useWorkspace();
  const model = workspace?.models.find((candidate) => candidate.name === current);
  if (!model) return null;

  const siblings = (workspace?.models ?? []).filter(
    (candidate) => (candidate.namespace ?? "") === (model.namespace ?? ""),
  );
  if (siblings.length < 2) return null;

  const order: Tier[] = ["conceptual", "logical", "physical"];
  const sorted = [...siblings].sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier));

  return (
    <Segmented
      value={current}
      onChange={(name) => router.go({ name: "model", model: name, tab: "diagram" })}
      options={sorted.map((candidate) => ({
        value: candidate.name,
        label: TIER_LABEL[candidate.tier],
        title: `${candidate.objectCount} objects`,
      }))}
    />
  );
}

// ---------------------------------------------------------------- new object

function NewObjectMenu({
  tier,
  onCreate,
}: {
  tier: Tier;
  onCreate: (kind: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  /**
   * What this tier can actually contain.
   *
   * Offering `table` inside a conceptual model is how you end up with a physical object in
   * the wrong tier and a validation error nobody understands. The menu only lists what
   * belongs here.
   */
  const primary =
    tier === "conceptual"
      ? { kind: "concept", label: "Concept" }
      : tier === "logical"
        ? { kind: "entity", label: "Entity" }
        : { kind: "table", label: "Table" };

  const entries: MenuEntry[] = [
    { heading: `In this ${tier} model` },
    { label: primary.label, icon: iconFor(primary.kind), onSelect: () => onCreate(primary.kind) },
    { label: "Diagram", icon: "grid", onSelect: () => onCreate("diagram") },
    { label: "Subject area", icon: "folder", onSelect: () => onCreate("subjectArea") },
    ...(tier === "physical"
      ? [{ label: "Mapping", icon: "flow" as const, onSelect: () => onCreate("mapping") }]
      : []),
    {},
    { heading: "Shared across models" },
    // "Attribute type", not "Domain": in this metamodel `domain` means a reusable column
    // definition, not a business area, and "domain" is already used for the namespace in
    // the sidebar, so the same word would mean two things on one screen.
    { label: "Attribute type", icon: "code", onSelect: () => onCreate("domain") },
    { label: "Glossary term", icon: "doc", onSelect: () => onCreate("glossaryTerm") },
    { label: "Naming standard", icon: "shield", onSelect: () => onCreate("namingStandard") },
  ];

  return (
    <div ref={ref} style={{ position: "relative", flex: "none" }}>
      <Button icon="plus" iconEnd="chevronDown" onClick={() => setOpen((value) => !value)}>
        New
      </Button>
      {open ? <Menu entries={entries} align="right" width={230} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------- export

/**
 * Take the model away: as a document, or as a picture.
 *
 * Four destinations rather than one "Export" button, because the four answers go to different
 * people. Markdown commits to the repo so a pull request shows what the model now says; HTML
 * goes in a wiki; SVG scales into a slide and stays searchable; PNG is what pastes into chat.
 *
 * The diagram exports need a loaded graph, so they are disabled rather than hidden when the
 * canvas has not finished loading, a control that appears and disappears reads as a glitch.
 */
function ExportMenu({
  model,
  graph,
  displayLevel,
  onError,
}: {
  model: string;
  graph: GraphView | undefined;
  displayLevel: DisplayLevel;
  onError: (message: string) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);

  async function docs(format: "markdown" | "html"): Promise<void> {
    setBusy(true);
    try {
      const result = await api.docs({ model, format });
      const file = result.files[0];
      if (!file) throw new Error("nothing was generated");
      download(
        file.path.split("/").pop() ?? `${model}.${format === "html" ? "html" : "md"}`,
        file.contents,
        format === "html" ? "text/html" : "text/markdown",
      );
    } catch (error) {
      onError(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function picture(kind: "svg" | "png"): Promise<void> {
    if (!graph) return;
    setBusy(true);
    try {
      // The export honours the canvas's current detail level, so what you exported matches
      // what you were looking at.
      const svg = diagramToSvg(graph, {
        detail: displayLevel === "entityOnly" ? "names" : displayLevel === "keysOnly" ? "keys" : "fields",
        types: displayLevel === "attributesWithTypes",
        title: graph.diagram?.name ?? model,
      });

      if (kind === "svg") download(`${model}.svg`, svg, "image/svg+xml");
      else download(`${model}.png`, await svgToPngBlob(svg));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const entries: MenuEntry[] = [
    { heading: "Data dictionary" },
    { label: "Markdown", icon: "doc", meta: "commits to the repo", onSelect: () => void docs("markdown") },
    { label: "HTML", icon: "doc", meta: "self-contained page", onSelect: () => void docs("html") },
    {},
    { heading: "Diagram" },
    { label: "SVG", icon: "grid", meta: "scales, text is searchable", disabled: !graph, onSelect: () => void picture("svg") },
    { label: "PNG", icon: "grid", meta: "2x, for slides and chat", disabled: !graph, onSelect: () => void picture("png") },
  ];

  return (
    <MenuTrigger entries={entries} align="right" width={250}>
      {({ open, toggle }) => (
        <Button icon="upload" iconEnd="chevronDown" active={open} disabled={busy} onClick={toggle}>
          {busy ? "Exporting…" : "Export"}
        </Button>
      )}
    </MenuTrigger>
  );
}

// ---------------------------------------------------------------- objects table

/**
 * Every object in the model, as a table.
 *
 * This is what the old explorer tree was trying to be, and it is much better as a table:
 * sortable, scannable, with the file path and the kind visible at once. Two-thirds of
 * object kinds, mappings, glossary terms, subject areas, naming standards, have no box on
 * a diagram at all, and this is the only place they were ever really visible.
 */
function ObjectsTable({
  model,
  onInspect,
  onEditYaml,
  onSwitchToDiagram,
  canEdit,
}: {
  model: string;
  onInspect: (id: string) => void;
  onEditYaml: (id: string) => void;
  onSwitchToDiagram: () => void;
  canEdit: boolean;
}): JSX.Element {
  const { refreshKey, git } = useWorkspace();
  const [items, setItems] = useState<
    { id: string; kind: string; name: string; model: string | null; file: string | null }[] | undefined
  >();
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .listObjects({})
      .then((result) => {
        if (!cancelled) setItems(result.items.filter((item) => item.model === model));
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [model, refreshKey]);

  const changed = new Set(git?.files.map((file) => file.path) ?? []);

  const visible = (items ?? []).filter((item) =>
    filter.trim() ? item.name.toLowerCase().includes(filter.trim().toLowerCase()) : true,
  );

  if (items === undefined) return <Loading label="Loading objects…" />;

  if (items.length === 0) {
    return (
      <EmptyState
        icon="list"
        title="This model is empty"
        body={
          canEdit
            ? "Use New above to add your first entity or table, or import a schema to populate the whole model in one step."
            : "Nothing has been modelled here yet. You need the editor role to add anything."
        }
        action={
          <Button variant="primary" icon="grid" onClick={onSwitchToDiagram}>
            Open the diagram
          </Button>
        }
      />
    );
  }

  return (
    <div className="stack">
      <div className="row">
        <span style={{ maxWidth: 320, flex: 1 }}>
          <input
            className="input"
            value={filter}
            placeholder="Filter by name…"
            aria-label="Filter objects by name"
            onChange={(event) => setFilter(event.target.value)}
          />
        </span>
        <span className="muted small">
          {visible.length} of {items.length}
        </span>
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 150 }}>Kind</th>
              <th>Name</th>
              <th>File</th>
              <th style={{ width: 110 }} />
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => (
              <tr key={item.id}>
                <td>
                  <span className="row muted small">
                    <Icon name={iconFor(item.kind)} size={13} />
                    {item.kind}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    className="link"
                    style={{ background: "none", padding: 0 }}
                    onClick={() => onInspect(item.id)}
                  >
                    {item.name}
                  </button>
                  {item.file && changed.has(item.file) ? (
                    <Badge tone="warn" title={`${item.file}, uncommitted`}>
                      M
                    </Badge>
                  ) : null}
                </td>
                <td className="mono muted truncate-start" style={{ maxWidth: 320 }}>
                  {item.file ?? ""}
                </td>
                <td className="table__actions">
                  <IconButton
                    icon="code"
                    label="Edit as YAML"
                    size="sm"
                    disabled={!canEdit}
                    onClick={() => onEditYaml(item.id)}
                  />
                  <IconButton
                    icon="list"
                    label="Properties"
                    size="sm"
                    onClick={() => onInspect(item.id)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
