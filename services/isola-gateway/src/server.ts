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
import { assertionBootErrors, assertionMinterFromEnv, createFixtureAssertionProvider } from "./assertion-minter.js";
import { bootErrors, bootWarnings, configuredBindings, loadConfig } from "./config.js";
import { customerScopeFromEnv } from "./customer-scope.js";
import { createLedger } from "./ledger.js";
import { createPostgresOwnershipGate, migrateOwnershipStore } from "./ownership-store.js";
import { createLogger } from "./log.js";
import { createHandbackSweeper } from "./handback.js";
import { createSweeper } from "./recovery.js";
import { migrateTurnStore } from "./turns.js";
import { SERVICE_VERSION } from "./version.js";

const config = loadConfig(process.env);
const logger = createLogger();

// FATAL configuration. Checked before anything else binds a port: a service that
// starts with a half-configured credential overlap looks healthy right up until
// the old credential is withdrawn.
const fatal = bootErrors(config);
if (fatal.length > 0) {
  for (const detail of fatal) {
    logger.error({ event: "boot", outcome: "invalid_config", detail });
  }
  logger.error({
    event: "boot",
    outcome: "boot_refused",
    detail: "fatal configuration errors; refusing to start",
  });
  process.exit(1);
}

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

// CUSTOMER SCOPE is a boot gate for the same reason: a typo in the mode must not
// read as "off" and quietly remove a control that was asked for.
const customerScopeConfig = customerScopeFromEnv(process.env);
if (!customerScopeConfig.ok) {
  logger.error({ event: "boot", outcome: "invalid_config", detail: customerScopeConfig.error });
  logger.error({
    event: "boot",
    outcome: "boot_refused",
    detail: "customer scope configuration failed validation; refusing to start",
  });
  process.exit(1);
}
const customerScope = customerScopeConfig.resolver;

// THE UAT FIXTURE ASSERTION MINTER is a boot gate too, and DEFAULT OFF: with no GATEWAY_ASSERTION_* variable
// it is "off" and nothing changes. The key and the fixture wa_id were materialised from mounted Swarm secrets
// by entrypoint.sh (`*_FILE` -> value); this process reads no file. A half-configured minter, a non-"uat"
// environment, a minter with no direct Hermes employee, or one while customer scope is not "fixture" REFUSES
// to start, naming variables only. Nothing in the log carries a value.
const assertionMinter = assertionMinterFromEnv(process.env);
const assertionErrors = assertionBootErrors({
  minter: assertionMinter,
  hermesAgentIds: config.hermes.agentIds,
  customerScopeMode: customerScopeConfig.mode,
});
if (assertionErrors.length > 0) {
  for (const detail of assertionErrors) {
    logger.error({ event: "boot", outcome: "invalid_config", detail });
  }
  logger.error({
    event: "boot",
    outcome: "boot_refused",
    detail: "assertion minter configuration failed validation; refusing to start",
  });
  process.exit(1);
}
const assertionProvider =
  assertionMinter.mode === "fixture" ? createFixtureAssertionProvider({ minter: assertionMinter.minter, logger }) : undefined;

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
  // Routing only. No secret, no token — and for an INTERNAL line the allowlist
  // SIZE, never its contents. A staff line that refuses everyone must be visible
  // at boot ("INTERNAL, 0 allowed") rather than discovered when a staff member
  // reports that nothing answers; printing the numbers themselves would put
  // staff phone numbers in every log line, which is the opposite trade.
  boundInboxes: bindings.map((b) => {
    const base = `${b.chatwootAccountId}/${b.chatwootInboxId} -> ${b.tenantId} (${b.status})`;
    return b.exposure === "INTERNAL"
      ? `${base} [INTERNAL, ${b.allowedSenders.length} allowed]`
      : base;
  }),
  replayWindowSec: config.replayWindowSec,
  idempotencyTtlMs: config.idempotencyTtlMs,
  runtimeTimeoutMs: config.runtimeTimeoutMs,
  chatwootTimeoutMs: config.chatwootTimeoutMs,
  applyLabels: config.applyLabels,
  applyCustomAttributes: config.applyCustomAttributes,
  // The MODE only ("off" | "fail_closed" | "fixture"); never a fixture value.
  customerScopeMode: customerScopeConfig.mode,
  // The MODE only ("off" | "fixture"); never a key, a wa_id or a token.
  assertionMinterMode: assertionMinter.mode,
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

// `ledger` also satisfies `SqlExecutor` (createLedger's real return type is
// `Ledger & SqlExecutor`); `ownershipExec` names that same object under its
// own narrow purpose, exactly as `turnStore` already does one line over.
const gateway = createGateway({
  config,
  logger,
  ledger,
  ownership,
  turnStore: ledger,
  ownershipExec: ledger,
  ...(customerScope === undefined ? {} : { customerScope }),
  ...(assertionProvider === undefined ? {} : { assertions: assertionProvider }),
});
const server = createServer(gateway.handler);

let handbackSweeper: { start(): void; stop(): void; sweep(): Promise<number> } | null = null;

const sweeper = createSweeper({
  config,
  ledger,
  ownership,
  ...(customerScope === undefined ? {} : { customerScope }),
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

  // HANDBACK — EXPLICIT-ONLY by default (pivot packet ISOLA-PIVOT-20261002-01).
  // The ratified contract hands a conversation back only on an explicit,
  // verified Chatwoot transition ("Mark as pending"), never on idleness. That
  // gesture is handled on the webhook path (`handleManualHandbackWebhook`, wired
  // in `app.ts` via `ownershipExec` above). This sweeper is STARTED, but with the
  // idle clock OFF (`idleHandbackEnabled`, default false): its OWN
  // `recordReadable` fallback is a second, weaker detection of the SAME explicit
  // gesture, retained for redundancy — see its comment for why the webhook path
  // cannot be relied on alone once a team has been assigned. Turning the idle
  // trigger on is an explicit opt-in (GATEWAY_HANDBACK_IDLE_ENABLED=true) that
  // contradicts the ratified contract.
  handbackSweeper = createHandbackSweeper({
    exec: ledger,
    chatwoot: gateway.chatwoot,
    logger,
    // The idle clock. Without it the sweeper depends on `conversations#show`,
    // which 500s for a bot token exactly when a team has been assigned.
    turnStore: ledger,
    // OFF unless GATEWAY_HANDBACK_IDLE_ENABLED=true. With it off this loop only
    // detects the explicit gesture (status already `pending`); it decides
    // nothing from a clock. See HandbackSweeperDeps.idleHandbackEnabled.
    idleHandbackEnabled: config.handbackIdleEnabled,
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
    idleHandbackEnabled: config.handbackIdleEnabled,
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
