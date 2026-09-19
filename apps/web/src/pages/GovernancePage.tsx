import { useEffect, useState } from "react";
import type { JSX } from "react";
import { api, ApiError } from "../api";
import { Page } from "../app/Page";
import { Button, Callout, EmptyState, Loading } from "../ui";
import type { GovernanceReport } from "../types";

/**
 * One page for the question a governance lead is actually asked.
 *
 * Every number here already existed and none of them were reachable together. Coverage lived on
 * the dictionary page, classification suggestions on insights, ownership inside the CODEOWNERS
 * generator. "Which fields hold personal data, who owns them, and what is left to decide" took
 * five pages and mental arithmetic.
 *
 * **Ordered by what a reader does with it.** The estate first, because a percentage is the only
 * part most people read. Then what is outstanding, because that is the work. The register last,
 * because it is evidence: long, boring, and consulted rather than read.
 *
 * **Download rather than print.** A compliance officer wants a file to attach to a ticket. A
 * screenshot of this page is not that, and asking for one is how a governance feature stops
 * being used.
 */

export function GovernancePage(): JSX.Element {
  const [report, setReport] = useState<GovernanceReport | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;

    api
      .governance()
      .then((value) => {
        if (!cancelled) setReport(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Page
      title="Governance"
      subtitle="Ownership, classification, and what is still undecided"
      actions={
        report ? (
          <Button
            icon="doc"
            /*
              A plain link, not a fetch-and-blob. The route already sets `content-disposition`,
              so the browser's own download handles naming, progress and cancellation, and there
              is no object URL to leak.
            */
            onClick={() => {
              window.location.href = "/api/governance?format=markdown";
            }}
          >
            Download report
          </Button>
        ) : undefined
      }
    >
      {error ? <Callout tone="err" title="Could not build the report">{error}</Callout> : null}
      {!report && !error ? <Loading label="Measuring the estate…" /> : null}

      {report ? (
        <div className="gov">
          <section className="gov__section">
            <h2 className="gov__h">The estate</h2>
            <div className="gov__stats">
              <Stat
                label="Objects owned"
                value={report.estate.percentages.owned}
                detail={`${report.estate.withOwner} of ${report.estate.objects}`}
              />
              <Stat
                label="Objects described"
                value={report.estate.percentages.described}
                detail={`${report.estate.withDescription} of ${report.estate.objects}`}
              />
              <Stat
                label="Columns described"
                value={report.estate.percentages.columnsDescribed}
                detail={`${report.estate.columnsWithDescription} of ${report.estate.columns}`}
              />
              <Stat
                label="Sensitive classified"
                value={report.estate.percentages.sensitiveClassified}
                detail={`${report.estate.sensitiveClassified} of ${report.estate.sensitiveColumns}`}
              />
            </div>
          </section>

          <section className="gov__section">
            <h2 className="gov__h">Needs a decision</h2>
            {/*
              Suggestions and outstanding decisions are stated as two numbers, never summed.
              A column a rule already recognises is a button press; only what nothing recognises
              is work, and adding them together would overstate the queue a lead plans with.
            */}
            <p className="gov__lede">
              <strong>{report.backlog.length}</strong> field
              {report.backlog.length === 1 ? "" : "s"} carry no classification and no rule
              recognises them. A further <strong>{report.suggestions}</strong> have a suggestion
              waiting that can be applied in bulk from Insights.
            </p>

            {report.backlog.length === 0 ? (
              <EmptyState icon="check" title="Nothing outstanding" body="Every field is classified or has a suggestion waiting." inline />
            ) : (
              <div className="gov__scroll">
                <table className="gov__table">
                <caption className="sr-only">Fields with no classification and no suggestion</caption>
                <thead>
                  <tr>
                    <th scope="col">Model</th>
                    <th scope="col">Object</th>
                    <th scope="col">Field</th>
                    <th scope="col">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {report.backlog.map((entry) => (
                    <tr key={`${entry.model}/${entry.object}/${entry.field}`}>
                      <td>{entry.model}</td>
                      <td>{entry.object}</td>
                      <td className="mono">{entry.field}</td>
                      <td className="mono muted">{entry.type}</td>
                    </tr>
                  ))}
                </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="gov__section">
            <h2 className="gov__h">Classified fields</h2>
            {report.register.length === 0 ? (
              <EmptyState
                icon="shield"
                title="Nothing is classified yet"
                body="Classify a column directly, or give it a domain that carries a classification, and it appears here."
                inline
              />
            ) : (
              <div className="gov__scroll">
                <table className="gov__table">
                <caption className="sr-only">Every field carrying a classification</caption>
                <thead>
                  <tr>
                    <th scope="col">Model</th>
                    <th scope="col">Object</th>
                    <th scope="col">Field</th>
                    <th scope="col">Sensitivity</th>
                    <th scope="col">Categories</th>
                    <th scope="col">Inherited from</th>
                  </tr>
                </thead>
                <tbody>
                  {report.register.map((entry) => (
                    <tr key={`${entry.model}/${entry.object}/${entry.field}`}>
                      <td>{entry.model}</td>
                      <td>{entry.object}</td>
                      <td className="mono">{entry.field}</td>
                      <td>{entry.sensitivity ?? ""}</td>
                      <td>{entry.categories.join(", ")}</td>
                      {/*
                        Named, because it changes what you do about it. An inherited value is
                        fixed once on the domain; a direct one is fixed on every column.
                      */}
                      <td className="muted">{entry.inheritedFrom ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
                </table>
              </div>
            )}
          </section>

          {report.truncated ? (
            <Callout tone="warn" title="Lists are capped">
              This workspace has more rows than the page shows. Download the report for the full set.
            </Callout>
          ) : null}
        </div>
      ) : null}
    </Page>
  );
}

/** One percentage, with the raw counts underneath so the number can be checked. */
function Stat({ label, value, detail }: { label: string; value: number; detail: string }): JSX.Element {
  return (
    <div className="gov__stat">
      <span className="gov__statlabel">{label}</span>
      <span className="gov__statvalue">{value}%</span>
      <span className="gov__statdetail">{detail}</span>
    </div>
  );
}
