/**
 * Process entry point. Boots the HTTP listener and logs the boot posture once.
 *
 * No filesystem access, no child processes, no signals other than a clean
 * shutdown on SIGTERM/SIGINT — which drains in-flight deliveries first, because
 * a delivery that has been ACKed will never be retried by Chatwoot.
 */
import { createServer } from "node:http";

import { createGateway } from "./app.js";
import { bootWarnings, configuredBindings, loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { SERVICE_VERSION } from "./version.js";

const config = loadConfig(process.env);
const logger = createLogger();

// Binding validation is a BOOT GATE. A non-PUBLIC exposure, a duplicate
// (account, inbox) pair or a missing secret must never reach a running process.
if (!config.bindings.ok) {
  for (const error of config.bindings.errors) {
    logger.error({ event: "boot", outcome: "invalid_bindings", detail: error });
  }
  logger.error({
    event: "boot",
    outcome: "boot_refused",
    detail: "GATEWAY_BINDINGS_JSON failed validation; refusing to start",
  });
  process.exit(1);
}

for (const warning of bootWarnings(config)) {
  logger.warn({ event: "boot_warning", outcome: "boot_warning", detail: warning });
}

const bindings = configuredBindings(config);

logger.info({
  event: "boot",
  outcome: "boot",
  version: SERVICE_VERSION,
  port: config.port,
  egressAllowlist: config.egressAllowlist,
  chatwootBaseUrl: config.chatwootBaseUrl,
  runtimeBaseUrl: config.runtimeBaseUrl,
  runtimeInvokePath: config.runtimeInvokePath,
  runtimeConfigured: config.runtimeSecret !== null,
  bindingsTotal: bindings.length,
  bindingsActive: bindings.filter((b) => b.status === "active").length,
  // Routing only. No secret, no token.
  boundInboxes: bindings.map(
    (b) => `${b.chatwootAccountId}/${b.chatwootInboxId} -> ${b.tenantId} (${b.status})`,
  ),
  replayWindowSec: config.replayWindowSec,
  idempotencyTtlMs: config.idempotencyTtlMs,
  runtimeTimeoutMs: config.runtimeTimeoutMs,
  chatwootTimeoutMs: config.chatwootTimeoutMs,
  applyLabels: config.applyLabels,
  applyCustomAttributes: config.applyCustomAttributes,
  toolPolicy: "no shell, no child processes, no filesystem, no mcp, no custom tools",
});

const gateway = createGateway({ config, logger });
const server = createServer(gateway.handler);

server.listen(config.port, "0.0.0.0", () => {
  logger.info({ event: "listening", outcome: "listening", port: config.port });
});

function shutdown(signal: string): void {
  logger.info({ event: "shutdown", outcome: "shutdown", signal });
  server.close(() => {
    // An ACKed delivery is never retried by Chatwoot, so finish what we owe.
    void gateway.drain().finally(() => process.exit(0));
  });
  const timer = setTimeout(() => process.exit(0), 20_000);
  if (typeof timer.unref === "function") timer.unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
