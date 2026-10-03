/**
 * A shared SOCKET-FREE rig for the direct Hermes tests (Codex DH1-DH9 round): a real gateway handler
 * over a FAKE ledger, a stub Chatwoot, an in-memory ownership gate, the FakeTurnSql transcript store
 * and a FAKE Hermes behind the REAL egress guard. A signed webhook is driven through the handler with
 * no listener (test/hermes-inproc.ts).
 *
 * THE FAKE IS NOT EVIDENCE OF INSTALLED BEHAVIOUR (Law 5).
 */
import { expect } from "vitest";

import { createGateway, type Gateway, type GatewayDeps } from "../src/app.js";
import { bootErrors } from "../src/config.js";
import { createSafeFetch } from "../src/egress.js";
import {
  CapturingLogger,
  envConfig,
  FakeLedger,
  InMemoryOwnershipGate,
  messageCreatedPayload,
  signRequest,
  StubChatwootApi,
} from "./harness.js";
import { FakeHermes, type FakeRun } from "./hermes-fake.js";
import { callHandler, FakeTurnSql } from "./hermes-inproc.js";

export const BEARER = "not-a-real-hermes-key-0000000000000000";
export const answerEnvelope = (text: string): string => JSON.stringify({ disposition: "answer", text });
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function hermesEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    GATEWAY_LEDGER_URL: "postgres://ledger.test/db",
    GATEWAY_HERMES_AGENT_IDS: "agent-1",
    GATEWAY_HERMES_BASE_URL: "http://hermes.test:8642",
    GATEWAY_HERMES_BEARER: BEARER,
    GATEWAY_HERMES_POLL_INTERVAL_MS: "100",
    GATEWAY_HERMES_REQUEST_TIMEOUT_MS: "2000",
    GATEWAY_HERMES_RUN_DEADLINE_MS: "3000",
    ...extra,
  };
}

export interface DirectRig {
  gateway: Gateway;
  fake: FakeHermes;
  chatwoot: StubChatwootApi;
  ledger: FakeLedger;
  ownership: InMemoryOwnershipGate;
  turns: FakeTurnSql;
  capture: CapturingLogger;
  /** Sign and post a message_created webhook; `id` is the Chatwoot message id. */
  post(over?: Parameters<typeof messageCreatedPayload>[0], deliveryId?: string): ReturnType<typeof callHandler>;
}

export interface DirectRigOptions {
  env?: Record<string, string>;
  fake?: FakeHermes;
  chatwoot?: StubChatwootApi;
  ledger?: FakeLedger;
  ownership?: InMemoryOwnershipGate;
  turns?: FakeTurnSql;
  /** Extra GatewayDeps (e.g. the staff-transcript timeout). */
  deps?: Partial<GatewayDeps>;
}

export function directRig(opts: DirectRigOptions = {}): DirectRig {
  const fake = opts.fake ?? new FakeHermes();
  const config = envConfig(hermesEnv(opts.env));
  expect(bootErrors(config), "the rig's own configuration must boot").toEqual([]);
  const chatwoot = opts.chatwoot ?? new StubChatwootApi();
  const ledger = opts.ledger ?? new FakeLedger();
  const ownership = opts.ownership ?? new InMemoryOwnershipGate();
  const turns = opts.turns ?? new FakeTurnSql();
  const capture = new CapturingLogger();
  const gateway = createGateway({
    config,
    chatwoot,
    ledger,
    ownership,
    turnStore: turns,
    safeFetch: createSafeFetch({ allowlist: config.egressAllowlist, transport: fake.fetch }),
    logger: capture.logger,
    ...(opts.deps ?? {}),
  });
  let n = 0;
  return {
    gateway,
    fake,
    chatwoot,
    ledger,
    ownership,
    turns,
    capture,
    post: (over = {}, deliveryId) => {
      n += 1;
      const id = deliveryId ?? `00000000-0000-4000-8000-${String(n + 7000).padStart(12, "0")}`;
      return callHandler(gateway.handler, signRequest({ body: messageCreatedPayload({ id: 9000 + n * 100, ...over }), deliveryId: id }));
    },
  };
}

export function completeWith(fake: FakeHermes, output: string, delayMs = 15): void {
  fake.onRun = (run: FakeRun) => {
    run.running();
    setTimeout(() => run.complete(output), delayMs);
  };
}
