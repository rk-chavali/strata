# Self-hosting Strata

Everything runs in your infrastructure. The tool talks to exactly two things outside
itself, both optional and both yours: **your GitHub** (to raise pull requests) and, later,
**your LLM endpoint**. It never phones home, and there is no vendor service in the path.

---

## What it stores, and where

This is the first question every security review asks, so it is the first thing here.

**There is no database.** The model *is* files in your git repository.

| What | Where it lives | In your repo? |
|---|---|---|
| Models, conceptual, logical, physical | YAML files | **yes** |
| Diagrams, layout, shapes | separate YAML files | **yes** |
| Settings, lint rules, conventions | `strata.config.yaml` | **yes** |
| Generated DDL and CODEOWNERS | `DDL/`, `CODEOWNERS` | **yes** |
| User accounts and password hashes | `STRATA_DATA_DIR` volume | **no** |
| Session signing secret | `STRATA_DATA_DIR` volume | **no** |
| Encrypted GitHub token | `STRATA_DATA_DIR` volume | **no** |

The server is a stateless reader and writer over the git working tree. `git log` on a
model file *is* the audit trail, there is no second history to reconcile it against.

The only state outside the repo is the auth volume, which holds precisely the things that
must never be committed. Back that up; everything else is already in git.

### Volume ownership

The container runs as uid **10001**, not root. The image creates `/workspace` and `/data` owned
by that user, so Docker volumes and the default paths work with no extra step.

A **bind mount** is the exception, because its ownership comes from the host, not the image. On
Linux, mounting a directory owned by a different uid gives "permission denied" the first time
strata writes. Either chown it once:

```bash
sudo chown -R 10001:10001 /srv/data-models
```

or run as the owning user instead:

```bash
docker run --user "$(id -u):$(id -g)" -v /srv/data-models:/workspace ...
```

Docker Desktop on macOS and Windows handles this for you; only Linux hosts need it.

On Kubernetes, set `fsGroup: 10001` in the pod security context. The chart already does.

---

## Quick start

One command, nothing to clone and nothing to build:

```bash
docker run --rm -p 4000:4000 -v "$PWD/models:/workspace" ghcr.io/rk-chavali/strata:latest
```

Then open <http://localhost:4000> and create the first administrator. The account you
create first is the admin; there is no default password to forget to change.

That is enough to look around. It is not enough to keep anything: `--rm` throws the
container away, and accounts and the session secret live inside it. For a setup that
survives a restart, use the Compose file below.

---

## Where the packages are

Two published artefacts, both public. Neither needs a login, an account or a clone.

| What | Pull it with | Every version |
|---|---|---|
| Container image | `docker pull ghcr.io/rk-chavali/strata:latest` | [Package page](https://github.com/users/rk-chavali/packages/container/package/strata) |
| Helm chart | `helm pull oci://ghcr.io/rk-chavali/charts/strata` | [Package page](https://github.com/users/rk-chavali/packages/container/package/charts%2Fstrata) |

The image is built for `linux/amd64` and `linux/arm64`, so it runs on an Apple Silicon laptop
and on the ARM instances most free cloud tiers offer.

`latest` is the newest release and is what the examples here use. Every tag ever published is
listed on the package page, along with when it was pushed.

**Pin a version for production.** `latest` moves across major versions, so a routine
`docker compose pull` can bring a breaking change on a Tuesday morning:

```yaml
image: ghcr.io/rk-chavali/strata:1.0.0
```

Helm takes the newest chart when no `--version` is given, and `--version 1.0.0` pins it the
same way.

---

## Configuration

Every option is an environment variable. None are required to start.

### Where the model lives

| Variable | Default | What it does |
|---|---|---|
| `STRATA_WORKSPACE` | `examples/quickstart` | Path to the git repo holding your models. Mount your clone here. |
| `STRATA_DATA_DIR` | `.strata-data` | Accounts, session secret, encrypted secrets. **Persist this volume.** |
| `PORT` | `4000` | HTTP port. |

### Authentication

| Variable | Default | What it does |
|---|---|---|
| `STRATA_AUTH` | on | Set to `off` to disable sign-in entirely. |
| `STRATA_AUTH_DISABLED` | `false` | Legacy alias for `STRATA_AUTH=off`. Either turns auth off; prefer `STRATA_AUTH`. |
| `STRATA_COOKIE_SECURE` | `false` | Set to `true` when serving over HTTPS. |

Auth is **on by default**. A tool that writes to a shared repo should not be open to
anyone who can reach the port, and defaulting to insecure means most deployments quietly
stay that way.

Sessions are stateless signed tokens rather than a server-side table, so a restart or a
redeploy does not sign everyone out. The cookie carries only a user id and an expiry, the role is read fresh from disk on **every request**, so demoting someone or disabling
an account takes effect on their very next click, with no stale-token window.

Roles are `viewer` (read), `editor` (change models, raise PRs) and `admin` (settings,
users, secrets). The UI hides what your role cannot do; the server enforces it.

> **For a real enterprise rollout, put OIDC/SAML in front of this.** Local accounts are
> deliberately simple. The role model is shaped so an IdP can supply identity while these
> roles stay the authorisation layer.

### Adding the rest of your team

Two ways, from **Settings, Users**.

**Send an invitation.** Pick a role, create the invitation, copy the link, and send it however
your team already talks. The person opens it, chooses their own username and password, and
arrives signed in.

**Or create the account directly.** Faster when the person is next to you, but you choose their
password, so you know it and it usually reaches them over chat in plain text. Prefer an
invitation for anyone you cannot simply tell.

**No mail server is required, and there is nothing to configure.** Strata does not send email.
The link *is* the invitation:

- single use, and dead the moment it is redeemed
- expires after seven days
- revocable from the same screen while it is still pending
- the code travels in the link's `#fragment`, which browsers never send to a server, so it does
  not appear in access logs or in a proxy's records along the way

The role comes from the invitation rather than from whoever redeems it, so a viewer invitation
cannot produce an admin. Issuing, revoking and redeeming are all written to the audit log.

### Emailing invitations (optional)

Strata can send invitations itself instead of you copying the link. It is off until configured,
and everything still works without it.

Set these as secrets, either in **Settings, Git and secrets** or as environment variables. Every
one takes a `STRATA_SECRET_` prefix with dots becoming underscores, so `smtp.host` is
`STRATA_SECRET_SMTP_HOST`.

| Secret | Required | What it is |
|---|---|---|
| `smtp.host` | yes | Hostname of the mail server, for example `smtp.sendgrid.net`. Not an IP. |
| `smtp.from` | yes | The address invitations come from. |
| `smtp.port` | no | 587 for STARTTLS, 465 for implicit TLS, 25 unencrypted. Defaults to 587. |
| `smtp.username` | no | Leave empty for an internal relay that accepts local mail unauthenticated. |
| `smtp.password` | no | An app password or API key, never an account password. |
| `smtp.from_name` | no | Display name on the message. |
| `smtp.security` | no | `auto` (default), `tls`, `starttls`, or `none` for a relay on localhost. |

Host and from address are the two that decide whether mail works at all.

**The from address has to be one your provider will send as.** This is the setting that goes
wrong most often, and the failure is quiet: the message is accepted and then dropped or filed as
junk. If invitations are not arriving and nothing is reporting an error, check this first.

**Sending is best effort, by design.** The invitation exists and its link is shown whether or not
the email goes out, so a mail server that is down costs a copy and paste rather than the
invitation. Failures are reported in the UI and written to the audit log.

The SSRF guard that applies to integrations does **not** apply here. Plenty of companies relay
through an internal mail server on a private address, and blocking that would break the common
case.

### Seeding the administrator

| Variable | What it does |
|---|---|
| `STRATA_ADMIN_USERNAME` | Username of the administrator to create at boot, if no account exists yet. |
| `STRATA_ADMIN_PASSWORD_HASH` | scrypt hash of that account's password. Generate one with `strata hash-password`. Preferred. |
| `STRATA_ADMIN_PASSWORD` | Plain password, as an alternative to the hash. Easier to try, worse to store. |

**Set these on any instance reachable from a network you do not control.**

First-run setup has to be open to somebody, or nobody could ever create the first account.
It closes as soon as an account exists. The problem is what happens when the data directory
goes away: `needsSetup()` becomes true again, the route reopens, and the next person to load
the page becomes the administrator. That is not hypothetical. `persistence.enabled: false` in
the Helm chart mounts an `emptyDir`, so every pod restart empties `/data`. Forgetting the
volume in `docker run` does the same thing.

With a seed configured there is no window at all, because the account is created before the
server starts listening.

Seeding runs only when there are no accounts. Leaving the variables in place after the first
boot is safe and does nothing, so a password rotation done in the UI is never silently undone.
A malformed `STRATA_ADMIN_PASSWORD_HASH` stops the server rather than booting without an admin.

### Network and browser security

| Variable | Default | What it does |
|---|---|---|
| `STRATA_ALLOWED_ORIGINS` | empty | Comma separated origins allowed to call the API cross-site. Empty means same-origin only. |
| `STRATA_CSP_CONNECT_SRC` | empty | Extra `connect-src` values for the content security policy. Needed only when the API is on another origin. |
| `STRATA_SSRF_ALLOW` | empty | Comma separated hosts that may resolve to a private or link-local address. |
| `STRATA_TRUST_PROXY` | `false` | Set to `true` when Strata sits behind a proxy or ingress, so `X-Forwarded-For` is believed. |

Strata refuses outbound requests to loopback, link-local and private address ranges. This
matters because several URLs are supplied by an operator through a form: the webhook target
and the Confluence and Jira site URLs. On a cloud instance the address that matters is
`169.254.169.254`, the metadata endpoint, which hands out the node's own credentials to
anything that can reach it.

If your Jira really is at `jira.internal`, add it:

```
STRATA_SSRF_ALLOW=jira.internal,confluence.internal
```

Redirects are followed by hand and every hop is checked, so a permitted host cannot bounce
the request somewhere the check would have refused.

`STRATA_TRUST_PROXY` affects the sign-in throttle. Left off, every request behind an ingress
counts against one address, so one attacker can lock out a whole company. Turned on without a
proxy in front, a client can send any address it likes and defeat the throttle entirely. Set
it to match your actual deployment.

### Logging

| Variable | Default | What it does |
|---|---|---|
| `STRATA_LOG_REQUESTS` | `false` | Log a line for every request, not just failures. |
| `STRATA_VERSION` | empty | Version string reported by `/api/health/detail`. |
| `STRATA_COMMIT` | empty | Commit hash reported by `/api/health/detail`. |

Logs are one JSON object per line on stdout, which is what every container platform
collects. Failures are always logged. Successes are not, unless you turn them on, because a
healthy canvas produces hundreds of uninteresting requests a minute.

Every response carries an `x-request-id` header, and an unexpected error shows that id to
the user. When somebody reports a failure, that id finds the exact log line.

### The model repository

| Variable | What it does |
|---|---|
| `STRATA_MODEL_REPO` | HTTPS URL to clone on startup when the workspace is empty. Used on Kubernetes, where there is no host directory to bind-mount. |
| `STRATA_MODEL_BRANCH` | Branch to check out. Empty uses the repository's default. |
| `STRATA_WEB_DIST` | Where the built UI lives. Set by the image; override only if you serve the UI from elsewhere. |

### Trial mode: one workspace per visitor

**Off by default.** Unset `STRATA_TENANT_DIR` and the server behaves exactly as a self-hosted
instance always has: one mounted repository, shared by everyone who signs in. Everything below is
inert until a deployment opts in.

Set it, and each visitor gets their own workspace directory, identified by a signed cookie. This
is what makes a public trial possible, without it the first visitor and the second would be
editing the same model.

| Variable | Default | What it does |
|---|---|---|
| `STRATA_TENANT_DIR` | none | Directory holding one subdirectory per visitor. Setting it turns trial mode on. |
| `STRATA_TENANT_SEED` | none | Workspace to copy for each new visitor, so they land on something rather than an empty screen. `.git` is never copied. |
| `STRATA_TENANT_TTL_MS` | 7 days | Delete a workspace this long after its last change. `0` disables expiry. Expiry is on *modification* time, so an active visitor is never cut off mid-session. |

Tenant ids are generated by the server and the cookie is HMAC-signed with the session secret, so a
visitor cannot guess or forge their way into another workspace. A cookie that fails verification
gets a fresh workspace rather than an error.

**Persist `STRATA_TENANT_DIR` on the same volume as `STRATA_DATA_DIR`.** The cookie is signed with the
session secret, so losing the data directory makes every existing trial workspace unreachable.

### Cloud mode: sign in with GitHub

**Off by default, and separate from trial mode above.** Trial mode hands every visitor an
anonymous scratch directory. Cloud mode gives people accounts: they sign in with GitHub, choose a
repository they already have access to, and that repository becomes the workspace.

This is the mode to use if you are running strata *for other people* rather than for your own
team. It needs `STRATA_TENANT_DIR` set as well, because one workspace shared by every customer is
exactly what tenant directories exist to prevent.

| Variable | Default | What it does |
|---|---|---|
| `STRATA_CLOUD_CLIENT_ID` | none | Client id of a GitHub OAuth app. Setting all three turns cloud mode on. |
| `STRATA_CLOUD_CLIENT_SECRET` | none | Client secret of that OAuth app. Treat it as a password. |
| `STRATA_CLOUD_BASE_URL` | none | Public URL of this instance, for example `https://app.example.com`. Used to build the OAuth redirect, so it has to match what the OAuth app is registered with. |
| `STRATA_CLOUD_GITHUB_URL` | `https://github.com` | Set to your GitHub Enterprise Server, for example `https://ghe.example.com`. Enterprise Cloud is `github.com` with SAML in front, so it needs no change here. |
| `STRATA_CLOUD_API_URL` | derived | Derived from the above as `/api/v3`, which is where Enterprise Server serves the REST API. Set it only if yours is somewhere else. |

**All four are required, including `STRATA_TENANT_DIR`.** That last one is not named like a cloud
setting and is the one people miss. Without it, cloud mode is off: no GitHub button, a local
sign-in form instead. The server says so at boot, naming the missing variable, so check the log
before assuming you deployed the wrong build.

Create the OAuth app at **Settings, Developer settings, OAuth Apps** in GitHub, with the callback
URL set to `<STRATA_CLOUD_BASE_URL>/api/cloud/callback`.

**Three things follow from the repository being the workspace, and they are the reason to prefer
this design:**

- **Onboarding is repository access.** You add a colleague to the repository in GitHub and they can
  sign in. There is no separate invitation to send and no membership list to keep up to date.
- **Roles come from GitHub.** Admin on the repository is admin here, write access is editor, read
  access is viewer. An unrecognised permission set is treated as viewer, so a change at GitHub's
  end can only ever reduce access.
- **You are not the system of record.** Models stay in the customer's repository. What this
  instance keeps is a working checkout that can be deleted and re-cloned at any time.

Access is re-checked against GitHub whenever a workspace is opened, so access removed there is
access removed here, with nothing to synchronise.

**Sessions carry a live GitHub token, so they are encrypted rather than signed.** Losing
`STRATA_DATA_DIR` invalidates every session and signs everyone out, which is recoverable. Serving
this over plain HTTP is not: set `STRATA_COOKIE_SECURE=true` behind TLS.

### Turning features off for a deployment

| Variable | Default | What it does |
|---|---|---|
| `STRATA_FEATURES` | all on | Comma-separated list of features this deployment permits: `integrations`, `skills`, `bigquery`. |

This is deliberately *not* something an admin can change from the UI. A hosted trial should set
`STRATA_FEATURES=skills` and leave integrations off: a visitor who can point the webhook provider at
a URL of their choosing has an outbound-request primitive aimed at your network, and no in-app
toggle should be able to re-enable that on infrastructure they do not own.

Self-hosted deployments normally leave this unset, the operator owns the network and the risk.

### Merge detection

Strata notices a merge by polling the default branch, because a webhook receiver would mean asking
you to expose a port to GitHub.

| Variable | Default | What it does |
|---|---|---|
| `STRATA_WATCH_INTERVAL_MS` | `60000` | How often the default branch is checked. **Set `0` to switch merge detection off entirely**, worth doing on a shared instance behind a rate-limited enterprise remote. |

With polling off, integrations still fire on `proposed` and `validationFailed`; only `merged`
stops. The Integrations page says so at the top rather than leaving you to wonder why nothing
arrives.

### Capability credentials

Two features need a credential that is not an integration and not GitHub. **Prefer storing these
in the app**, Settings holds them in the encrypted secret store, and they survive a restart
without appearing in your deployment manifests, shell history or `kubectl describe`.

| Credential | Set in the app as | Environment fallback |
|---|---|---|
| Model provider API key, for `kind: agent` skills | `skills.apiKey` | `STRATA_SKILLS_API_KEY` |
| Google service account JSON, for the policy tag sync | `gcp.serviceAccount` | `STRATA_GCP_ACCESS_TOKEN` |

| Variable | Default | What it does |
|---|---|---|
| `STRATA_SKILLS_API_KEY` | none | Model provider key. Without it, agent skills report themselves **skipped**, never passed. |
| `STRATA_SKILLS_MODEL` | `claude-sonnet-5` | Which model agent skills run against. |
| `STRATA_GCP_ACCESS_TOKEN` | none | A short-lived token, e.g. from `gcloud auth print-access-token`. |
| `STRATA_GCP_CATALOG_BASE` | Google's public endpoint | Override the Data Catalog host. For VPC Service Controls or a private endpoint. |

`STRATA_GCP_ACCESS_TOKEN` expires in about an hour, so it suits trying the sync out rather than
running it. For a real deployment store the service account key instead: it is signed locally into
a JWT, the key never leaves the process except as a signature, and the token is refreshed per call.
The key's own `token_uri` is honoured, so keys minted for a non-public partition work unchanged.

### Debugging

| Variable | What it does |
|---|---|
| `STRATA_DEBUG` | Print stack traces instead of just the message. Off by default, a stack trace in a CI log is noise. |

### GitHub

| Variable | What it does |
|---|---|
| `STRATA_GITHUB_TOKEN_FILE` | Path to a **mounted file** containing the token. Use this with Secret Manager, Vault or a Kubernetes secret. |
| `GITHUB_TOKEN` | The token directly. Fine for a small deployment. |
| `STRATA_GIT_AUTHOR_NAME` / `STRATA_GIT_AUTHOR_EMAIL` | Fallback commit author when auth is off. |

Precedence is **mounted file → environment variable → pasted in the UI**. A token pasted
in Settings is encrypted at rest with AES-256-GCM under a machine-local key, and the paste
field is disabled when a file or env var is supplying one, so promoting a deployment to a
real secret manager never requires clearing the UI first.

The same token authenticates **both** the push and the pull request. It travels via
`GIT_ASKPASS` in the child process environment, never in `.git/config` and never in
process arguments.

**Token permissions.** Fine-grained PAT, repository access limited to your model repo:

| Permission | Level | Why |
|---|---|---|
| Pull requests | Read and write | Opens the PR |
| Contents | Read and write | Pushes the branch |
| Metadata | Read | Mandatory, auto-selected |

A classic token needs `repo`, which is far more access than this warrants, prefer
fine-grained.

If your deployment already has an SSH agent, deploy key or credential helper, leave the
token unset and it keeps working exactly as before. The token is an addition, never a
replacement.

---

## Secrets with Google Secret Manager

Mount the secret as a file and point the tool at it. The token never appears in the
container's environment, in your compose file, or in `docker inspect`.

```yaml
# Cloud Run
spec:
  containers:
    - image: your-registry/strata:latest
      env:
        - name: STRATA_GITHUB_TOKEN_FILE
          value: /secrets/github/token
      volumeMounts:
        - name: github-token
          mountPath: /secrets/github
          readOnly: true
  volumes:
    - name: github-token
      secret:
        secretName: projects/PROJECT/secrets/strata-github-token
        items:
          - key: latest
            path: token
```

Rotation happens entirely outside the app: replace the secret version, restart, done.
The same shape works for Kubernetes secrets and Vault Agent injection.

---

## Docker Compose

```yaml
services:
  strata:
    image: your-registry/strata:latest
    ports:
      - "4000:4000"
    environment:
      STRATA_WORKSPACE: /workspace
      STRATA_DATA_DIR: /data
      STRATA_COOKIE_SECURE: "true"
      STRATA_GITHUB_TOKEN_FILE: /secrets/github-token
    volumes:
      # Your model repo, a normal clone. The tool commits and pushes from here.
      - ./model-repo:/workspace
      # Accounts and secrets. Losing this means everyone signs up again.
      - strata-data:/data
      - ./secrets/github-token:/secrets/github-token:ro
    restart: unless-stopped

volumes:
  strata-data:
```

---

## Connecting your repository

Two ways, and the tool verifies before it saves either.

**From the UI**, Settings → Git → *Connect a repository*, paste the HTTPS URL. The server
runs `git ls-remote` against it and refuses to save a remote it cannot reach, rolling back
rather than leaving the workspace pointing somewhere unusable.

**By mounting a clone**, point `STRATA_WORKSPACE` at a repo that already has its remote set.

Use the **HTTPS** URL, not SSH: a token cannot authenticate an SSH remote. If you paste a
URL that already embeds a token (copied from a CI config), the credentials are stripped
before the remote is stored.

---

## Running behind a proxy

The UI holds a long-lived server-sent-events connection for presence and live updates.
Proxies that buffer responses will hold those events until the buffer fills, which looks
like the feature silently not working.

```nginx
location /api/events {
    proxy_pass http://strata:4000;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;       # essential
    proxy_read_timeout 3600s;
}
```

The app already sends `X-Accel-Buffering: no`, which nginx honours, the block above is
belt and braces, and covers proxies that do not.

---

## Scaling

**One container is the supported shape, and it is the right one for this tool.** A data
modelling team is tens of people, and the bottleneck is human review, not compute.

If you run more than one replica, two things degrade:

- **Presence and advisory locks are per-process.** Each replica sees only its own share of
  users, and a lock taken on one is invisible on another.
- **The git working tree is shared mutable state.** Two replicas committing to one volume
  will collide.

Neither corrupts your models, git and the revision checks still prevent lost updates, but the collaboration features stop meaning much. If you genuinely need horizontal scale,
that is the point at which presence moves to Redis and each replica gets its own clone.

---

## Why not Cloud Run, or any serverless container

This is the most common question, and the answer is architectural rather than a setting.

**Strata is a stateful single-writer application. Serverless container platforms are built for
stateless multi-instance ones.** The two want opposite things:

| The platform assumes | Strata needs |
|---|---|
| The filesystem is scratch space, gone at shutdown | `STRATA_DATA_DIR` to survive restarts |
| Instances scale out, each with its own disk | Exactly one writer against one git working tree |
| Containers are interchangeable and disposable | A checkout that may hold uncommitted edits |

Two secrets are generated on first boot and written into `STRATA_DATA_DIR`:

- the **session signing secret**, in `auth.json`, which also derives the trial cookie key and the
  cloud session sealing key
- the **secret store key**, in `secret.key`, which encrypts integration credentials

On an ephemeral filesystem both are regenerated on every cold start. In practice that means
everyone is signed out, every stored integration credential becomes undecryptable, and the
accounts file is empty again, which makes `needsSetup` true and hands the next visitor the
administrator account. Seeding the administrator from configuration closes the last of those; it
does not fix the other two.

Cloud Run can be forced to work with a second-generation execution environment, a Filestore NFS
volume mount, and `--min-instances=1 --max-instances=1`. That is a real POSIX filesystem and a
pinned single instance. It is also several hundred dollars a month for a tool that wants a ten
gigabyte disk, and a revision rollout can still briefly overlap two instances on one git tree.

### What to run instead

| Option | Notes |
|---|---|
| **A small VM with Docker Compose** | Cheapest and simplest. A real disk and one process |
| **Kubernetes with a PersistentVolumeClaim** | One replica. The Helm chart is already shaped this way |
| **Fly.io with a volume** | One machine, a real volume |
| **Render with a persistent disk** | Works. The free tier's `/tmp` does not |

The thing that makes strata self-hostable is not a platform. It is **a persistent disk and one
replica**, which is exactly what the compose file and the Helm chart give you.

### The exception

Hosted **cloud mode** is far more tolerant of this, because the workspace there is a disposable
clone of the customer's own GitHub repository: losing it costs a re-clone, not data. The two
secrets above still need somewhere durable, so the requirement does not disappear, but the
working tree stops being precious. Self-hosted mode is the one that genuinely cannot be
ephemeral.

---

## Upgrading

The model format is plain YAML in your repo and the loader is layout-independent: it reads
`kind` and `id` from file *contents*, never from paths. So an upgrade cannot strand your
models, and reorganising the repo is a pure file move.

```bash
docker compose pull && docker compose up -d
```

Both commands read the `docker-compose.yml` from the walkthrough above, which pins a
minor version, so `pull` takes patches and never a major upgrade.

Your data is in git. If an upgrade goes wrong, roll the image back, the models are
untouched.

---

## CI

`strata check` exits non-zero on validation errors. Run it on pull requests so an invalid
model cannot merge.

```yaml
- run: npx @strata/cli check
```

Combined with the generated `CODEOWNERS`, this gives you the governance loop: a change to
a governed model requires the right approver *and* a passing model check.

---

## Troubleshooting

**"No `origin` remote"**, the workspace is a git repo with no remote. Commits stay local
and no PR can open, whatever the token says. Settings → Git shows the exact command.

**Pull request does not open, push succeeds**, the token is missing or lacks
*Pull requests: write*. You get a prefilled compare link instead of a failure.

**"the remote rejected these credentials"**, the token cannot see that repository. For a
fine-grained token, check it lists this repo under *Repository access*.

**Everyone signed out after a redeploy**, `STRATA_DATA_DIR` is not on a persistent volume,
so the session secret was regenerated.

**Presence shows nobody, live updates never arrive**, a proxy is buffering `/api/events`.
See the proxy section above.
