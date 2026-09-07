# Changelog

Maintained by [release-please](https://github.com/googleapis/release-please) from Conventional
Commits on `main`. Please do not edit it by hand: the next release regenerates the section it
would have changed.

## What a version number promises

Semantic versioning, and these are the surfaces it covers:

- **The model file format.** The YAML under your `roots`. A key changing meaning or going away
  is a major bump. New optional keys are a minor: the loader ignores keys it does not know, so
  a file written by a newer Strata still loads in an older one, and it now warns about the
  parts it discarded rather than dropping them in silence.
- **The CLI.** Command names, flags, and exit codes. `strata check` returning `1` for findings
  and `2` for usage errors is part of the contract, because it is what your pipeline branches on.
- **The HTTP API.** Route paths and response shapes.

Generated output is deliberately not covered. Better DDL for the same model is a patch, and
pinning a version to freeze SQL formatting is not a use we support.

## 1.0.0

First public release.
