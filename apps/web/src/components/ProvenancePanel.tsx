import { useEffect, useState } from "react";
import type { JSX } from "react";
import { api, ApiError } from "../api";
import { Icon } from "../ui";
import type { ObjectProvenance } from "../types";

/**
 * Why this object exists.
 *
 * The question a modelling tool is uniquely placed to answer and, until now, could not. Six
 * months after a column appears, the reason lives in a ticket nobody thinks to search. The
 * commit that introduced it already names the pull request, and the pull request title already
 * carries the ticket key, so this is reading what is there rather than maintaining a link table.
 *
 * **Fetched on expand, not on selection**, matching lineage and impact. Provenance costs a `git
 * log` and possibly a Jira round trip, and paying that on every click through a diagram would
 * make selection feel slow for a panel most clicks never open.
 *
 * **Every empty state says why.** A blank section reads as broken; "Jira is not configured"
 * reads as working, with a next step. That distinction is the difference between a feature
 * people trust and one they report as a bug.
 */

interface Props {
  objectId: string;
}

export function ProvenanceSection({ objectId }: Props): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <section className="props__section">
      <button
        type="button"
        className="props__sectionhead"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={10} />
        <span>Why this exists</span>
      </button>
      {open ? <Provenance objectId={objectId} /> : null}
    </section>
  );
}

function Provenance({ objectId }: Props): JSX.Element {
  const [result, setResult] = useState<ObjectProvenance | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setResult(undefined);
    setError(undefined);

    api
      .provenance(objectId)
      .then((value) => {
        if (!cancelled) setResult(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [objectId]);

  if (error) return <p className="props__note small">{error}</p>;
  if (!result) return <p className="props__note small muted">Reading history…</p>;
  if (!result.lastChange) {
    return <p className="props__note small muted">{result.unavailable ?? "No history for this object."}</p>;
  }

  const { lastChange, ticket } = result;

  return (
    <div className="prov">
      {ticket ? (
        <div className="prov__ticket">
          <Icon name="link" size={11} />
          <div className="prov__ticketbody">
            <a
              className="prov__key"
              href={ticket.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              {ticket.key}
            </a>
            {ticket.summary ? <span className="prov__summary">{ticket.summary}</span> : null}
            {ticket.status ? <span className="prov__status">{ticket.status}</span> : null}
            {/* Stated, not hidden: the reader should know the key is real but the detail is not. */}
            {ticket.unavailable ? <span className="prov__muted">{ticket.unavailable}</span> : null}
          </div>
        </div>
      ) : null}

      <dl className="prov__facts">
        <dt>Last changed</dt>
        <dd>
          {lastChange.commitUrl ? (
            <a href={lastChange.commitUrl} target="_blank" rel="noreferrer noopener">
              {lastChange.subject}
            </a>
          ) : (
            lastChange.subject
          )}
        </dd>

        <dt>By</dt>
        <dd>{lastChange.author}</dd>

        <dt>When</dt>
        {/* Formatted in the reader's locale, which is why the server sends ISO 8601 and stops. */}
        <dd>{formatDate(lastChange.date)}</dd>

        {lastChange.pullRequest ? (
          <>
            <dt>Pull request</dt>
            <dd>
              {lastChange.pullRequestUrl ? (
                <a href={lastChange.pullRequestUrl} target="_blank" rel="noreferrer noopener">
                  #{lastChange.pullRequest}
                </a>
              ) : (
                `#${lastChange.pullRequest}`
              )}
            </dd>
          </>
        ) : null}
      </dl>

      {/*
        Two different empty states, and getting them confused was a real bug: a commit reading
        `DATA-1234 add the customer dimension` was told "no ticket found", when in fact nothing
        had looked, because Jira was not configured. One of these means "connect Jira", the other
        means "put the key in your commit subject". An empty state that gives the wrong
        instruction is worse than one that gives none.
      */}
      {!ticket ? (
        <p className="props__note small muted">
          {result.ticketSource
            ? "No ticket key in this commit's subject. Start the subject with a key from your configured projects to link the change to the request that asked for it."
            : "Connect Jira and name your project keys to trace changes back to the request that asked for them."}
        </p>
      ) : null}
    </div>
  );
}

/** A readable date, falling back to the raw value rather than rendering `Invalid Date`. */
function formatDate(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? iso
    : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
