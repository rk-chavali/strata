# Contributing to Strata

Thanks for looking. This file covers how to run the project, how it is tested, and the
few house rules that are not obvious from reading the code.

## Getting it running

You need Node 20.11 or newer, pnpm 9, and git.

```bash
pnpm install
pnpm build
```

Then two terminals:

```bash
pnpm dev:server
```

```bash
pnpm dev:web
```

Open http://localhost:5173. It loads `examples/quickstart`, a small shop modelled across
all three tiers. Point it at your own repo with `STRATA_WORKSPACE=/path/to/models pnpm dev:server`.

## Before you open a pull request

```bash
pnpm lint
pnpm typecheck
pnpm test
```

All three must pass. CI runs the same three commands on four legs (Node 20 and 22, on Linux
and Windows), plus a Docker image build and a dependency audit. It also runs `strata check`
against the example workspace, because if we ask every customer to put that gate in their
pipeline it belongs in ours.

Windows is in the matrix on purpose. This is a tool whose whole job is files and git, which
is exactly where Windows differs: path separators, line endings, and files that cannot be
deleted while a handle is open.

## Linting

`pnpm lint` runs [oxlint](https://oxc.rs). The tree is clean, and CI runs it with
`--deny-warnings`, so a new warning fails the build. `pnpm lint:fix` fixes the mechanical
ones.

There is no separate formatter, deliberately. The code is already consistent and tsc plus
oxlint cover the classes of problem that actually cause bugs. A formatter is worth adding the
first time a review argues about whitespace, and not before: adopting one now would rewrite
roughly 140 of 248 source files to settle an argument nobody is having.

Two lint rules are disabled inline, both in `no-control-regex`, both with a comment saying
why. If you need a third exception, put the reason next to it rather than in a config file
where it loses its context.

## Commit messages and PR titles

This project uses [Conventional Commits](https://www.conventionalcommits.org/), and CI checks
the **pull request title** rather than the individual commits. Pull requests are squash
merged, so the title is what lands on `main` verbatim; the "wip" commits inside your branch
are nobody's business.

```text
<type>(<scope>): <description>
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `revert`.
Scopes are the workspace names (`server`, `web`, `cli`, `ddl`, `import`, `metamodel`, `query`,
`storage`) plus `docs`, `deploy`, `ci` and `deps`. The scope is optional, because a change
that genuinely spans the tree should not have to pick a misleading one.

A `!` before the colon marks a breaking change: `feat(metamodel)!: drop the v1 domain shape`.

This is not enforced for tidiness. `release-please` reads these prefixes to decide the next
version number and to write `CHANGELOG.md`, so a title it cannot parse produces a release
note that silently omits your change.

## How a release happens

You do not tag anything by hand. `release-please` watches `main` and keeps a release pull
request open with the computed version bump and the changelog entries. Merging that pull
request is the act of releasing: it tags `vX.Y.Z`, which publishes the container image and
the Helm chart.

The whole monorepo shares one version. Eight workspaces, but exactly one thing anybody
installs, and per-package versions would be eight numbers describing a single artefact.

## Coverage

```bash
pnpm test:coverage
```

Line coverage today, so nobody has to guess where the thin ice is:

| Workspace | Lines |
| --- | --- |
| `packages/import` | 90.6% |
| `packages/ddl` | 87.8% |
| `packages/storage` | 86.3% |
| `packages/metamodel` | 79.8% |
| `packages/cli` | 76.0% |
| `apps/server` | 60.6% |
| `packages/query` | 58.7% |
| `apps/web` | **2.7%** |

`apps/web` is the honest gap: 73 source files, 3 test files. The server and the packages are
genuinely covered, the UI essentially is not. A pull request that adds UI tests is welcome and
does not need an issue first.

There is no enforced threshold yet. Add one per workspace when somebody actually regresses a
number, not before; a threshold pinned to today's figure is a ratchet nobody is currently
pushing against.

## How this project tests

There is a strong opinion here and it is worth stating, because it is not the common one.

**Verify by measuring, not by inspecting.** A test that asserts we called the function we
wrote proves nothing about whether the function works. So:

- `dispatch.test.ts` posts to a real HTTP server on loopback instead of mocking `fetch`. A
  real socket proves the request is well formed enough for a server to parse.
- `routes.test.ts` boots the real express app on a real port and makes real requests. It
  does not mock the auth store or stub the router.
- `bootstrap.test.ts` and `watcher.test.ts` create real git repositories and commit to them.

This makes the suite slower than a mock-heavy one. That is the trade, and it is deliberate:
the three worst defects this codebase has shipped were all in code that mocks would have
reported as working.

**The route layer has audits, not just tests.** `routes.test.ts` walks the express router and
asserts a property of every route that exists: each one has a role guard, or an entry in
`INTENTIONALLY_OPEN` saying why it is public. Add a route without a guard and the suite fails.
That is on purpose. Three separate defects shipped through the route layer while it had no
coverage at all.

If you add an unauthenticated route, add it to `INTENTIONALLY_OPEN` with a reason. A reviewer
will see that line in the diff, which is the point.

## Comment style

This repo comments unusually heavily, and the style is specific. Please match it.

**Comments explain why, not what.** The code already says what it does. A comment earns its
place by recording a decision somebody would otherwise reverse by accident.

Good:

```ts
// Modification time, not creation time.
//
// An active visitor keeps writing files, so mtime is a liveness signal. Expiring on
// creation time would delete the workspace of somebody in the middle of using it.
```

Not useful:

```ts
// Get the file stats and check the time
```

**Name the alternative you rejected.** Most of the valuable comments here say "we did X
rather than Y, because Y fails when Z". That is the information a future reader needs and
cannot recover from the code.

**Say when something is a real constraint.** One replica is not a tuning preference, it is a
correctness constraint, because two pods writing one git working tree corrupt it. Comments
that say so stop somebody helpfully scaling it up.

This style will get sanded away by the first ten contributors unless it is written down, so
here it is written down.

## Things this project deliberately does not do

Saying these out loud saves the same argument recurring in every issue thread.

- **No fuzzy name matching in classification.** A classifier that guesses is a classifier
  nobody trusts, and an incorrect confident guess about personal data is worse than no guess.
- **The MCP server is read only, structurally.** Nothing it imports can mutate a workspace. An
  agent that wants to change a model opens a pull request like a person does.
- **Agent skills advise, they do not validate.** They report findings. They have no write path,
  and they should not get one without re-examining prompt injection, because model content
  arrives by pull request.
- **Strata does not own approval.** It generates `CODEOWNERS`; your branch protection enforces it.
  A modelling tool that tried to own approval would be duplicating and fighting the controls
  the organisation already trusts.
- **No licensing, seat counting or activation.** Nothing phones home.

If you want to change one of these, that is a conversation worth having in an issue first.
They are decisions, not oversights.

## Runtime dependencies

The server has two: `express` and `cors`. That is a genuine strength and we would like to
keep it. If a change needs a third, please say in the pull request what it buys and what
writing it by hand would cost. Several things here are hand written for exactly this reason,
including the tar writer, the security headers and the MCP transport.

Development and test dependencies are held to a much looser standard, because they do not
ship in the image.

## Line endings

Model files are always written with LF. `strata init` writes a `.gitattributes` that pins this.
Without it, git on Windows checks files back out as CRLF and every file looks modified, which
buries the diffs this tool exists to produce.

## Reporting a security issue

Please do not open a public issue. See [SECURITY.md](SECURITY.md).

## Conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Disagree about the code as much as you like; do not
make it about the person.
