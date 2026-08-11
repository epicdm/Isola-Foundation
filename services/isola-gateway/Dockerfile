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
# in the runtime layer. This service has no filesystem state — the delivery
# de-duplication window is in memory by design (README §8).

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

# ---------- runtime ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS=--disable-proto=throw

WORKDIR /app

# There are zero runtime dependencies, so no node_modules is copied at all.
COPY --chown=node:node package.json ./
COPY --chown=node:node --from=build /app/dist ./dist

# Non-root. The app directory is owned by root and is not writable by the app
# user, so the process cannot write to its own code either.
RUN chown -R root:root /app && chmod -R a-w /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
