---
name: every-table-has-a-grain
description: A table without a stated grain is the most expensive missing sentence in a warehouse.
kind: check
rule: required-field
severity: blocking
enabled: true
config:
  field: grain
  kinds: [table]
---

# Every table states its grain

One row per what?

It is the single most useful sentence anybody can write about a table, and the one nobody
writes. "One row per customer per period of validity" answers most of the questions a
downstream analyst would otherwise ask in Slack, and it is the fact that decides whether a
join fans out.

This is **blocking** rather than advisory on purpose. Grain is cheap to write while you are
designing the table and expensive to reconstruct six months later from the data. If the
author cannot say what one row means, the table is not finished.

Turn it off while importing an existing estate, then turn it back on. A rule that fires two
hundred times on day one gets switched off permanently.
