import { useMemo, useState } from "react";
import type { JSX } from "react";
import { api } from "../api";
import { Button, Callout, Dialog, Field, Input, Select, TagInput, Textarea, useFeedback } from "../ui";
import type { ModelView } from "../types";

/**
 * A model's own settings: what it is called, which domain it belongs to, how it is labelled.
 *
 * **Why this exists at all.** A model was named `retail_warehouse` and there was no way to
 * change it, anywhere in the product. Nor to tag it, nor to move it into a different
 * business domain. Those are the three things that make a workspace of three hundred models
 * navigable, and all three were fixed at creation time, which meant a typo in a name was
 * permanent and a domain that grew in the wrong place stayed there.
 *
 * **Why it is one dialog and one request.** Renaming, re-domaining and re-tagging all land
 * in the same set of files, and under the default layout the name *is* part of every path,
 * so the server applies them as a single refactor. Saving them separately would produce
 * intermediate states in git that the user never asked for, and a failure halfway would
 * leave the repo in one of them.
 *
 * The honesty note under the name field is not decoration. Renaming a model rewrites every
 * reference to it and moves every file in it; someone about to do that on a shared repo
 * should know before they click Save, not from the diff afterwards.
 */

const LIFECYCLES = [
  { value: "", label: "Not set" },
  { value: "draft", label: "Draft" },
  { value: "in_review", label: "In review" },
  { value: "approved", label: "Approved" },
  { value: "deprecated", label: "Deprecated" },
  { value: "retired", label: "Retired" },
];

export function ModelSettingsDialog({
  model,
  domains,
  onClose,
  onSaved,
}: {
  model: ModelView;
  /** Existing domains, offered as a list so a typo does not silently create a new one. */
  domains: string[];
  onClose: () => void;
  /** Called with the model's name after saving, it may have changed. */
  onSaved: (name: string) => void;
}): JSX.Element {
  const ui = useFeedback();

  const [name, setName] = useState(model.name);
  const [namespace, setNamespace] = useState(model.namespace ?? "");
  const [displayName, setDisplayName] = useState(model.displayName ?? "");
  const [description, setDescription] = useState(model.description ?? "");
  const [tags, setTags] = useState<string[]>(model.tags ?? []);
  const [lifecycle, setLifecycle] = useState(model.lifecycle ?? "");
  const [saving, setSaving] = useState(false);

  /**
   * A free-text domain as well as the list.
   *
   * Choosing from existing domains is the common case and guards against `retails`, but the
   * first model of a new domain has to be able to name one that does not exist yet, and
   * sending someone to a separate "create a domain" flow for a field that is a string on
   * this object would be inventing a concept the data model does not have.
   */
  const [newDomain, setNewDomain] = useState(false);

  const renaming = name.trim() !== model.name;
  const moving = (namespace.trim() || undefined) !== model.namespace;

  const problem = useMemo(() => {
    if (!name.trim()) return "A model needs a name.";
    if (/[^a-zA-Z0-9_.:-]/.test(name.trim())) {
      return "Use letters, digits, underscores, dots, colons or hyphens, the name becomes a file path.";
    }
    return undefined;
  }, [name]);

  async function save(): Promise<void> {
    if (problem) return;
    setSaving(true);

    const result = await ui.attempt(
      () =>
        api.updateModelSettings(model.id, {
          name: name.trim(),
          namespace: namespace.trim() || null,
          displayName: displayName.trim() || null,
          description: description.trim() || null,
          tags,
          lifecycle: lifecycle || null,
        }),
      "Could not save the model settings",
    );

    setSaving(false);
    if (!result) return;

    /**
     * Report what actually happened on disk.
     *
     * A rename moves files and edits the config, and the user is about to see all of that
     * in Changes. Saying so here means the diff is expected rather than alarming.
     */
    const parts: string[] = [];
    if (result.moved > 0) parts.push(`${result.moved} file${result.moved === 1 ? "" : "s"} moved`);
    if (result.configChanged) parts.push("strata.config.yaml updated");

    ui.toast({
      tone: "success",
      message: parts.length > 0 ? `Saved, ${parts.join(", ")}` : "Saved",
    });

    onSaved(name.trim());
  }

  return (
    <Dialog
      title="Model settings"
      subtitle={model.name}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={Boolean(problem)} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field
          label="Name"
          {...(problem ? { error: problem } : {})}
          hint="Used in references, file paths and generated SQL."
        >
          {(props) => (
            <Input {...props} value={name} onChange={(event) => setName(event.target.value)} />
          )}
        </Field>

        {renaming && !problem ? (
          <Callout tone="warn" title="Renaming rewrites more than this file">
            Every object in the model, anything referring to it, and{" "}
            <code>strata.config.yaml</code> are updated, and the model&rsquo;s files move to
            match the new name. It is one commit, and the old name is remembered so existing
            references keep resolving.
          </Callout>
        ) : null}

        <Field label="Display name" optional hint="A friendlier label for documentation.">
          {(props) => (
            <Input
              {...props}
              value={displayName}
              placeholder={model.name}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          )}
        </Field>

        <Field
          label="Domain"
          optional
          hint="The business area this model belongs to. Models are grouped by it."
        >
          {(props) =>
            newDomain || domains.length === 0 ? (
              <div className="row">
                <Input
                  {...props}
                  value={namespace}
                  placeholder="retail"
                  onChange={(event) => setNamespace(event.target.value)}
                />
                {domains.length > 0 ? (
                  <Button variant="ghost" size="sm" onClick={() => setNewDomain(false)}>
                    Pick existing
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="row">
                <Select
                  {...props}
                  value={namespace}
                  onChange={(event) => setNamespace(event.target.value)}
                >
                  <option value="">Ungrouped</option>
                  {domains.map((domain) => (
                    <option key={domain} value={domain}>
                      {domain}
                    </option>
                  ))}
                </Select>
                <Button variant="ghost" size="sm" onClick={() => setNewDomain(true)}>
                  New domain
                </Button>
              </div>
            )
          }
        </Field>

        {moving ? (
          <p className="muted small">
            Moving domain can relocate this model&rsquo;s files, depending on the repository
            layout.
          </p>
        ) : null}

        <Field label="Tags" optional hint="Enter or comma to add. Searchable on the models list.">
          {() => <TagInput value={tags} onChange={setTags} />}
        </Field>

        <Field label="Lifecycle" optional>
          {(props) => (
            <Select
              {...props}
              value={lifecycle}
              onChange={(event) => setLifecycle(event.target.value)}
            >
              {LIFECYCLES.map((state) => (
                <option key={state.value} value={state.value}>
                  {state.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Description" optional>
          {(props) => (
            <Textarea
              {...props}
              value={description}
              rows={3}
              placeholder="What this model is for."
              onChange={(event) => setDescription(event.target.value)}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
