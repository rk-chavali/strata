---
name: describe-what-you-ship
description: Tables and entities carry a description, so the dictionary is worth reading.
kind: check
rule: required-description
severity: advisory
enabled: true
config:
  kinds: [table, entity]
---

# Describe what you ship

The generated data dictionary is the artefact most people outside this tool will ever see:
an auditor, a downstream analyst, a new joiner on their first day. A dictionary of names with
no descriptions tells them nothing they could not have got from `INFORMATION_SCHEMA`.

**Advisory, not blocking.** A missing description is a gap, not a defect, and blocking a
schema change over prose is how a governance tool earns a reputation for getting in the way.
It shows up on the pull request, where the reviewer can decide whether it matters this time.

Scoped to tables and entities rather than every object. Relationships and mappings are
usually self-describing from their ends, and demanding a sentence for each one produces
filler nobody reads.
