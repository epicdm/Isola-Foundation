# syntax=docker/dockerfile:1
#
# Build context MUST be services/isola-sentinel/.
#   docker build -t isola-sentinel:1 services/isola-sentinel
#
# One dependency (pg) because the first-class signal is a SQL question about
# delivery_ledger, not an HTTP guess. Everything else is Node built-ins.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# The alert state lives here so a restart does not re-announce every open alert.
# Created and chowned BEFORE the VOLUME declaration so a fresh named volume
# inherits node ownership — otherwise the process runs as `node` against a
# root-owned mount and silently cannot persist alert state, which would make it
# re-announce every open alert on every restart.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node
CMD ["node", "src/sentinel.js"]
