---
name: personal-data-is-classified
description: Most of the warehouse should carry a classification before anyone calls it governed.
kind: check
rule: classification-coverage
severity: advisory
enabled: false
config:
  minimum: 0.8
---

# Personal data is classified

Classification is what turns a model into something a compliance reviewer can use. It is
also what drives BigQuery policy tags, so a column classified here becomes a column access
policy in the warehouse rather than a note in a spreadsheet.

This rule fails a model whose coverage falls below **80%**.

**Off by default**, and that is the honest setting for a rule like this. Point strata at an
existing warehouse and coverage starts near zero, so switching this on immediately means
every pull request fails for a reason unrelated to the change in it. That teaches people to
ignore the gate.

The sequence that works: import the estate, use the suggestions on the Governance page to
classify the obvious columns in bulk, agree the remainder as a team, then turn this on to
stop it regressing. A ratchet, not a wall.
