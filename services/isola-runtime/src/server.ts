/**
 * Process entry point. Boots the HTTP listener and logs the boot posture once.
 * No filesystem access, no child processes, no signals other than a clean
 * shutdown on SIGTERM/SIGINT.
 */
import { createServer } from "node:http";

import { createApp } from "./app.js";
import { bootWarnings, loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { healthTemplateSummary } from "./registry.js";
import { SERVICE_VERSION } from "./version.js";

const config = loadConfig(process.env);
const logger = createLogger();

for (const warning of bootWarnings(config)) {
  logger.warn({ event: "boot_warning", outcome: "boot_warning", detail: warning });
}

logger.info({
  event: "boot",
  outcome: "boot",
  version: SERVICE_VERSION,
  port: config.port,
  egressAllowlist: config.egressAllowlist,
  templates: healthTemplateSummary().map((t) => `${t.id} (${t.exposure})`),
  modelBaseUrl: config.modelBaseUrl,
  paperclipBaseUrl: config.paperclipBaseUrl,
  recordPath: config.paperclipRecordPath,
  modelTimeoutMs: config.modelTimeoutMs,
  // Which exposure classes can run at all. Names only — never a value.
  configuredExposures: (["INTERNAL", "PUBLIC"] as const).filter(
    (exposure) => config.secrets[exposure] !== null,
  ),
  toolPolicy: "no shell, no filesystem, no web tools, no mcp, no custom tools",
});

const server = createServer(createApp({ config, logger }));

server.listen(config.port, "0.0.0.0", () => {
  logger.info({ event: "listening", outcome: "listening", port: config.port });
});

function shutdown(signal: string): void {
  logger.info({ event: "shutdown", outcome: "shutdown", signal });
  server.close(() => process.exit(0));
  // Do not hang forever on a stuck connection.
  const timer = setTimeout(() => process.exit(0), 10_000);
  if (typeof timer.unref === "function") timer.unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
