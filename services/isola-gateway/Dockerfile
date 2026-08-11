# syntax=docker/dockerfile:1
#
# Build context MUST be services/isola-gateway/ — this image never reaches out
# into the monorepo and depends on no workspace package.
#
#   docker build -t isola-gateway:1.0.0 services/isola-gateway
#
# In EasyPanel: set "Build context" / "Build path" to services/isola-gateway and
# Dockerfile to ./Dockerfile.
#
# Deliberately absent: any VOLUME, any writable path at all, any shell tooling
# in the runtime layer. This service still has NO filesystem state: delivery
# de-duplication is durable, but it lives in a private Postgres reached over the
# container network, not on disk here. `node:fs` appears nowhere in src/ and
# test/no-direct-network.test.ts asserts it.

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app

# Dev dependencies (the TypeScript compiler and the test runner) exist only in
# this stage. Pinned by the lockfile and installed with no lifecycle scripts.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

# The production dependency closure, resolved separately so the runtime layer
# never carries the compiler or the test runner. `pg` is the ONLY runtime
# dependency, and src/ledger.ts is the only module allowed to import it.
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts \
 && npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS=--disable-proto=throw

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist

# Non-root. The app directory is owned by root and is not writable by the app
# user, so the process cannot write to its own code either.
RUN chown -R root:root /app && chmod -R a-w /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
