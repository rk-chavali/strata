---
name: does-the-grain-match-the-name
description: A judgement no deterministic rule can make, so it asks a model instead.
kind: agent
severity: advisory
enabled: false
---

Read each table's name, its stated grain, and its primary key.

Report a table where the three disagree. The cases worth reporting are:

- the name is singular but the grain describes many rows per subject
- the primary key has more columns than the grain implies, which usually means the grain
  sentence is out of date rather than the key being wrong
- the name says `dim_` but the grain describes an event, or `fct_` but the grain describes
  an entity that does not change

Do not report a table merely because its description is short, and do not suggest better
names. One finding per table, naming the specific disagreement.

---

# Why this one is an agent

Everything else in this directory is a deterministic rule: a field is present or it is not,
a word appears or it does not. That covers most of what a team wants to enforce, it runs
instantly, and it costs nothing.

"Does this table's grain match its name" is not that. It needs reading comprehension over
three pieces of prose and structure, and no amount of configuration turns it into a regex.

Two things to know before you switch it on:

**It needs a key.** Agent skills call a language model using a credential the *operator*
supplies, never one shipped in the image. With no key configured this reports itself
**skipped** rather than passing, because a governance control that quietly does nothing is
worse than one that is visibly off.

**It can only report.** An agent skill has no write path, by design. Model content arrives
by pull request, so a table description is untrusted input reaching a prompt, and somebody
could write a description that instructs the model to report nothing. The blast radius of
that is a missed advisory finding. It stays that way deliberately: read the threat model
again before ever giving one of these the ability to act.
