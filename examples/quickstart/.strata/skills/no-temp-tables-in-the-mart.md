---
name: no-temp-tables-in-the-mart
description: Names like tmp, test and copy are scratch work that escaped into a model.
kind: check
rule: forbidden-words
severity: blocking
enabled: true
config:
  words: [tmp, temp, test, copy, backup, old, new, final, delete_me]
  kinds: [table, entity]
---

# No scratch names

`customer_tmp`, `orders_copy_final`, `dim_product_new`. Every warehouse has them, and every
one of them started as a five minute experiment that somebody meant to clean up.

The cost is not tidiness. It is that nobody can tell which one is real. An analyst joining
`dim_customer_new` because it sounds newer, and getting a table that stopped loading in
March, is a data quality incident with a naming cause.

**Blocking**, because the fix is to rename the thing before it merges, which takes seconds,
and because a scratch name that reaches `main` tends to stay for years.

`final` is on the list deliberately. It never is.
