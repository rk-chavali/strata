import { useMemo, useState } from "react";
import type { JSX } from "react";
import { api, ApiError } from "../api";
import { Button, Callout, Checkbox, Field, Icon, Input, Logo, Textarea } from "../ui";
import type { RootDiagnosis, Tier } from "../types";

/**
 * First run: create the model repo.
 *
 * **Why this page exists.** Before it, an instance started against an empty directory had
 * no route forward. Startup bootstrap skips when there is no repo to clone, `loadWorkspace`
 * throws, and the app showed "Cannot read the model repo" with instructions to go and run
 * `strata init`, from a shell the operator of a container may not have. The very first thing
 * the tool asked of a new user was to leave it and use something else.
 *
 * It also answers the complaint that this tool feels unlike the modelling tools people
 * arrive from. Those open on an explicit act of creation: name a model, choose a target
 * platform, pick a notation. That ceremony is not decoration, it
 * is where you learn what the tool thinks a model *is*, and what you are allowed to
 * change. Booting straight into a read-only example teaches none of it, so people poke at
 * someone else's diagram and never find out that the file layout is theirs to choose.
 *
 * So the flow states the two things that are genuinely unusual here, in the order they
 * matter: the model is files in git, and where those files sit is a decision you own and
 * can revisit at any time.
 *
 * Three steps, because each one maps to a decision that is awkward to change later, * except the last, which is deliberately skippable. Nobody should be forced to invent a
 * model name to get past a wizard.
 */

type Step = "workspace" | "layout" | "model";

const STEPS: { id: Step; label: string }[] = [
  { id: "workspace", label: "Workspace" },
  { id: "layout", label: "File layout" },
  { id: "model", label: "First model" },
];

/**
 * The layout choices worth offering on a first run.
 *
 * A deliberate subset. `LAYOUT_PRESETS` has nine entries including `custom`, and asking
 * someone to choose between `by-subject-area` and `by-layer` before they have written a
 * single entity is asking them to guess. These four span the actual range, everything in
 * one place, grouped by model, grouped by domain, one file per model, and the rest are
 * one click away in Settings once there is something to reorganise.
 *
 * Reorganising is genuinely free: object identity lives in file content, never in the
 * path, so switching preset is a pure file move that changes no meaning. Saying so here
 * is what makes the choice low-stakes rather than a fork in the road.
 */
const LAYOUTS: { preset: string; title: string; body: string; example: string }[] = [
  {
    preset: "by-model-and-kind",
    title: "By model, then kind",
    body: "Each model gets a directory, and its entities, tables and relationships are grouped by kind inside it. The default, and where most teams end up.",
    example: "models/retail/entities/customer.yaml",
  },
  {
    preset: "by-namespace",
    title: "By business domain, then tier",
    body: "Strongest isolation when several domains share one repository, each domain's conceptual, logical and physical models stay apart.",
    example: "models/sales/logical/customer.yaml",
  },
  {
    preset: "flat",
    title: "Flat",
    body: "Every object in one directory. Least ceremony, and perfectly reasonable until a model outgrows it.",
    example: "models/customer.yaml",
  },
  {
    preset: "single-file-per-model",
    title: "One file per model",
    body: "A single multi-document YAML file per model. Fewest files to manage, at the cost of larger diffs when two people edit the same model.",
    example: "models/retail.yaml",
  },
];

const TIERS: { tier: Tier; title: string; body: string }[] = [
  {
    tier: "conceptual",
    title: "Conceptual",
    body: "Business concepts and how they relate. No attributes, no types.",
  },
  {
    tier: "logical",
    title: "Logical",
    body: "Entities, attributes, keys and relationships. Platform-independent.",
  },
  {
    tier: "physical",
    title: "Physical",
    body: "BigQuery tables, columns, partitioning and clustering.",
  },
];

export function SetupPage({
  /** Where the server will write, so the operator can confirm the mount is what they think. */
  root,
  /**
   * Whether it can write there at all.
   *
   * Undefined from a server that predates the preflight, which is treated as "go ahead": the
   * flow then behaves exactly as it did before, and the create attempt reports any failure.
   */
  diagnosis,
  onDone,
}: {
  root: string | undefined;
  diagnosis: RootDiagnosis | undefined;
  onDone: (firstModel: string | undefined) => void;
}): JSX.Element {
  const [step, setStep] = useState<Step>("workspace");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [gitInit, setGitInit] = useState(true);
  const [preset, setPreset] = useState("by-model-and-kind");

  const [createModel, setCreateModel] = useState(true);
  const [modelName, setModelName] = useState("");
  const [namespace, setNamespace] = useState("");
  const [tiers, setTiers] = useState<Tier[]>(["logical"]);

  /**
   * The BigQuery target, asked for only when a physical model is being created.
   *
   * This is the step every tool in this category opens with: a target database is asked for
   * before you may draw a physical model, because the platform decides
   * which types and features are even legal. Leaving it out was why a wizard-created
   * physical model landed with a `model/noTarget` warning: generation has nowhere to emit
   * to, and the validator is right to say so.
   *
   * Still optional. Somebody evaluating the tool without a GCP project should not be
   * blocked at a form field, and the setup checklist on the overview will keep asking.
   */
  const [bqProject, setBqProject] = useState("");
  const [bqDataset, setBqDataset] = useState("");
  const [bqLocation, setBqLocation] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [warning, setWarning] = useState<string | undefined>();

  const trimmedName = name.trim();
  const trimmedModel = modelName.trim();

  /**
   * Identifiers are derived, not asked for.
   *
   * The object id has to be a safe slug, and making someone supply both a display name
   * and an id is a question with only one sensible answer. Mirrors the shape
   * `AppShell`'s new-model dialog already writes, so a model created here is
   * indistinguishable from one created later.
   */
  const slug = useMemo(
    () => (trimmedModel || trimmedName).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
    [trimmedModel, trimmedName],
  );

  const canLeaveWorkspace = trimmedName.length > 0;
  const canFinish =
    canLeaveWorkspace && (!createModel || (trimmedModel.length > 0 && tiers.length > 0));

  function toggleTier(tier: Tier): void {
    setTiers((current) =>
      current.includes(tier) ? current.filter((t) => t !== tier) : [...current, tier],
    );
  }

  /**
   * Create the workspace, then the models, then leave.
   *
   * Ordered and sequential on purpose. The models cannot be written until the config
   * exists to tell the loader where they go, and the tier chain has to be created
   * parent-first so each `derivedFrom` points at a model that is already on disk.
   *
   * A failure creating a model does not roll the workspace back. The workspace is
   * legitimately created at that point and rolling it back would strand the user on this
   * page with nothing; being dropped into an empty-but-real workspace with the reason on
   * screen is recoverable, and "New model" is right there.
   */
  async function finish(): Promise<void> {
    setBusy(true);
    setError(undefined);
    setWarning(undefined);

    try {
      const created = await api.initWorkspace({
        name: trimmedName,
        ...(description.trim() ? { description: description.trim() } : {}),
        preset,
        gitInit,
      });

      if (created.gitError) {
        setWarning(
          `The workspace was created, but git init failed: ${created.gitError}. Settings → Git can finish this.`,
        );
      }

      let firstModel: string | undefined;

      if (createModel && trimmedModel && tiers.length > 0) {
        // Ordered conceptual → logical → physical so `derivedFrom` can chain onto the
        // tier above, which is the direction a model actually derives in.
        const ordered = TIERS.map((entry) => entry.tier).filter((tier) => tiers.includes(tier));
        /**
         * The previous tier's **name**, not its id.
         *
         * `derivedFrom` is a `RefSchema` resolved against model names, `retail_logical`,
         * not `mdl_logical`, exactly as the shipped example writes it. Chaining ids here
         * produced a workspace that failed `strata check` the moment it was created, with two
         * `ref/unresolved` errors on a model the user had not touched yet.
         */
        let previousName: string | undefined;

        for (const tier of ordered) {
          const ns = namespace.trim() || slug;
          const id = `model_${ns}_${tier}`.replace(/[^a-zA-Z0-9_]/g, "_");
          const objectName = `${slug}_${tier}`;

          /**
           * The deployment target, on the physical tier only.
           *
           * Omitted entirely when nothing was filled in: an empty `target` block is not
           * better than no block, and the validator's `model/noTarget` warning is the
           * correct, actionable signal in that case.
           */
          const hasTarget =
            tier === "physical" && (bqProject.trim() || bqDataset.trim() || bqLocation.trim());

          await api.createObject({
            object: {
              id,
              kind: "model",
              name: objectName,
              tier,
              namespace: ns,
              ...(previousName ? { derivedFrom: previousName } : {}),
              ...(hasTarget
                ? {
                    target: {
                      platform: "bigquery",
                      ...(bqProject.trim() ? { project: bqProject.trim() } : {}),
                      ...(bqDataset.trim() ? { dataset: bqDataset.trim() } : {}),
                      ...(bqLocation.trim() ? { location: bqLocation.trim() } : {}),
                    },
                  }
                : {}),
            },
          });

          previousName = objectName;
          firstModel ??= objectName;
        }
      }

      onDone(firstModel);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const index = STEPS.findIndex((entry) => entry.id === step);

  /*
    `=== false`, not `!writable`.

    A server that predates the preflight sends no diagnosis at all, and that must mean "carry on"
    rather than "refuse": treating unknown as blocked would lock every older deployment out of
    its own setup screen over a field it has never heard of.
  */
  const blocked = diagnosis?.writable === false;

  return (
    <div className="setup">
      <div className="setup__card">
        <header className="setup__head">
          <div className="setup__brand">
            <span className="brand__mark" style={{ width: 28, height: 28 }}>
              <Logo size={22} />
            </span>
            <span>strata</span>
          </div>
          {/*
            The heading has to agree with the callout below it.

            Left as "Create your model repository" it sat directly above "This deployment cannot
            create a repository here", which reads as a broken page rather than a diagnosis.
          */}
          <h1 className="setup__title">
            {blocked ? "This instance is not configured yet" : "Create your model repository"}
          </h1>
          <p className="setup__lede">
            {blocked ? (
              "Strata is running, but it cannot use the directory it was pointed at, so there is nothing it can set up from here."
            ) : (
              <>
                There is no model repository here yet. This creates one, a{" "}
                <code>strata.config.yaml</code> and a <code>.gitattributes</code>, and nothing
                else. Your models will be plain YAML files in it, so git gives you history,
                review and merging rather than a database nobody can diff.
              </>
            )}
          </p>
          {root ? (
            <p className="setup__path" title={root}>
              <Icon name="folder" size={12} />
              {/* `bdi` so the RTL truncation below cannot reorder the path's own separators. */}
              <bdi className="setup__pathtext">{root}</bdi>
            </p>
          ) : null}
        </header>

        {/*
          When the server cannot write there, the flow stops here.

          Everything below this point collects settings for a write that is going to fail, and
          the operator cannot fix the cause from the browser anyway: the path is inside a
          container and comes from `STRATA_WORKSPACE`. Showing them the reason and the fix is
          strictly more useful than showing them a form and a button.

          `unblocked === false` rather than `!unblocked`, so a server that does not answer this
          question at all behaves exactly as before rather than locking everyone out of setup.
        */}
        {diagnosis?.writable === false ? (
          <Callout tone="err" title="This deployment cannot create a repository here">
            <p>{diagnosis.reason}</p>
            {diagnosis.hint ? <p className="setup__hint">{diagnosis.hint}</p> : null}
            <p className="setup__hint">
              The path comes from <code>STRATA_WORKSPACE</code>. It is a path inside the
              container, so it is set where you start the container, not from this screen.
            </p>
          </Callout>
        ) : null}

        {blocked ? null : (
          <>
            <ol className="setup__steps" aria-label="Setup steps">
          {STEPS.map((entry, i) => (
            <li
              key={entry.id}
              className={`setup__step${i === index ? " setup__step--on" : ""}${i < index ? " setup__step--done" : ""}`}
            >
              <span className="setup__stepnum">
                {i < index ? <Icon name="check" size={11} /> : i + 1}
              </span>
              {entry.label}
            </li>
          ))}
        </ol>

        <div className="setup__body">
          {step === "workspace" ? (
            <div className="stack">
              <Field
                label="Workspace name"
                hint="How this repository is referred to in the UI. Usually the team or the warehouse."
              >
                {(props) => (
                  <Input
                    {...props}
                    autoFocus
                    value={name}
                    placeholder="retail"
                    onChange={(event) => setName(event.target.value)}
                  />
                )}
              </Field>

              <Field label="Description" optional>
                {(props) => (
                  <Textarea
                    {...props}
                    rows={2}
                    value={description}
                    placeholder="What this repository holds, and who owns it."
                    onChange={(event) => setDescription(event.target.value)}
                  />
                )}
              </Field>

              <Checkbox
                checked={gitInit}
                onChange={(event) => setGitInit(event.target.checked)}
                label="Make this a git repository"
                hint="Recommended, version history, review and merging all come from git. Leave off if this directory is already inside one."
              />
            </div>
          ) : null}

          {step === "layout" ? (
            <div className="stack">
              <p className="muted small setup__note">
                Where a file sits carries <strong>no meaning</strong>, every object names its
                own kind and owning model in the file itself. So this is a preference, not a
                commitment: you can reorganise the whole repository from Settings later and
                the content stays byte-identical.
              </p>

              <div className="setup__choices">
                {LAYOUTS.map((entry) => (
                  <button
                    key={entry.preset}
                    type="button"
                    className={`setup__choice${preset === entry.preset ? " setup__choice--on" : ""}`}
                    aria-pressed={preset === entry.preset}
                    onClick={() => setPreset(entry.preset)}
                  >
                    <span className="setup__choicetitle">
                      {entry.title}
                      {preset === entry.preset ? <Icon name="check" size={13} /> : null}
                    </span>
                    <span className="setup__choicebody">{entry.body}</span>
                    <code className="setup__choiceex">{entry.example}</code>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {step === "model" ? (
            <div className="stack">
              <Checkbox
                checked={createModel}
                onChange={(event) => setCreateModel(event.target.checked)}
                label="Create a first model now"
                hint="Optional. You can also start by importing DDL or an erwin export."
              />

              {createModel ? (
                <>
                  <Field
                    label="Model name"
                    hint="The modelling effort, not one entity. A retail warehouse, a billing domain."
                  >
                    {(props) => (
                      <Input
                        {...props}
                        autoFocus
                        value={modelName}
                        placeholder="retail"
                        onChange={(event) => setModelName(event.target.value)}
                      />
                    )}
                  </Field>

                  <Field
                    label="Business domain"
                    optional
                    hint={`Groups related models in the sidebar. Defaults to \`${slug || "the model name"}\`.`}
                  >
                    {(props) => (
                      <Input
                        {...props}
                        value={namespace}
                        placeholder={slug || "sales"}
                        onChange={(event) => setNamespace(event.target.value)}
                      />
                    )}
                  </Field>

                  <div>
                    <p className="field__label">Tiers</p>
                    <p className="field__hint" style={{ marginBottom: "var(--s4)" }}>
                      Not three views of one model, a chain, each derived from the one above.
                      Pick more than one and they are linked for you.
                    </p>
                    <div className="setup__choices setup__choices--tight">
                      {TIERS.map((entry) => (
                        <button
                          key={entry.tier}
                          type="button"
                          className={`setup__choice${tiers.includes(entry.tier) ? " setup__choice--on" : ""}`}
                          aria-pressed={tiers.includes(entry.tier)}
                          onClick={() => toggleTier(entry.tier)}
                        >
                          <span className="setup__choicetitle">
                            {entry.title}
                            {tiers.includes(entry.tier) ? <Icon name="check" size={13} /> : null}
                          </span>
                          <span className="setup__choicebody">{entry.body}</span>
                        </button>
                      ))}
                    </div>
                    {tiers.length === 0 ? (
                      <p className="field__hint err-text" style={{ marginTop: "var(--s3)" }}>
                        Pick at least one tier.
                      </p>
                    ) : null}
                  </div>

                  {/*
                    Only for the physical tier. Conceptual and logical models are
                    deliberately platform-independent, that separation is what lets one
                    logical model drive several physical ones, so asking about BigQuery
                    while someone is creating a conceptual model would be asking the wrong
                    question at the wrong time.
                  */}
                  {tiers.includes("physical") ? (
                    <div className="setup__target">
                      <p className="field__label">BigQuery target</p>
                      <p className="field__hint" style={{ marginBottom: "var(--s4)" }}>
                        Where the physical model deploys. Optional now, without it the model
                        is still valid, but DDL and Dataform generation have nowhere to emit
                        to, so Problems will keep reminding you.
                      </p>

                      <div className="setup__targetgrid">
                        <Field label="Project" optional>
                          {(props) => (
                            <Input
                              {...props}
                              value={bqProject}
                              placeholder="acme-analytics-prod"
                              onChange={(event) => setBqProject(event.target.value)}
                            />
                          )}
                        </Field>

                        <Field label="Dataset" optional>
                          {(props) => (
                            <Input
                              {...props}
                              value={bqDataset}
                              placeholder="retail_mart"
                              onChange={(event) => setBqDataset(event.target.value)}
                            />
                          )}
                        </Field>

                        <Field label="Location" optional>
                          {(props) => (
                            <Input
                              {...props}
                              value={bqLocation}
                              placeholder="us-central1"
                              onChange={(event) => setBqLocation(event.target.value)}
                            />
                          )}
                        </Field>
                      </div>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}

          {warning ? <Callout tone="warn">{warning}</Callout> : null}
          {error ? <Callout tone="err">{error}</Callout> : null}
        </div>

        <footer className="setup__foot">
          {index > 0 ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setStep(STEPS[index - 1]?.id ?? "workspace")}
            >
              Back
            </Button>
          ) : null}

          <span className="grow" />

          {step === "model" ? (
            <Button
              variant="primary"
              size="lg"
              loading={busy}
              disabled={!canFinish}
              onClick={() => void finish()}
            >
              {createModel ? "Create repository and model" : "Create repository"}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="lg"
              disabled={step === "workspace" && !canLeaveWorkspace}
              onClick={() => setStep(STEPS[index + 1]?.id ?? "model")}
            >
              Continue
            </Button>
          )}
        </footer>
          </>
        )}
      </div>
    </div>
  );
}
