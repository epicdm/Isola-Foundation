# syntax=docker/dockerfile:1.7
###############################################################################
# Isola Foundation - Customer 360 UAT
#
# The Foundation Next.js app has never been containerised. It is TWO processes,
# not one: Next.js on :3000 and the Express auth/API server on :8080, which
# Next reaches through its own /auth/* rewrite. Both must live in this image or
# the rewrite target does not exist.
#
# Built from an exact commit and tagged with it. Never from a branch tip.
#
# NOTE: the usual apt-cache cleanup layer is deliberately absent. The machine
# authoring this file runs a safety hook that pattern-matches that idiom as a
# destructive host operation. Rather than reword the line to slip past a guard,
# it is omitted. Cost: a slightly larger image. Reported as a false positive.
###############################################################################

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates curl
# Pin pnpm explicitly. The repo sets no `packageManager`, and a different pnpm
# quietly REWRITES a v9 lockfile rather than failing -- which would mean the
# image no longer corresponds to the commit it is named after.
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

###############################################################################
FROM base AS build
WORKDIR /repo

# `next build` and `prisma generate` must not need a real database, but
# lib/db/src/index.ts THROWS at import time when DATABASE_URL is unset. A
# syntactically valid URL pointing nowhere satisfies that guard without ever
# opening a connection. The real URL is injected at runtime.
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build

COPY . .

# --frozen-lockfile is the fail-closed choice: if the lockfile and the manifest
# disagree the build STOPS, instead of silently resolving different versions
# than the ones this commit was tested with.
RUN pnpm install --frozen-lockfile

RUN pnpm --filter @workspace/isola exec prisma generate
RUN pnpm --filter @workspace/api-server build
RUN pnpm --filter @workspace/isola build

# Prove the build actually produced the routes this deployment exists for.
# A green `next build` that silently omitted them would otherwise be discovered
# only by a 404 after deploy.
RUN test -d artifacts/isola/.next \
 && grep -q 'isola-360' artifacts/isola/.next/routes-manifest.json \
 && test -f artifacts/api-server/dist/index.mjs \
 && echo "BUILD CONTAINS /isola-360 AND THE API SERVER"

###############################################################################
FROM base AS runtime
WORKDIR /repo
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0

COPY --from=build /repo /repo
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3000
# Probes the thing it SERVES, not the fact that a process exists. A container
# that is "up" while serving nothing is a failure mode this estate has already
# been bitten by.
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=6 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

CMD ["/usr/local/bin/entrypoint.sh"]
