import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { api, ApiError } from "../api";
import { Page } from "../app/Page";
import { useWorkspace } from "../app/WorkspaceContext";
import {
  Badge,
  Button,
  Callout,
  Dialog,
  EmptyState,
  Icon,
  Loading,
  Segmented,
  useFeedback,
} from "../ui";

/**
 * Generated artefacts: BigQuery DDL and CODEOWNERS.
 *
 * Preview before writing, always. This creates files in the user's repository, and seeing
 * exactly what lands, before it lands, is what makes it safe to run. Everything here is
 * a *new* file; nothing generated ever edits something a human wrote.
 *
 * The list is a **changeset, not an inventory**. A team that already keeps its DDL in the
 * repo regenerates the same fifty files every time, and a list where forty-eight are
 * identical hides the two that matter. Comparing against what is on disk turns "here are
 * your files" into "here is what would change", which is the only version worth reading.
 */

type GeneratedFile = {
  path: string;
  kind: string;
  contents: string;
  status: "new" | "modified" | "unchanged";
};

export function OutputPage({
  /**
   * Generate for one model only, and hide the scope picker.
   *
   * Passed when this renders as a tab inside a model, where the scope is already decided by
   * where you are, offering a picker there would let you stand on `retail_warehouse` and
   * generate something else, which is the kind of control that produces a confusing diff.
   */
  model,
}: {
  model?: string;
} = {}): JSX.Element {
  const ui = useFeedback();
  const { canEdit, refresh, refreshKey, workspace } = useWorkspace();

  const [files, setFiles] = useState<GeneratedFile[] | undefined>();
  const [folder, setFolder] = useState("DDL");
  /**
   * What is being generated.
   *
   * Two targets, not one panel with a checkbox, because they answer different questions
   * and land in different repositories: DDL describes what the tables *are*, SQLX
   * describes how they are *filled*. A team frequently owns one and not the other, and
   * mixing both into a single changeset would make either one harder to review.
   */
  const [target, setTarget] = useState<"ddl" | "dataform">("ddl");
  const [scope, setScope] = useState<string>(model ?? "");
  const [showAll, setShowAll] = useState(false);
  const [preview, setPreview] = useState<{ path: string; contents: string } | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const physicalModels = (workspace?.models ?? []).filter((model) => model.tier === "physical");

  const load = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const request = scope ? { model: scope } : {};
      const result =
        target === "dataform"
          ? await api.generateDataform(request)
          : await api.generateDdl(request);
      setFiles(result.files);
      setFolder(result.folder);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      setFiles([]);
    } finally {
      setBusy(false);
    }
  }, [scope, target]);

  // Refetch when the scope changes or anything is written, or the page shows a preview of a
  // model you stopped looking at ten minutes ago.
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const write = useCallback(async () => {
    setBusy(true);
    const request = { ...(scope ? { model: scope } : {}), write: true };
    const result = await ui.attempt(
      () => (target === "dataform" ? api.generateDataform(request) : api.generateDdl(request)),
      "Could not generate",
    );
    setBusy(false);
    if (!result) return;
    ui.toast({
      tone: "success",
      message:
        result.written === 0
          ? "Everything already matches the model."
          : `Wrote ${result.written} file(s) into ${result.folder}. Review them in Changes, then propose.`,
    });
    refresh();
  }, [refresh, scope, target, ui]);

  const writeCodeowners = useCallback(async () => {
    const result = await ui.attempt(() => api.generateCodeowners(true), "Could not generate");
    if (!result) return;
    ui.toast({
      tone: "success",
      message: "Wrote CODEOWNERS. Combined with branch protection, that enforces approvals.",
    });
    refresh();
  }, [refresh, ui]);

  const changed = (files ?? []).filter((file) => file.status !== "unchanged");
  const unchanged = (files ?? []).length - changed.length;
  const visible = showAll ? (files ?? []) : changed;

  /**
   * Embedded in a model, or a page of its own.
   *
   * When `model` is set this renders as a tab inside the model's page, which already has a
   * header, wrapping it in a second `Page` would stack two titles and two action rows. The
   * controls move into a plain toolbar row above the content instead, and nothing else about
   * the view changes.
   */
  const toolbar = (
    <>
          <Segmented
            value={target}
            onChange={(next) => setTarget(next as "ddl" | "dataform")}
            options={[
              { value: "ddl", label: "DDL", title: "CREATE TABLE and policy tags" },
              {
                value: "dataform",
                label: "Dataform",
                title: "SQLX pipelines built from the mappings",
              },
            ]}
          />

          {!model && physicalModels.length > 1 ? (
            <Segmented
              value={scope}
              onChange={setScope}
              options={[
                { value: "", label: "All" },
                ...physicalModels.map((model) => ({ value: model.name, label: model.name })),
              ]}
            />
          ) : null}
      <Button icon="refresh" variant="ghost" disabled={busy} onClick={() => void load()}>
        Refresh
      </Button>
    </>
  );

  /**
   * Why there is nothing to show, and what to do about it.
   *
   * DDL needs a physical model. Dataform needs a physical model *and* a connection in
   * `strata.config.yaml` *and* mappings that say how each layer is derived. Three preconditions,
   * three different fixes, so three different messages.
   */
  const emptyReason = (): JSX.Element => {
    if (physicalModels.length === 0) {
      return (
        <EmptyState
          icon="doc"
          title="Nothing to generate"
          body="Generated output comes from physical models, the tier that names datasets, tables and BigQuery types. This workspace has none yet, so there is nothing to emit."
          action={
            <Button icon="plus" variant="primary" onClick={() => window.history.back()}>
              Add a physical model
            </Button>
          }
        />
      );
    }

    if (target === "dataform" && (workspace?.dataform.length ?? 0) === 0) {
      return (
        <EmptyState
          icon="doc"
          title="No Dataform connection yet"
          body="SQLX is generated for a Dataform repository, and this workspace does not name one. Add a `dataform` entry to strata.config.yaml with the repository and its GCP project, then generate again. DDL needs no connection and works already."
        />
      );
    }

    if (target === "dataform") {
      return (
        <EmptyState
          icon="doc"
          title="No mappings to generate from"
          body="SQLX comes from the mappings between layers, which say how each table is derived from the one before it. This model has a Dataform connection but no mappings yet, so there is nothing to emit."
        />
      );
    }

    return (
      <EmptyState
        icon="doc"
        title="Nothing to generate"
        body="This model has no tables to emit DDL for."
      />
    );
  };

  const body = (
    <>
      {files === undefined ? (
        <Loading label="Generating a preview…" />
      ) : (
        <div className="stack">
          {error ? <Callout tone="err">{error}</Callout> : null}

          {/*
            Empty has three different causes, and saying the wrong one reads as a broken feature.

            This message used to assert "this workspace has no physical models" no matter why the
            result was empty. Standing on a physical model and being told it does not exist is the
            kind of wrongness that makes somebody file a bug against a feature that is working
            correctly. It happened.

            So the reason is derived rather than assumed, and each one names the next step.
          */}
          {files.length === 0 && !error ? emptyReason() : null}

          {files.length > 0 ? (
            <>
              {changed.length === 0 ? (
                <Callout tone="ok" title="Up to date">
                  All {files.length} generated file(s) in <span className="mono">{folder}/</span>{" "}
                  already match the model. Nothing to write.
                </Callout>
              ) : (
                <Callout
                  tone="info"
                  title={`${changed.length} file${changed.length === 1 ? "" : "s"} would change`}
                  actions={
                    <>
                      <Button
                        icon="doc"
                        variant="primary"
                        disabled={!canEdit}
                        loading={busy}
                        onClick={() => void write()}
                      >
                        Write into the repo
                      </Button>
                      {unchanged > 0 ? (
                        <Button variant="ghost" onClick={() => setShowAll((value) => !value)}>
                          {showAll ? "Only changes" : `Show all ${files.length}`}
                        </Button>
                      ) : null}
                    </>
                  }
                >
                  In <span className="mono">{folder}/</span>
                  {unchanged > 0 ? `, ${unchanged} already match.` : "."} Writing replaces only
                  these files; review the diff in Changes before proposing.
                </Callout>
              )}

              <div className="card">
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 44 }}>State</th>
                      <th>Path</th>
                      <th style={{ width: 120 }}>Kind</th>
                      <th style={{ width: 90 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((file) => (
                      <tr key={file.path}>
                        <td>
                          {file.status === "new" ? (
                            <Badge tone="ok" title="Not in the repo yet">
                              A
                            </Badge>
                          ) : file.status === "modified" ? (
                            <Badge tone="warn" title="Differs from what is on disk">
                              M
                            </Badge>
                          ) : (
                            <Badge title="Already matches">=</Badge>
                          )}
                        </td>
                        <td className="mono truncate-start" title={file.path}>
                          {file.path}
                        </td>
                        <td className="muted small">
                          <span className="row">
                            <Icon
                              name={
                                file.kind === "policyTags"
                                  ? "shield"
                                  : file.kind === "index"
                                    ? "doc"
                                    : "table"
                              }
                              size={13}
                            />
                            {file.kind}
                          </span>
                        </td>
                        <td className="table__actions">
                          <Button size="sm" variant="ghost" onClick={() => setPreview(file)}>
                            Preview
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          <div className="card">
            <div className="card__body row" style={{ alignItems: "flex-start" }}>
              <div className="grow stack" style={{ gap: "var(--s2)" }}>
                <strong style={{ fontSize: "var(--fs-sm)" }}>CODEOWNERS</strong>
                <p className="muted small">
                  Derived from ownership metadata on your models, so a change to a governed
                  model requires the right approver. Combined with <code>strata check</code> in
                  CI and branch protection, that is the whole governance loop, enforced by
                  the host, not by this app.
                </p>
              </div>
              <Button
                icon="shield"
                disabled={!canEdit}
                onClick={() => void writeCodeowners()}
              >
                Generate CODEOWNERS
              </Button>
            </div>
          </div>
        </div>
      )}

      {preview ? (
        <Dialog
          title={preview.path}
          size="xl"
          onClose={() => setPreview(undefined)}
          footer={<Button onClick={() => setPreview(undefined)}>Close</Button>}
        >
          <pre className="codeblock" style={{ maxHeight: "58vh" }}>
            {preview.contents}
          </pre>
        </Dialog>
      ) : null}
    </>
  );

  if (model) {
    return (
      <div className="stack">
        <div className="row output__bar">{toolbar}</div>
        {body}
      </div>
    );
  }

  return (
    <Page
      title="Generated output"
      subtitle={
        target === "dataform"
          ? "Dataform SQLX, derived from the mappings"
          : "BigQuery DDL and CODEOWNERS, derived from the physical model"
      }
      actions={toolbar}
    >
      {body}
    </Page>
  );
}
