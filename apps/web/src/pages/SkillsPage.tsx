import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { api, ApiError } from "../api";
import { Page } from "../app/Page";
import { useWorkspace } from "../app/WorkspaceContext";
import { Badge, Button, Callout, Icon, Loading, Switch, useFeedback } from "../ui";
import type { Skill, SkillRun } from "../types";

/**
 * Skills, the rules this team enforces on itself.
 *
 * The page exists to make the gate legible, not to operate it. Skills run automatically when
 * someone proposes a change; a rule that only ran when somebody remembered to click here would
 * enforce nothing. So the page leads with **what each skill would do to a proposal right now**,
 * and Run is an authoring aid, write a rule, see what it catches, before opening a pull request.
 *
 * The distinction the layout works hardest to carry is `blocking` versus `advisory`, because it
 * is the only thing on the page with consequences: one refuses the proposal, the other annotates
 * it. A skill that is failing and blocking is the single most important state here, so it is the
 * one that gets colour.
 */

export function SkillsPage(): JSX.Element {
  const ui = useFeedback();
  const { canEdit } = useWorkspace();
  const [skills, setSkills] = useState<Skill[] | undefined>();
  const [runs, setRuns] = useState<SkillRun[]>([]);
  const [agentsConfigured, setAgentsConfigured] = useState(false);
  const [dir, setDir] = useState(".strata/skills");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();

  const load = useCallback(() => {
    let cancelled = false;
    api
      .skills()
      .then((result) => {
        if (cancelled) return;
        setSkills(result.skills);
        setRuns(result.runs);
        setAgentsConfigured(result.agentsConfigured);
        setDir(result.dir);
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

  async function run(name?: string): Promise<void> {
    setBusy(name ?? "*");
    try {
      const result = await api.runSkills(name ? { name } : {});
      /*
        A single-skill run replaces only that skill's result.

        Replacing the whole list would blank every other row the moment someone tested one rule,
        which reads as the page losing its data rather than as a scoped action.
      */
      setRuns((current) =>
        name
          ? [...current.filter((entry) => entry.skill !== name), ...result.runs]
          : result.runs,
      );
      setAgentsConfigured(result.agentsConfigured);

      const failed = result.runs.filter((entry) => entry.status === "failed").length;
      ui.toast({
        tone: failed > 0 ? "error" : "success",
        message:
          failed > 0
            ? `${failed} skill${failed === 1 ? "" : "s"} found something`
            : "Nothing found",
      });
    } catch (err) {
      ui.toast({ tone: "error", message: err instanceof ApiError ? err.message : String(err) });
    } finally {
      setBusy(undefined);
    }
  }

  async function toggle(name: string, enabled: boolean): Promise<void> {
    setBusy(name);
    try {
      await api.setSkillEnabled(name, enabled);
      load();
      /*
        Said explicitly, because it surprises people.

        The toggle writes the skill's own file, so turning a rule off is a repo change that shows
        up in Changes and merges through review, which is the point. Disabling a governance
        control should be at least as visible as writing one.
      */
      ui.toast({
        tone: "success",
        message: `${name} ${enabled ? "enabled" : "disabled"}, the change is in your working tree`,
      });
    } catch (err) {
      ui.toast({ tone: "error", message: err instanceof ApiError ? err.message : String(err) });
    } finally {
      setBusy(undefined);
    }
  }

  if (error && !skills) {
    return (
      <Page title="Skills">
        <Callout tone="err" title="Could not load skills">
          {error}
        </Callout>
      </Page>
    );
  }

  if (!skills) {
    return (
      <Page title="Skills">
        <Loading label="Loading skills…" />
      </Page>
    );
  }

  const byName = new Map(runs.map((entry) => [entry.skill, entry]));
  const active = skills.filter((skill) => skill.enabled);
  const blockingNow = active.filter(
    (skill) => skill.severity === "blocking" && byName.get(skill.name)?.status === "failed",
  ).length;

  return (
    <Page
      title="Skills"
      subtitle={
        <>
          <span>
            {active.length} of {skills.length} enabled
          </span>
          {" · "}
          <span>
            defined in <span className="mono">{dir}</span>
          </span>
          {" · "}
          <span>run automatically before every proposal</span>
        </>
      }
      actions={
        skills.length > 0 ? (
          <Button icon="refresh" onClick={() => void run()} disabled={busy !== undefined}>
            {busy === "*" ? "Running…" : "Run all"}
          </Button>
        ) : null
      }
    >
      {skills.length === 0 ? (
        <EmptySkills dir={dir} />
      ) : (
        <div className="skills">
          {blockingNow > 0 ? (
            <Callout
              tone="err"
              title={`${blockingNow} blocking skill${blockingNow === 1 ? "" : "s"} would refuse a proposal right now`}
            >
              Nobody can open a pull request from this branch until these findings are resolved, or
              the skill is changed to advisory.
            </Callout>
          ) : null}

          {!agentsConfigured && skills.some((skill) => skill.kind === "agent") ? (
            <Callout tone="warn" title="Agent skills are not running">
              No language model provider is configured, so agent skills are skipped rather than
              passed. Set <code>STRATA_SKILLS_API_KEY</code>, or store a{" "}
              <span className="mono">skills.apiKey</span> secret.
            </Callout>
          ) : null}

          <div className="skills__list">
            {skills.map((skill) => (
              <SkillCard
                key={skill.name}
                skill={skill}
                run={byName.get(skill.name)}
                canEdit={canEdit}
                busy={busy === skill.name}
                disabled={busy !== undefined}
                onRun={() => void run(skill.name)}
                onToggle={(enabled) => void toggle(skill.name, enabled)}
              />
            ))}
          </div>
        </div>
      )}
    </Page>
  );
}

function SkillCard({
  skill,
  run,
  canEdit,
  busy,
  disabled,
  onRun,
  onToggle,
}: {
  skill: Skill;
  run: SkillRun | undefined;
  canEdit: boolean;
  busy: boolean;
  disabled: boolean;
  onRun: () => void;
  onToggle: (enabled: boolean) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);

  /*
    The visual state is the *consequence*, not the run status.

    A failing advisory skill and a failing blocking skill have the same status and completely
    different meanings, one annotates a proposal, the other refuses it. Colouring by status
    would flatten the only distinction on this page that has teeth.
  */
  const tone: CardTone = skill.error
    ? "broken"
    : !skill.enabled
      ? "off"
      : run?.status === "failed"
        ? skill.severity === "blocking"
          ? "blocking"
          : "advising"
        : run?.status === "skipped"
          ? "skipped"
          : run?.status === "errored"
            ? "broken"
            : "passing";

  return (
    <section className={`skill skill--${tone}`}>
      <header className="skill__head">
        <span className="skill__icon">
          <Icon name={skill.kind === "agent" ? "concept" : "shield"} size={16} />
        </span>

        <span className="skill__title">
          <span className="skill__name">{skill.name}</span>
          <StatusBadge tone={tone} severity={skill.severity} />
          <span className="skill__kind">{skill.kind}</span>
        </span>

        {canEdit ? (
          <Switch
            checked={skill.enabled}
            disabled={disabled || Boolean(skill.error)}
            label={`Enable ${skill.name}`}
            onChange={onToggle}
          />
        ) : null}
      </header>

      {skill.description ? <p className="skill__desc">{skill.description}</p> : null}

      <p className="skill__meta">
        <span className="mono">{skill.file}</span>
        {skill.rule ? (
          <>
            {" · "}
            <span className="mono">{skill.rule}</span>
          </>
        ) : null}
      </p>

      {skill.error ? (
        <p className="skill__problem">
          <Icon name="warn" size={12} />
          {skill.error}
        </p>
      ) : run?.reason ? (
        <p className="skill__note">
          <Icon name="minus" size={12} />
          {run.reason}
        </p>
      ) : null}

      {run && run.findings.length > 0 ? (
        <ol className="skill__findings">
          {(open ? run.findings : run.findings.slice(0, 3)).map((finding, index) => (
            <li key={`${finding.objectName ?? ""}-${index}`}>
              <span className="skill__findingdot" />
              <span className="skill__findingbody">
                <span className="skill__findingmsg">{finding.message}</span>
                {finding.file ? <span className="skill__findingfile mono">{finding.file}</span> : null}
              </span>
            </li>
          ))}
          {run.findings.length > 3 ? (
            <li className="skill__more">
              <button type="button" className="linkish" onClick={() => setOpen((value) => !value)}>
                {open ? "Show fewer" : `Show all ${run.findings.length}`}
              </button>
            </li>
          ) : null}
        </ol>
      ) : null}

      <footer className="skill__foot">
        <span className="skill__when">
          {run && run.status !== "skipped"
            ? `${LABEL[run.status]} · ${run.durationMs}ms`
            : run?.status === "skipped"
              ? "Not run"
              : "Not run"}
        </span>
        <span className="grow" />
        <Button size="sm" disabled={disabled} onClick={onRun}>
          {busy ? "Running…" : "Run"}
        </Button>
      </footer>
    </section>
  );
}

type CardTone = "passing" | "blocking" | "advising" | "skipped" | "off" | "broken";

const LABEL: Record<SkillRun["status"], string> = {
  passed: "Passed",
  failed: "Found something",
  skipped: "Skipped",
  errored: "Errored",
};

function StatusBadge({
  tone,
  severity,
}: {
  tone: CardTone;
  severity: Skill["severity"];
}): JSX.Element | null {
  switch (tone) {
    case "blocking":
      return (
        <Badge tone="err" title="A proposal cannot be opened while this fails">
          blocks proposals
        </Badge>
      );
    case "advising":
      return (
        <Badge tone="warn" title="Findings are attached to the proposal; it still goes through">
          advisory findings
        </Badge>
      );
    case "passing":
      return (
        <Badge tone="ok" title={severity === "blocking" ? "Blocking, and currently clean" : "Clean"}>
          passing
        </Badge>
      );
    case "skipped":
      return <Badge tone="neutral">not run</Badge>;
    case "broken":
      return (
        <Badge tone="err" title="This skill could not be understood, so it is not enforcing">
          broken
        </Badge>
      );
    default:
      return null;
  }
}

/**
 * The empty state.
 *
 * Shows the shape of a skill rather than describing it. Someone arriving here has to write a
 * markdown file with frontmatter, and a worked example is a far shorter path to that than three
 * paragraphs of prose about the format.
 */
function EmptySkills({ dir }: { dir: string }): JSX.Element {
  return (
    <div className="skills__empty">
      <ShieldArt />
      <h2 className="skills__emptytitle">No skills yet</h2>
      <p className="skills__emptybody">
        Skills are rules your team writes down and the tool enforces. They live in{" "}
        <span className="mono">{dir}</span> in this repository, so they are reviewed and versioned
        like the model itself, and they run automatically before every proposal.
      </p>

      <pre className="skills__sample">{SAMPLE}</pre>

      <p className="skills__emptyfoot">
        Built-in rules: <span className="mono">forbidden-words</span>,{" "}
        <span className="mono">required-description</span>,{" "}
        <span className="mono">required-field</span>, <span className="mono">naming</span>,{" "}
        <span className="mono">classification-coverage</span>. Set{" "}
        <span className="mono">kind: agent</span> instead of a rule to have a language model make
        a judgement no rule can express.
      </p>
    </div>
  );
}

const SAMPLE = `---
name: no-temp-tables
description: Temporary tables must not reach the warehouse.
kind: check
rule: forbidden-words
severity: blocking
config:
  words: [tmp, temp]
  kinds: [table]
---

A table named \`tmp_\` outlives the person who created it. If it is
worth keeping it is worth naming properly.`;

/** A shield with a check inside it, drawn rather than an icon scaled up. */
function ShieldArt(): JSX.Element {
  return (
    <svg
      className="skills__art"
      viewBox="0 0 64 72"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M32 3 6 13v24c0 16 11 27 26 32 15-5 26-16 26-32V13L32 3Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M21 36l8 8 15-16"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.5"
      />
    </svg>
  );
}
