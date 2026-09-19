## What this changes

<!-- One or two sentences. The title says what; this says why it is worth doing. -->

## Why this way

<!--
This repo's comment style asks you to name the alternative you rejected. Same here: if there
was an obvious simpler approach that does not work, say what breaks. That is the part a
reviewer cannot recover from the diff.
-->

## Checks

- [ ] `pnpm lint` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] New behaviour has a test that fails without the change
- [ ] The PR title follows Conventional Commits (see CONTRIBUTING.md); CI checks this

## If this touches the route layer

- [ ] Every new route has a role guard, or an `INTENTIONALLY_OPEN` entry saying why it is public

## If this adds a runtime dependency

The server ships with two. Please say what the dependency buys and what writing it by hand
would cost.
