# Self-hosted strata: one container serving the UI and the API.
#
# The container is stateless. The model repo is a mounted volume, and it is a real
# git checkout : that is what lets an enterprise point this at their own
# infrastructure and have edits become pull requests in their own GitHub.

# ---------------------------------------------------------------- build

FROM node:26-alpine AS build

RUN corepack enable

WORKDIR /build

# Copy manifests first so dependency installation is cached independently of source.
#
# Every workspace package is listed, including `ddl` and `import` which the server
# depends on. That is not strictly required : pnpm reads the workspace links from the
# lockfile and happily creates dangling symlinks for directories that arrive later, which
# `COPY packages packages` below then fills in. The build works either way.
#
# Listing them all is still worth doing: the install layer then describes the real
# dependency graph, so it invalidates when a manifest changes rather than relying on a
# lockfile detail, and a reader does not have to know about the dangling-symlink behaviour
# to believe the build is correct.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/metamodel/package.json packages/metamodel/
COPY packages/storage/package.json packages/storage/
COPY packages/ddl/package.json packages/ddl/
COPY packages/query/package.json packages/query/
COPY packages/import/package.json packages/import/
COPY packages/cli/package.json packages/cli/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile

COPY packages packages
COPY apps apps

# The example workspace ships in the image, and nothing points at it by default.
#
# A hosted trial seeds every visitor's scratch workspace from it, so without it a demo deploy
# boots and hands the first visitor an empty directory. Anyone else who wants to look around
# asks for it explicitly:
#
#   docker run -e STRATA_WORKSPACE=/app/examples/quickstart ...
#
# **Not the default, deliberately.** Somebody standing up their own instance used to create the
# first administrator and land in a fictional shop they had not written, which reads as the tool
# having invented data rather than as a sample. An unmounted /workspace is an empty volume, and
# an empty workspace opens the setup screen, which is the right first screen for a real install.
#
# It is small on purpose: three models, nineteen objects, twenty files.
COPY examples/quickstart examples/quickstart

RUN pnpm --filter "./packages/**" build \
  && pnpm --filter @strata/server build \
  && pnpm --filter @strata/web build

# Drop dev dependencies so they are not carried into the runtime image. This is why
# the server is compiled above rather than run through tsx : tsx is a dev tool and
# is gone by the time the runtime image is assembled.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ---------------------------------------------------------------- runtime

FROM node:26-alpine AS runtime

# git is not optional : it is how changes leave the container.
# openssh-client provides the SSH transport for git remotes.
# The uid/gid are pinned rather than left to `adduser -S` to allocate.
#
# Kubernetes has to know them: a `fsGroup` in the pod security context is what makes a
# mounted PersistentVolume writable by a non-root container, and it has to name a real
# gid. An auto-allocated one differs between base image versions, so a chart pinned to
# whatever alpine chose today silently breaks on a rebuild : with the pod crash-looping on
# "permission denied" against its own data directory.
RUN apk add --no-cache git openssh-client ca-certificates \
  && addgroup -S -g 10001 strata \
  && adduser -S -u 10001 -G strata -h /home/strata strata

WORKDIR /app

COPY --from=build --chown=strata:strata /build/node_modules ./node_modules
COPY --from=build --chown=strata:strata /build/package.json ./package.json
COPY --from=build --chown=strata:strata /build/packages ./packages
COPY --from=build --chown=strata:strata /build/apps/server ./apps/server
COPY --from=build --chown=strata:strata /build/apps/web/dist ./apps/web/dist
COPY --from=build --chown=strata:strata /build/examples/quickstart ./examples/quickstart

# Stamped by the release workflow so /api/health/detail can report which build is actually
# live, rather than a tag that may have been moved since.
#
# Declared in the runtime stage because ARG does not cross stages, and promoted to ENV
# because the server reads it from process.env at request time, not at build time.
#
# The empty default matters: a plain `docker build .` with no --build-arg still succeeds,
# and the health route reports an unknown commit instead of failing.
ARG STRATA_COMMIT=""

ENV NODE_ENV=production \
    PORT=4000 \
    STRATA_COMMIT=${STRATA_COMMIT} \
    STRATA_WORKSPACE=/workspace \
    STRATA_WEB_DIST=/app/apps/web/dist

# Mount the model repo here.
VOLUME ["/workspace"]

USER strata

# Two bits of git setup the container cannot work without:
#
#  - `safe.directory`: git refuses to operate on a repo owned by a different user,
#    which is the normal case for a bind-mounted host directory.
#  - a committer identity: `git commit` fails outright without one. Override it per
#    deployment with the standard GIT_AUTHOR_* / GIT_COMMITTER_* environment
#    variables, which git reads natively.
RUN git config --global --add safe.directory /workspace \
  && git config --global user.name "strata" \
  && git config --global user.email "strata@localhost"

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
