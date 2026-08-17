/**
 * Process entry point. Boots the HTTP listener and logs the boot posture once.
 *
 * No filesystem access, no child processes, no signals other than a clean
 * shutdown on SIGTERM/SIGINT — which drains in-flight deliveries first, because
 * a delivery that has been ACKed will never be retried by Chatwoot.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { createGateway } from "./app.js";
import { bootWarnings, configuredBindings, loadConfig } from "./config.js";
import { createLedger } from "./ledger.js";
import { createPostgresOwnershipGate, migrateOwnershipStore } from "./ownership-store.js";
import { createLogger } from "./log.js";
import { createHandbackSweeper } from "./handback.js";
import { createSweeper } from "./recovery.js";
import { migrateTurnStore } from "./turns.js";
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

// A failpoint name that is set but unknown is refused outright. Treating a
// typo as "disarmed" would be the worst of both worlds: the operator believes a
// failpoint is armed and it silently is not, or vice versa.
if (config.failpoint === "unrecognised") {
  logger.error({
    event: "boot",
    outcome: "boot_refused",
    detail:
      "GATEWAY_FAILPOINT is set to an unknown failpoint name; refusing to start rather than run with a typo that looks disarmed",
  });
  process.exit(1);
}

// The ledger is the second boot gate. Without it an acknowledged delivery
// cannot be durably recorded, which is the exact failure mode this service was
// changed to remove — so an unconfigured ledger refuses to start rather than
// silently degrading to an in-memory window.
if (config.ledgerUrl === null && config.ledgerRequired) {
  logger.error({
    event: "boot",
    outcome: "boot_refused",
    detail:
      "GATEWAY_LEDGER_URL is not configured and GATEWAY_LEDGER_REQUIRED is true; refusing to start",
  });
  process.exit(1);
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

const instanceId = `gw-${SERVICE_VERSION}-${randomUUID().slice(0, 8)}`;
const ledger = createLedger({
  // Checked above: null is only reachable when the ledger is explicitly not
  // required, in which case an unreachable ledger fails every delivery closed.
  connectionString: config.ledgerUrl ?? "",
  instanceId,
});

// One pool, two stores. The ownership gate speaks SQL through the ledger's
// executor, so `pg` stays imported by exactly one module.
const ownership = createPostgresOwnershipGate(ledger);

const gateway = createGateway({ config, logger, ledger, ownership, turnStore: ledger });
const server = createServer(gateway.handler);

let handbackSweeper: { start(): void; stop(): void; sweep(): Promise<number> } | null = null;

const sweeper = createSweeper({
  config,
  ledger,
  ownership,
  bindingStore: gateway.bindingStore,
  chatwoot: gateway.chatwoot,
  runtime: gateway.runtime,
  failpoint: gateway.failpoint,
  logger,
  now: () => Date.now(),
});

async function boot(): Promise<void> {
  // Named so the refusal below reports WHICH migration failed. A boot-refused
  // line that blames the delivery ledger for an ownership-store failure sends
  // the next person to the wrong table.
  let stage = "delivery ledger";
  try {
    await ledger.migrate();
    // The ownership store lives in the SAME database, reached over the SAME
    // pool, so this shares the ledger's failure mode rather than adding one: if
    // this DDL cannot run, the statement above could not have run either. Both
    // are idempotent and additive, and nothing reads the ownership tables yet.
    stage = "conversation ownership store";
    await migrateOwnershipStore(ledger);
    stage = "conversation turn store";
    await migrateTurnStore(ledger);
    logger.info({ event: "boot", outcome: "ledger_ready", instanceId });
  } catch (err) {
    // Do not start serving with an unusable ledger: every delivery would be
    // answered 500 anyway, and a container that exits is visible where a
    // container that 500s quietly is not.
    logger.error({
      event: "boot",
      outcome: "boot_refused",
      detail: `${stage} migration failed: ${err instanceof Error ? err.message : "unknown"}`,
    });
    process.exit(1);
  }

  // One sweep at boot picks up anything the previous container acknowledged
  // and did not finish. Then keep sweeping for leases that expire later.
  const resumed = await sweeper.sweep();
  logger.info({ event: "boot", outcome: "recovery_sweep", resumed });
  sweeper.start();

  // HANDBACK — the IDLE trigger. Without this a conversation a human took over
  // stays HUMAN_OWNED forever and the AI never answers that customer again.
  // The manual trigger ("Mark as pending" in Chatwoot) is handled on the
  // webhook path; this is the one that needs a clock.
  handbackSweeper = createHandbackSweeper({
    exec: ledger,
    chatwoot: gateway.chatwoot,
    logger,
    idleMs: config.handbackIdleMs,
    intervalMs: config.handbackSweepIntervalMs,
    batch: config.handbackSweepBatch,
    resolveTarget: (candidate) => {
      const binding = gateway.bindingStore
        .list()
        .find(
          (b) =>
            b.chatwootAccountId === candidate.accountId &&
            b.tenantId === candidate.conversation.tenantId,
        );
      // No binding -> skip. Never hand back with another tenant's token.
      if (binding === undefined) return null;
      return {
        accountId: candidate.accountId,
        conversationId: candidate.conversationId,
        accessToken: binding.agentBotAccessToken,
        ...(binding.chatwootBaseUrl === undefined ? {} : { baseUrl: binding.chatwootBaseUrl }),
      };
    },
  });
  handbackSweeper.start();
  logger.info({
    event: "boot",
    outcome: "handback_sweeper_started",
    idleMs: config.handbackIdleMs,
    intervalMs: config.handbackSweepIntervalMs,
  });

  server.listen(config.port, "0.0.0.0", () => {
    logger.info({ event: "listening", outcome: "listening", port: config.port });
  });
}

void boot();

function shutdown(signal: string): void {
  logger.info({ event: "shutdown", outcome: "shutdown", signal });
  sweeper.stop();
  handbackSweeper?.stop();
  server.close(() => {
    // An ACKed delivery is never retried by Chatwoot, so finish what we owe.
    void gateway
      .drain()
      .finally(() => ledger.close().catch(() => undefined))
      .finally(() => process.exit(0));
  });
  const timer = setTimeout(() => process.exit(0), 20_000);
  if (typeof timer.unref === "function") timer.unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
