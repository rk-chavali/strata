import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { api, ApiError } from "../api";
import { Page } from "../app/Page";
import { Badge, Button, Callout, Icon, Loading, Switch, useFeedback, type IconName } from "../ui";
import type {
  Delivery,
  IntegrationState,
  IntegrationTestResult,
  ProviderField,
  WatchResult,
} from "../types";

/**
 * Where the model shows up outside strata, and whether it actually got there.
 *
 * The previous version of this page was a settings form, and it looked like one: four grey rows
 * in a field of white, each offering a toggle and a set of inputs. That was an honest reflection
 * of the feature at the time, because nothing fired. Now that dispatch exists, the page's job
 * changes completely: **the interesting question is not what is configured, it is what happened.**
 *
 * So the page leads with evidence. Every provider carries its recent delivery history as a strip
 * of outcomes you can read at a glance, the last attempt in words, and a failure surfaced where
 * it cannot be missed. Configuration is still here, folded away, because it is the thing you do
 * once and the delivery record is the thing you come back for.
 *
 * Secrets remain write-only throughout. The server sends presence and the last four characters,
 * so nothing on this page can leak a credential into a screenshot, including the delivery
 * previews, which carry the payload but never the target.
 */

export function IntegrationsPage(): JSX.Element {
  const ui = useFeedback();
  const [items, setItems] = useState<IntegrationState[] | undefined>();
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const [latest, setLatest] = useState<Record<string, Delivery>>({});
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [watching, setWatching] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);
  const [lastCheck, setLastCheck] = useState<WatchResult | undefined>();

  const load = useCallback(() => {
    let cancelled = false;
    api
      .integrations()
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        setReady(result.ready);
        setLatest(result.latest ?? {});
        setDeliveries(result.deliveries ?? []);
        setWatching(result.watching !== false);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(load, [load]);

  async function checkNow(): Promise<void> {
    setChecking(true);
    try {
      const result = await api.checkIntegrations();
      setLastCheck(result);
      setDeliveries(result.deliveries ?? []);
      load();
      ui.toast({
        tone: result.status === "dispatched" ? "success" : "info",
        message: WATCH_MESSAGE[result.status],
      });
    } catch (err) {
      ui.toast({ tone: "error", message: err instanceof ApiError ? err.message : String(err) });
    } finally {
      setChecking(false);
    }
  }

  if (error && !items) {
    return (
      <Page title="Integrations">
        <Callout tone="err" title="Could not load integrations">
          {error}
        </Callout>
      </Page>
    );
  }

  if (!items) {
    return (
      <Page title="Integrations">
        <Loading label="Loading integrations…" />
      </Page>
    );
  }

  const active = items.filter((item) => item.enabled).length;
  const failing = items.filter(
    (item) => item.enabled && latest[item.provider.id]?.ok === false,
  ).length;

  return (
    <Page
      title="Integrations"
      subtitle={
        <>
          <span>
            {active} of {items.length} active
          </span>
          {deliveries.length > 0 ? (
            <>
              {" · "}
              <span>last delivery {relative(deliveries[0]!.at)}</span>
            </>
          ) : null}
          {" · "}
          <span>credentials are encrypted and never sent to the browser</span>
        </>
      }
      actions={
        <Button icon="refresh" onClick={() => void checkNow()} disabled={checking}>
          {checking ? "Checking…" : "Check for merges"}
        </Button>
      }
    >
      <div className="intg">
        {/*
          Merge polling off is stated at the top, not buried.

          With it off nothing fires on merge at all, which makes every "active" badge below a
          lie of omission. An operator who set `STRATA_WATCH_INTERVAL_MS=0` months ago and forgot
          would otherwise have no way to reconcile "active" with "no deliveries".
        */}
        {!watching ? (
          <Callout tone="warn" title="Merge polling is switched off">
            <code>STRATA_WATCH_INTERVAL_MS</code> is <code>0</code>, so nothing fires when a proposal
            merges. Proposals and validation failures still dispatch. Use{" "}
            <strong>Check for merges</strong> to poll once by hand.
          </Callout>
        ) : null}

        {failing > 0 ? (
          <Callout tone="err" title={`${failing} integration${failing === 1 ? "" : "s"} failing`}>
            The most recent attempt failed. A failing integration is silent, nothing downstream
            knows the model changed.
          </Callout>
        ) : null}

        {lastCheck && lastCheck.status !== "dispatched" ? (
          <Callout tone="neutral" title={WATCH_MESSAGE[lastCheck.status]}>
            {lastCheck.ref ? (
              <>
                Watching <code>{lastCheck.ref}</code>
                {lastCheck.head ? (
                  <>
                    {" at "}
                    <code>{lastCheck.head.slice(0, 7)}</code>
                  </>
                ) : null}
                .
              </>
            ) : (
              WATCH_DETAIL[lastCheck.status]
            )}
          </Callout>
        ) : null}

        <div className="intg__grid">
          {items.map((item) => (
            <ProviderCard
              key={item.provider.id}
              state={item}
              ready={ready[item.provider.id] === true}
              last={latest[item.provider.id]}
              history={deliveries.filter((entry) => entry.provider === item.provider.id)}
              onSaved={() => {
                load();
                ui.toast({ tone: "success", message: `${item.provider.name} saved` });
              }}
              onError={(message) => ui.toast({ tone: "error", message })}
            />
          ))}
        </div>

        <DeliveryLog entries={deliveries} providers={items} />
      </div>
    </Page>
  );
}

/** What each poll outcome means, said as a sentence rather than a status code. */
const WATCH_MESSAGE: Record<WatchResult["status"], string> = {
  dispatched: "A merge was found and the integrations fired.",
  "no-default-branch": "No default branch could be resolved, so there is nothing to watch.",
  "baseline-recorded": "Starting point recorded. The next merge will be reported.",
  unchanged: "No new merges.",
  "history-rewritten": "The branch history was rewritten, so this change was not described.",
  "no-model-changes": "Something merged, but it touched no model files.",
};

const WATCH_DETAIL: Record<WatchResult["status"], string> = {
  dispatched: "",
  "no-default-branch":
    "Connect a git remote, or make sure a branch named main or master exists locally.",
  "baseline-recorded":
    "The first check never announces anything, otherwise enabling an integration would report the entire history at once.",
  unchanged: "",
  "history-rewritten":
    "A force push means the recorded commit is no longer reachable, so a diff from it would describe a change that never happened.",
  "no-model-changes": "Only non-model files changed, which is not worth a notification.",
};

function ProviderCard({
  state,
  ready,
  last,
  history,
  onSaved,
  onError,
}: {
  state: IntegrationState;
  ready: boolean;
  last: Delivery | undefined;
  history: Delivery[];
  onSaved: () => void;
  onError: (message: string) => void;
}): JSX.Element {
  const { provider } = state;
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<Record<string, string>>(state.settings);
  /**
   * Only the secrets the operator has actually typed.
   *
   * Kept separate from `settings` because the two are sent differently: an absent secret means
   * "leave the stored one alone", so pre-filling this from the server, which it could not do
   * anyway, would overwrite a good credential with a masked placeholder.
   */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<IntegrationTestResult | undefined>();

  async function save(next?: { enabled?: boolean }): Promise<void> {
    setBusy(true);
    try {
      await api.saveIntegration(provider.id, {
        ...(next?.enabled !== undefined ? { enabled: next.enabled } : {}),
        settings,
        ...(Object.keys(typed).length > 0 ? { secrets: typed } : {}),
      });
      setTyped({});
      onSaved();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function runTest(): Promise<void> {
    setBusy(true);
    setTest(undefined);
    try {
      /*
        Unsaved settings are sent with the test.

        So an operator can paste a site URL and check it before committing it to the config, which is the order people actually work in.
      */
      setTest(await api.testIntegration(provider.id, settings));
    } catch (error) {
      setTest({ ok: false, message: error instanceof ApiError ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const health: Health = !state.enabled
    ? "off"
    : !ready
      ? "incomplete"
      : last?.ok === false
        ? "failing"
        : last?.ok
          ? "working"
          : "idle";

  return (
    <section className={`pcard pcard--${health}${open ? " is-open" : ""}`} data-provider={provider.id}>
      <header className="pcard__head">
        <span className="pcard__icon">
          <Icon name={provider.icon as IconName} size={18} />
        </span>

        <span className="pcard__title">
          <span className="pcard__name">{provider.name}</span>
          <HealthBadge health={health} />
        </span>

        <Switch
          checked={state.enabled}
          disabled={busy}
          label={`Enable ${provider.name}`}
          onChange={(checked) => void save({ enabled: checked })}
        />
      </header>

      <p className="pcard__summary">{provider.summary}</p>

      {/*
        The delivery strip, and only when there is something to plot.

        Twelve bars is enough to read a pattern, steadily green, or green until Tuesday, and
        few enough to fit beside the text. It is the only element on the card reporting something
        the operator did not type in themselves, which is why it earns the space.

        Rendered conditionally because a strip of twelve empty slots reads as a loading skeleton
        rather than as "no history": on a page where nothing is enabled yet, four rows of grey
        placeholder bars is exactly the decorative filler this rewrite exists to remove. The
        sentence below already says the provider has never delivered.
      */}
      {history.length > 0 ? <DeliveryStrip history={history} /> : null}

      <p className="pcard__last">
        {last ? (
          <>
            <span className={`pcard__dot pcard__dot--${last.ok ? "ok" : "err"}`} />
            <span className="pcard__lasttext">
              {last.ok ? "Delivered" : "Failed"} {relative(last.at)}
              {last.summary ? <span className="pcard__lastsummary"> · {last.summary}</span> : null}
            </span>
          </>
        ) : state.enabled ? (
          <>
            <span className="pcard__dot pcard__dot--idle" />
            <span className="pcard__lasttext">
              Never delivered. Nothing has merged since this was enabled.
            </span>
          </>
        ) : (
          <span className="pcard__lasttext pcard__lasttext--muted">Off. Nothing is sent.</span>
        )}
      </p>

      {last && !last.ok ? (
        <p className="pcard__failure">
          <Icon name="warn" size={12} />
          {last.message}
        </p>
      ) : null}

      <div className="pcard__events">
        {provider.events.map((event) => (
          <span key={event} className="pcard__event" title={`Fires when ${EVENT_LABEL[event]}`}>
            {EVENT_SHORT[event]}
          </span>
        ))}
        <span className="grow" />
        <Button
          size="sm"
          iconEnd={open ? "chevronUp" : "chevronDown"}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Hide" : "Configure"}
        </Button>
      </div>

      {open ? (
        <div className="pcard__body">
          <p className="pcard__detail">{provider.detail}</p>

          <ul className="pcard__caps">
            {provider.capabilities.map((capability) => (
              <li key={capability}>
                <Icon name="check" size={11} />
                {capability}
              </li>
            ))}
          </ul>

          <div className="pcard__fields">
            {provider.fields.map((field) => (
              <ProviderInput
                key={field.key}
                field={field}
                value={field.type === "secret" ? (typed[field.key] ?? "") : (settings[field.key] ?? "")}
                secret={state.secrets[field.key]}
                onChange={(value) => {
                  if (field.type === "secret") setTyped((current) => ({ ...current, [field.key]: value }));
                  else setSettings((current) => ({ ...current, [field.key]: value }));
                }}
              />
            ))}
          </div>

          {test ? (
            <Callout tone={test.ok ? "ok" : "err"} title={test.message}>
              {test.detail}
            </Callout>
          ) : null}

          <footer className="pcard__foot">
            <Button size="sm" disabled={busy} onClick={() => void runTest()}>
              Test connection
            </Button>
            <span className="grow" />
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </footer>
        </div>
      ) : null}
    </section>
  );
}

type Health = "off" | "incomplete" | "failing" | "working" | "idle";

function HealthBadge({ health }: { health: Health }): JSX.Element | null {
  switch (health) {
    case "working":
      return <Badge tone="ok">active</Badge>;
    case "failing":
      return (
        <Badge tone="err" title="The most recent attempt failed">
          failing
        </Badge>
      );
    case "incomplete":
      /* On but incomplete is the dangerous state: it fails on a merge, when nobody is watching. */
      return (
        <Badge tone="warn" title="Enabled but missing required configuration">
          needs setup
        </Badge>
      );
    case "idle":
      return (
        <Badge tone="accent" title="Configured and enabled, but nothing has fired yet">
          ready
        </Badge>
      );
    default:
      return null;
  }
}

/** How many attempts the strip shows. Enough to read a pattern, few enough to sit beside prose. */
const STRIP_SLOTS = 12;

/**
 * Recent outcomes, oldest to newest, left to right.
 *
 * Empty slots are rendered rather than omitted so the strip keeps a constant width, a bar chart
 * that changes length as data arrives reads as a layout bug, and it makes two providers
 * impossible to compare by eye.
 */
function DeliveryStrip({ history }: { history: Delivery[] }): JSX.Element {
  const recent = useMemo(() => [...history].slice(0, STRIP_SLOTS).reverse(), [history]);
  const padding = Math.max(0, STRIP_SLOTS - recent.length);

  return (
    <div className="strip" role="img" aria-label={stripLabel(history)}>
      {Array.from({ length: padding }, (_, index) => (
        <span key={`pad-${index}`} className="strip__bar strip__bar--empty" />
      ))}
      {recent.map((entry) => (
        <span
          key={entry.id}
          className={`strip__bar strip__bar--${entry.ok ? "ok" : "err"}`}
          title={`${EVENT_SHORT[entry.event]} · ${entry.ok ? "delivered" : "failed"} ${relative(entry.at)}`}
        />
      ))}
    </div>
  );
}

function stripLabel(history: Delivery[]): string {
  if (history.length === 0) return "No deliveries yet";
  const failed = history.filter((entry) => !entry.ok).length;
  return `${history.length} recent attempt(s), ${failed} failed`;
}

/**
 * Every attempt, newest first.
 *
 * The section that makes the feature auditable. "Did the wiki update on Tuesday's merge?" is
 * unanswerable without it, and the honest response to an unanswerable question is to stop
 * relying on the thing, which is how integrations get switched off.
 */
function DeliveryLog({
  entries,
  providers,
}: {
  entries: Delivery[];
  providers: IntegrationState[];
}): JSX.Element {
  const [expanded, setExpanded] = useState<string | undefined>();
  const nameOf = useMemo(
    () => new Map(providers.map((item) => [item.provider.id, item.provider.name])),
    [providers],
  );

  if (entries.length === 0) {
    return (
      <section className="dlog">
        <h2 className="dlog__h">Delivery history</h2>
        <div className="dlog__empty">
          <NothingYetArt />
          <p className="dlog__emptytitle">Nothing has been delivered yet</p>
          <p className="dlog__emptybody">
            Every attempt shows up here, what fired, what it said, and whether it arrived. Enable
            a provider above, then merge a proposal.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="dlog">
      <h2 className="dlog__h">
        Delivery history
        <span className="dlog__count">{entries.length}</span>
      </h2>

      <ol className="dlog__list">
        {entries.map((entry) => {
          const isOpen = expanded === entry.id;
          return (
            <li key={entry.id} className={`dlog__row${entry.ok ? "" : " is-failed"}`}>
              <button
                type="button"
                className="dlog__main"
                onClick={() => setExpanded(isOpen ? undefined : entry.id)}
                aria-expanded={isOpen}
              >
                <span className={`dlog__status dlog__status--${entry.ok ? "ok" : "err"}`}>
                  <Icon name={entry.ok ? "check" : "warn"} size={11} />
                </span>

                <span className="dlog__who">
                  <span className="dlog__provider">{nameOf.get(entry.provider) ?? entry.provider}</span>
                  <span className="dlog__event">{EVENT_SHORT[entry.event]}</span>
                </span>

                <span className="dlog__what">
                  <span className="dlog__message truncate">{entry.message}</span>
                  {entry.summary ? (
                    <span className="dlog__summary truncate">{entry.summary}</span>
                  ) : null}
                </span>

                <span className="dlog__meta">
                  {entry.shortSha ? <code className="dlog__sha">{entry.shortSha}</code> : null}
                  <span className="dlog__when">{relative(entry.at)}</span>
                  {/* Duration is how you spot the provider that is about to start timing out. */}
                  <span className="dlog__dur">{formatDuration(entry.durationMs)}</span>
                </span>

                <Icon
                  name={isOpen ? "chevronUp" : "chevronDown"}
                  size={12}
                  className="dlog__chevron"
                />
              </button>

              {isOpen ? (
                <div className="dlog__detail">
                  {entry.detail ? <p className="dlog__detailtext">{entry.detail}</p> : null}
                  {entry.status !== undefined ? (
                    <p className="dlog__detailtext">
                      HTTP <code>{entry.status}</code>
                    </p>
                  ) : null}
                  {entry.preview ? (
                    <>
                      <p className="dlog__previewlabel">What was sent</p>
                      <pre className="dlog__preview">{entry.preview}</pre>
                    </>
                  ) : (
                    <p className="dlog__detailtext dlog__detailtext--muted">
                      Nothing was sent, so there is no payload to show.
                    </p>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * The empty state.
 *
 * Drawn rather than an icon scaled up, because this is the first thing anyone sees on this page
 * and a 16px glyph at 64px reads as a mistake. The model on the left, a dashed path fanning out
 * to the places it goes on the right, and nothing having travelled the line yet.
 *
 * `currentColor` throughout so it inherits the theme instead of carrying its own palette.
 */
function NothingYetArt(): JSX.Element {
  return (
    <svg
      className="dlog__art"
      viewBox="0 0 220 80"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect x="1" y="26" width="46" height="28" rx="6" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M9 35h30M9 40h22M9 45h26"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.55"
      />
      <path
        d="M53 40h48"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="4 5"
        opacity="0.6"
      />
      <circle cx="112" cy="40" r="5" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
      <path
        d="M123 40h20M143 40c8 0 8-23 16-23M143 40c8 0 8 23 16 23"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="4 5"
        opacity="0.6"
      />
      <rect x="167" y="6" width="46" height="22" rx="6" stroke="currentColor" strokeWidth="1.5" opacity="0.75" />
      <rect x="167" y="30" width="46" height="20" rx="6" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
      <rect x="167" y="53" width="46" height="22" rx="6" stroke="currentColor" strokeWidth="1.5" opacity="0.75" />
    </svg>
  );
}

function ProviderInput({
  field,
  value,
  secret,
  onChange,
}: {
  field: ProviderField;
  value: string;
  secret?: { configured: boolean; hint?: string; source?: "environment" | "stored" };
  onChange: (value: string) => void;
}): JSX.Element {
  const fromEnvironment = secret?.source === "environment";

  return (
    <label className="pcard__field">
      <span className="pcard__label">
        {field.label}
        {field.required ? <span className="pcard__req">required</span> : null}
      </span>

      <input
        className="input"
        type={field.type === "secret" ? "password" : "text"}
        value={value}
        /*
          A configured secret shows its hint as the placeholder, so the field reads as "already
          set, type to replace" rather than as empty. An empty required field and a set one look
          identical otherwise, and the operator's instinct is to re-paste the credential.
        */
        placeholder={
          field.type === "secret" && secret?.configured
            ? `configured ••••${secret.hint ?? ""}`
            : field.placeholder
        }
        disabled={fromEnvironment}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />

      {fromEnvironment ? (
        <span className="pcard__hint">
          Supplied by an environment variable, which takes precedence. Unset it to edit here.
        </span>
      ) : field.hint ? (
        <span className="pcard__hint">{field.hint}</span>
      ) : null}
    </label>
  );
}

const EVENT_LABEL: Record<string, string> = {
  merged: "a proposal merges",
  proposed: "a proposal opens",
  validationFailed: "validation fails",
};

/** The chip form. Short enough to sit three-across on a card without wrapping. */
const EVENT_SHORT: Record<string, string> = {
  merged: "on merge",
  proposed: "on propose",
  validationFailed: "on failure",
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * "3 hours ago".
 *
 * Same reasoning as the overview feed: nobody reading a delivery log is asking "at what exact
 * time", they are asking "recently, or has this been broken for a week".
 */
function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;

  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}
