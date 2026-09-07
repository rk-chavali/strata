/**
 * The version the CLI reports.
 *
 * Its own module because two places need it and neither should own it: `cli.ts` prints it
 * for `--version`, and `mcp.ts` sends it as `serverInfo.version` in the MCP handshake. It
 * was written out by hand in both, so they could disagree, and both were a release behind
 * the moment anything shipped.
 *
 * The trailing annotation is not decoration. `release-please` finds the version to rewrite
 * by looking for that marker, so removing it makes `strata --version` start lying again the
 * next time a release goes out. That matters more than it sounds: the bug report template
 * asks people to paste this number, and triage starts from it.
 */
export const VERSION = "1.0.0"; // x-release-please-version
