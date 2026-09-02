# Running Strata on Kubernetes

Everything runs in your cluster. The tool talks to exactly one thing outside it, and it is
yours: **your git remote**. It never phones home, and there is no vendor service in the path.

---

## What the deployment owns, and what it does not

This is the part worth reading before the commands, because it decides where changes are
made and reviewed.

| Configuration | Source of truth | Changed by |
|---|---|---|
| Runtime, auth mode, cookie security, workspace path, token source | **this chart's values** | a pull request to your deployment repo, then `helm upgrade` |
| Modelling, lint rules, naming standards, file layout, DDL output, Dataform connections | **`strata.config.yaml` in your model repo** | the UI, which writes that file and raises it as a pull request |
| Identity, accounts and roles | `STRATA_DATA_DIR` on the volume | the UI, admin only |

Runtime configuration supplied by the chart is **read-only in the UI**. Settings shows it
as coming from the deployment rather than letting someone change it in a way the next
`helm upgrade` would silently revert. That is the whole point of the split: one value, one
owner.

Modelling configuration deliberately does *not* live here. A naming standard is a decision
made by data architects and reviewed beside the models it governs, not a platform value in
a Helm chart reviewed by SREs. Editing it in the UI writes `strata.config.yaml`, which appears
in **Changes** and goes out as a pull request, so it is still a reviewed commit rather than
a live mutation.

---

## One replica, and why it is not a tunable

`replicaCount` is fixed at 1 and the strategy is `Recreate`. This is a **correctness**
constraint, not a performance choice:

- Presence and advisory locks are per-process. A second replica sees only its own share of
  users, and a lock taken on one is invisible on the other.
- The git working tree is shared mutable state. Two pods committing into one
  `ReadWriteOnce` volume will collide, and on most storage classes the second pod cannot
  attach the volume at all, so a `RollingUpdate` wedges the rollout instead of finishing it.

Neither corrupts your models, git and the revision checks still prevent lost updates, but
the collaboration features stop meaning anything. A data modelling team is tens of people
and the bottleneck is human review, not compute.

---

## Quick start on kind

This section builds the image from a checkout, which is what you want if you are changing
Strata. If you only want to run it, skip the build and install the published chart, which
pulls the published image and needs no source at all:

```bash
helm install strata oci://ghcr.io/rk-chavali/charts/strata   --set model.repo=https://github.com/your-org/data-models.git
```

```bash
kind create cluster --name strata
```

Build the image and side-load it. kind has no registry, so the image goes straight into the
node:

```bash
docker build -t strata:0.1.0 .
```

```bash
kind load docker-image strata:0.1.0 --name strata
```

Install, pointing at a model repository:

```bash
helm install strata deploy/helm/strata -f deploy/helm/strata/values-kind.yaml --set model.repo=https://github.com/your-org/data-models.git
```

Watch it come up. The first boot clones the repository, so give it a moment:

```bash
kubectl rollout status deploy/strata --timeout=180s
```

```bash
kubectl port-forward svc/strata 8080:80
```

Open <http://localhost:8080> and create the administrator account.

### A private model repository

Cloning it needs a token. For a local test:

```bash
helm upgrade strata deploy/helm/strata -f deploy/helm/strata/values-kind.yaml --set model.repo=https://github.com/your-org/data-models.git --set github.token=ghp_xxx
```

For anything real, point at a Secret you manage instead, so the value never passes through
Helm values or your shell history:

```bash
helm upgrade strata oci://ghcr.io/rk-chavali/charts/strata   --set github.existingSecret=strata-github --set github.existingSecretKey=token
```

The token is mounted as a **file** and read via `STRATA_GITHUB_TOKEN_FILE`, never passed as an
environment variable, env vars leak into `kubectl describe pod`, crash dumps and anything
that reads `/proc`. A mounted file also rotates without a pod restart.

---

## Production notes

### TLS and the session cookie

Set `auth.cookieSecure=true` whenever you serve over HTTPS. The chart warns if you enable
an ingress without it.

The inverse bites harder and is worth stating plainly: with `cookieSecure=true` behind a
plain-HTTP `kubectl port-forward`, the browser **silently discards the session cookie**.
Sign-in appears to succeed and leaves you signed out, with nothing in any log to explain
it. `values-kind.yaml` sets it false for exactly this reason.

### Ingress buffering

The UI holds a long-lived server-sent-events connection for presence and live updates. A
proxy that buffers responses holds those events until the buffer fills, which looks exactly
like the feature silently not working. The chart ships the nginx annotations that disable
it:

```yaml
nginx.ingress.kubernetes.io/proxy-buffering: "off"
nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
```

If you use a different ingress controller, find its equivalent. The app already sends
`X-Accel-Buffering: no`, which nginx honours; the annotations cover proxies that do not.

### The volume

`persistence` holds three things: accounts, the session signing secret, and the model
checkout. Losing it signs everyone out and re-runs first-run setup, it does **not** lose
any models, because those are in git.

The PVC carries `helm.sh/resource-policy: keep`, so `helm uninstall` leaves it behind.
Removing it is a deliberate `kubectl delete pvc`.

### Upgrades

```bash
helm upgrade strata oci://ghcr.io/rk-chavali/charts/strata
```

The model format is plain YAML in your repo and the loader is layout-independent, it reads
`kind` and `id` from file *contents*, never from paths. An upgrade cannot strand your
models. If one goes wrong, roll the image back; the models are untouched.

---

## Troubleshooting

**`ImagePullBackOff` on kind**, the image was not side-loaded, or `image.pullPolicy` is
`Always`. Run `kind load docker-image strata:0.1.0 --name <cluster>` and keep the policy at
`IfNotPresent`. This is the most common mistake.

**Pod runs but the UI says "Cannot read the model repo"**, `model.repo` is unset, so
nothing was cloned. Check `kubectl logs` for a `workspace bootstrap` line.

**Clone fails on a private repo**, no token, or the token cannot see that repository. For
a fine-grained PAT, check it lists the repo under *Repository access*.

**Pod crash-loops on "permission denied" writing `/data`**, `fsGroup` does not match the
image's uid. The image pins uid/gid `10001`; if you rebuilt it from a modified Dockerfile,
align `podSecurityContext` with it.

**PVC stays `Pending`**, no default StorageClass, or the named one does not exist. kind
ships `standard`. Check with `kubectl get storageclass`.

**Everyone signed out after an upgrade**, `persistence.enabled` is false, so the session
secret was regenerated.
