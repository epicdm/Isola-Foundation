# Chatwoot <-> SeldonFrame relay. No dependencies, so there is nothing to install and nothing heavy to build:
# the image is the Node runtime plus ~300 lines. Build context: services/sf-relay/
#
#   docker build -t sf-relay:uat-<sha> services/sf-relay
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production
USER node
EXPOSE 3000
# Liveness is the HTTP listener itself; the relay holds no state that a restart cannot lose safely (UAT).
CMD ["node", "src/server.js"]
