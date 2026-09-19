import { useState } from "react";
import type { JSX } from "react";
import { Icon } from "../ui";
import type { ModelView, Tier } from "../types";

/**
 * Create a model, and with it a business domain.
 *
 * Creating a model used to be a single "Name?" prompt, which quietly made the domain
 * uncreatable: `namespace` is what groups the conceptual, logical and physical models of
 * one effort, the explorer groups by it, CODEOWNERS isolates by it, and nothing could
 * ever set it. A workspace could therefore only ever have the one domain it was seeded
 * with.
 *
 * So the domain is the first field, offered as a free-text entry alongside the ones that
 * already exist. Typing a new name is how a new domain comes into being; there is no
 * separate "create domain" step, because a domain with no models in it is not a thing
 * worth having on disk.
 */

const TIERS: { tier: Tier; label: string; hint: string }[] = [
  { tier: "conceptual", label: "Conceptual", hint: "Business concepts and how they relate. No columns, no types." },
  { tier: "logical", label: "Logical", hint: "Entities, attributes and keys, independent of any database." },
  { tier: "physical", label: "Physical", hint: "BigQuery tables. This is the tier DDL is generated from." },
];

interface Props {
  models: ModelView[];
  /** Preselected domain, when the user opened this from inside one. */
  namespace?: string;
  /** Preselected tier, when they picked "Logical model" rather than a bare "Model". */
  tier?: Tier;
  onCreate: (input: { name: string; tier: Tier; namespace: string; derivedFrom?: string }) => void;
  onClose: () => void;
}

export function NewModelDialog({
  models,
  namespace,
  tier: initialTier,
  onCreate,
  onClose,
}: Props): JSX.Element {
  const domains = [...new Set(models.map((model) => model.namespace).filter(Boolean))] as string[];

  // Blank rather than the first existing product when nothing was selected: opening this
  // from the workspace root means a *new* product, and prefilling `retail` would quietly
  // add to that one instead.
  const [domain, setDomain] = useState(namespace ?? "");
  const [tier, setTier] = useState<Tier>(initialTier ?? "conceptual");
  const [name, setName] = useState("");
  const [derivedFrom, setDerivedFrom] = useState("");

  const isNewDomain = domain.trim().length > 0 && !domains.includes(domain.trim());

  /**
   * Models this one could descend from: the tier above, within the same domain.
   *
   * Restricted to one tier up because that is what `derivedFrom` means, a chain from
   * concept to logical to physical. Offering every model in the workspace would invite
   * a physical model claiming to derive from another physical model, which the tier
   * switch then cannot make sense of.
   */
  const parentTier: Tier | undefined =
    tier === "physical" ? "logical" : tier === "logical" ? "conceptual" : undefined;
  const parents = parentTier
    ? models.filter((model) => model.tier === parentTier && model.namespace === domain.trim())
    : [];

  /** `retail` + physical → `retail_physical`, so the field starts somewhere sensible. */
  const suggested = domain.trim() ? `${slug(domain)}_${tier === "physical" ? "warehouse" : tier}` : "";
  const effectiveName = name.trim() || suggested;
  const canSubmit = Boolean(domain.trim() && effectiveName);

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog dialog--sm" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog__head">
          <h2 className="dialog__title">New model</h2>
          <button type="button" className="iconbtn" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </header>

        <div className="dialog__body stack">
          <label className="field">
            <span className="field__label">Domain</span>
            <input
              className="input"
              autoFocus
              list="strata-domains"
              value={domain}
              placeholder="retail, finance, application…"
              onChange={(event) => setDomain(event.target.value)}
            />
            <datalist id="strata-domains">
              {domains.map((entry) => (
                <option key={entry} value={entry} />
              ))}
            </datalist>
            <span className="field__hint">
              {isNewDomain ? (
                <>
                  Creates the new domain <strong>{domain.trim()}</strong>. It becomes its own group
                  in the explorer and its own folder in the repo.
                </>
              ) : (
                "The business area this belongs to. Type a new name to start a new one."
              )}
            </span>
          </label>

          <div className="field">
            <span className="field__label">Tier</span>
            <div className="tierpick">
              {TIERS.map((entry) => (
                <button
                  key={entry.tier}
                  type="button"
                  className={`tierpick__btn${tier === entry.tier ? " tierpick__btn--on" : ""}`}
                  onClick={() => setTier(entry.tier)}
                >
                  <span className={`dot dot--${entry.tier}`} />
                  {entry.label}
                </button>
              ))}
            </div>
            <span className="field__hint">{TIERS.find((entry) => entry.tier === tier)?.hint}</span>
          </div>

          <label className="field">
            <span className="field__label">Model name</span>
            <input
              className="input mono"
              value={name}
              placeholder={suggested}
              onChange={(event) => setName(event.target.value)}
            />
            <span className="field__hint">
              Leave blank to use <span className="mono">{suggested || "the suggested name"}</span>.
            </span>
          </label>

          {parents.length > 0 ? (
            <label className="field">
              <span className="field__label">Derived from</span>
              <select
                className="input mono"
                value={derivedFrom}
                onChange={(event) => setDerivedFrom(event.target.value)}
              >
                <option value="">nothing, standalone</option>
                {parents.map((parent) => (
                  <option key={parent.id} value={parent.name}>
                    {parent.name}
                  </option>
                ))}
              </select>
              <span className="field__hint">
                Links the tiers so the switch beside the model picker can move between them.
              </span>
            </label>
          ) : null}
        </div>

        <footer className="dialog__foot">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canSubmit}
            onClick={() =>
              onCreate({
                name: effectiveName,
                tier,
                namespace: domain.trim(),
                ...(derivedFrom ? { derivedFrom } : {}),
              })
            }
          >
            Create model
          </button>
        </footer>
      </div>
    </div>
  );
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
