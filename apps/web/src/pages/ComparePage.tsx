import type { JSX } from "react";
import { Page } from "../app/Page";
import { useWorkspace } from "../app/WorkspaceContext";
import { Button, EmptyState } from "../ui";
import { ComparePane } from "../components/ComparePane";
import { modelOf, type Router } from "../app/routes";

/**
 * Drift between two models.
 *
 * A page rather than a takeover of the canvas, a difference table needs the full width,
 * and previously getting to it meant leaving the diagram with no way back except the
 * browser button.
 *
 * Read-only by design: this reports, it never reconciles. Automatically "fixing" drift
 * between a logical and a physical model means guessing which side is right, and that guess
 * would land as a commit in someone's repository.
 */

export function ComparePage({ router }: { router: Router }): JSX.Element {
  const { workspace } = useWorkspace();
  const models = workspace?.models ?? [];

  return (
    <Page
      title="Compare"
      subtitle="Find drift between two models, usually adjacent tiers of the same domain, which is where it accumulates"
    >
      {models.length < 2 ? (
        <EmptyState
          icon="compare"
          title="Nothing to compare yet"
          body="Comparison needs two models. The pairs worth comparing are adjacent tiers of one domain, a logical model against the physical model derived from it, because those two were designed together and then edited apart."
          action={
            <Button
              variant="primary"
              icon="grid"
              onClick={() => router.go({ name: "overview" })}
            >
              Back to overview
            </Button>
          }
        />
      ) : (
        <ComparePane
          currentModel={modelOf(router.route)}
          onOpenModel={(name) => router.go({ name: "model", model: name, tab: "diagram" })}
        />
      )}
    </Page>
  );
}
