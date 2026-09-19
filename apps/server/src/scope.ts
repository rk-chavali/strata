/**
 * Turning a model or domain scope into the set of files it covers.
 *
 * Used by the history routes and by the write routes, which is why it lives here rather than
 * in either. The distinction between `undefined` and an empty array is the whole subtlety and
 * is spelled out below.
 */
import { type LoadedWorkspace } from "@strata/storage";

/**
 * The repo-relative files behind a model or a domain.
 *
 * `undefined` means "do not scope", the whole repository, which is what an unqualified
 * request asks for. An empty array is different and meaningful: a model that exists but has
 * no files on disk yet has an empty history, not the workspace's.
 *
 * The model object's own file is included alongside its members', because renaming the model
 * or changing its target edits that file and nothing else, and a history that omitted it
 * would silently drop exactly the changes this feature exists to show.
 */
export function historyPaths(
  workspace: LoadedWorkspace,
  scope: { model?: string; domain?: string },
): string[] | undefined {
  if (!scope.model && !scope.domain) return undefined;

  const models = workspace.graph
    .models()
    .filter((entry) =>
      scope.model
        ? entry.object.name === scope.model
        : (entry.object.namespace ?? "Ungrouped") === scope.domain,
    );

  const paths = new Set<string>();
  for (const entry of models) {
    const own = workspace.pathById.get(entry.object.id);
    if (own) paths.add(own);
    for (const member of workspace.graph.inModel(entry.object.name)) {
      const path = workspace.pathById.get(member.object.id);
      if (path) paths.add(path);
    }
  }

  return [...paths];
}
