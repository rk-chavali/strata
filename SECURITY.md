# Security policy

## Reporting a vulnerability

**Please do not open a public issue.** A public issue is a disclosure, not a report, and it
tells everyone running Strata about the problem at the same moment it tells us.

Use one of these instead:

- **GitHub private vulnerability reporting.** Go to the Security tab, then "Report a
  vulnerability". This is the preferred route because it keeps the whole thread in one place.
- **Email:** `chavali.r@northeastern.edu`

> **Maintainers: replace the address above before making this repository public.** A security
> policy that points nowhere is worse than none, because a researcher who tries it and gets a
> bounce will post publicly instead.

Please include:

- What you found, and roughly how bad you think it is
- The steps to reproduce it, including the deployment shape (Docker, Kubernetes, or Node
  directly) and whether authentication was on
- The version or commit you tested

You do not need a working exploit. A clear description of the flaw is enough.

## What to expect

| When | What happens |
|---|---|
| Within 3 working days | We acknowledge that we received it |
| Within 10 working days | We tell you whether we agree it is a vulnerability, and roughly when a fix will land |
| On release | We credit you, unless you would rather we did not |

We will not take legal action against anyone who reports in good faith, tests only against
their own instance, and gives us a reasonable window before going public.

## What is in scope

The Strata server, the web UI, the CLI, the container image, and the Helm chart in this
repository.

Things we would especially like to hear about:

- Anything that lets a user act above their role
- Anything that lets one tenant read or write another tenant's workspace or credentials
- Anything that escapes the workspace directory on the filesystem
- Anything that makes the server send a request somewhere it should not
- Anything that gets a stored credential back out to a browser
- Anything that turns model content into executed code or unescaped HTML

## What is out of scope

These are either not vulnerabilities or are already documented behaviour. Reporting them
takes time away from real findings.

- **`STRATA_AUTH=off` allowing anyone to edit.** That is what the setting does. It is documented
  as needing something else in front of it.
- **An admin reaching an internal URL when `STRATA_SSRF_ALLOW` names that host.** That is the
  escape hatch working as designed.
- **Denial of service through very large model files.** Known and documented. `loadWorkspace`
  parses what is in the repository, and a repository you control can always be made slow to
  parse. We will still take a report where a *small* input causes disproportionate work.
- **Missing security headers on a deployment that has overridden them.**
- **Anything requiring an attacker to already have shell access to the container.**
- **Findings from an automated scanner with no demonstrated impact.** We read these last.

## Things you should know about the design

Stating these up front so a reviewer does not have to re-derive them.

**What Strata is responsible for:** authentication and role enforcement on every route,
encrypting stored credentials, never returning secrets to the browser, refusing path escapes,
escaping generated output, never executing model content, and refusing outbound requests to
private address ranges.

**What the operator is responsible for:** TLS termination, network exposure, the durability
and backup of the data volume, the scope of the GitHub token, the service account's IAM
permissions, and branch protection on the model repository. Strata generates `CODEOWNERS` and can
block a proposal, but nothing stops a direct push to `main` if the repository does not require
review. The governance story is only as strong as the repository settings underneath it.

**Neither is responsible for** the correctness of a model somebody approved. Strata validates
structure. It does not validate business meaning.

## Known limits, stated plainly

- **There is no SSO.** Authentication is local accounts with scrypt password hashes and no
  second factor. For an internet-facing instance this is a weak posture, and the honest advice
  is to put an authenticating proxy in front of it or wait for OIDC.
- **Agent skills read model content that arrives by pull request.** A table description can
  attempt to steer a language model's verdict. The blast radius is limited on purpose: agent
  skills report findings and have no write path. Treat that limit as a deliberate invariant.
- **One replica is the supported shape.** Running two against one git working tree will
  corrupt it. This is a correctness constraint, not a scaling preference.
