# syntax=docker/dockerfile:1
#
# Build context MUST be services/meta-egress-gateway/ — this image never reaches
# out into the monorepo and depends on no workspace package.
#
#   docker build -t meta-egress-gateway:1.0.0 services/meta-egress-gateway
#
# THIS IS NOT the Chatwoot-to-Paperclip conversation gateway (isola-gateway).
# This is the Meta credential custody and egress boundary.
#
# The runtime layer has ZERO npm dependencies. Everything the service needs is a
# Node builtin. For a process whose entire job is holding production credentials,
# an empty dependency tree is the strongest supply-chain posture available, and
# it is cheap here because the service is deliberately small.
#
# Deliberately absent: any VOLUME, any writable path, any shell tooling in the
# runtime layer. The only file this service ever reads is its Swarm secret, which
# Docker mounts read-only on tmpfs at /run/secrets.

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app

# Dev dependencies (the compiler and the test runner) exist only in this stage.
COPY package.json ./
RUN npm install --no-audit --no-fund --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json

# Load the built module graph under PLAIN NODE. tsc accepts things plain Node
# rejects, and this makes that fail the build instead of the deploy. The
# prior art is isola-gateway, where a CommonJS/ESM import mismatch type-checked,
# passed its unit suite and then crash-looped the container.
RUN node --input-type=module -e "\
  await import('file:///app/dist/operations.js'); \
  await import('file:///app/dist/policy.js'); \
  await import('file:///app/dist/credentials.js'); \
  await import('file:///app/dist/graph.js'); \
  await import('file:///app/dist/audit.js'); \
  await import('file:///app/dist/app.js'); \
  console.log('module graph loads under plain node'); \
"

# ---------- runtime ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS=--disable-proto=throw

WORKDIR /app

# No node_modules stage: there are no runtime dependencies to copy.
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist

# Non-root, and the app directory is not writable by the app user, so the
# process cannot modify its own code.
RUN chown -R root:root /app && chmod -R a-w /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
