/**
 * THE EXPOSURE THE GATEWAY DECLARES TO THE RUNTIME.
 *
 * `AgentRuntimeRequest.exposure` was typed as the literal `"PUBLIC"` back when
 * PUBLIC was the only exposure that existed, and the call site in pipeline.ts
 * duly sent the constant. That reads as a safe narrowing. It is the opposite:
 * when the first INTERNAL binding arrived, the type made the CORRECT value a
 * compile error, so the constant stayed and the runtime refused every internal
 * invocation with 403 `exposure_mismatch`.
 *
 * Measured on 9043, 2026-08-18. The line never answered once, and the failure
 * was invisible in the gateway's own logs: it looked like a runtime rejection,
 * because that is exactly what it was — the gateway was lying about itself.
 *
 * The whole class is the point, not the one constant: this asserts the declared
 * exposure EQUALS the binding's for every exposure the type admits, so a third
 * one added later cannot be quietly hardcoded past.
 */
import { describe, expect, it } from "vitest";

import type { Exposure } from "../src/bindings.js";
import {
  bindingsJson,
  envConfig,
  makeBinding,
  messageCreatedPayload,
  postWebhook,
  signRequest,
  startServer,
  StubAgentRuntime,
} from "./harness.js";

const STAFF_NUMBER = "+1 767 818 9043";

/** Drives one inbound message through a binding of the given exposure. */
async function invokeWith(exposure: Exposure) {
  const runtime = StubAgentRuntime.answering("Answer.");
  const binding = makeBinding({
    exposure,
    // Meaningless on PUBLIC and ignored there; on INTERNAL it is what lets the
    // sender past the staff gate, so the test exercises the runtime call rather
    // than stopping at the allowlist.
    allowedSenders: [STAFF_NUMBER],
  });
  const server = await startServer({
    runtime,
    config: envConfig({ GATEWAY_BINDINGS_JSON: bindingsJson([binding]) }),
  });
  const payload = messageCreatedPayload();
  // The sender must be identifiable, or an INTERNAL binding refuses before the
  // runtime is ever reached and this test would pass vacuously.
  (payload as Record<string, unknown>)["sender"] = {
    type: "contact",
    id: 55,
    phone_number: STAFF_NUMBER,
  };
  await postWebhook(server.url, signRequest({ body: payload }));
  await server.gateway.drain();
  await server.close();
  return runtime;
}

describe("the gateway declares the BINDING'S exposure, never a constant", () => {
  it.each<Exposure>(["PUBLIC", "INTERNAL"])(
    "a %s binding invokes the runtime with that same exposure",
    async (exposure) => {
      const runtime = await invokeWith(exposure);
      // POSITIVE CONTROL, in the same assertion. If the webhook were refused or
      // the fixture broken, `requests` would be empty and an exposure check
      // alone would pass vacuously — the defect this test exists to catch was
      // itself a silent no-op.
      expect(runtime.requests, `${exposure}: the runtime must actually be called`).toHaveLength(1);
      expect(runtime.requests[0]?.exposure).toBe(exposure);
    },
  );

  it("sends INTERNAL for an internal binding — the exact 9043 regression", async () => {
    const runtime = await invokeWith("INTERNAL");
    expect(
      runtime.requests[0]?.exposure,
      'a hardcoded "PUBLIC" here is a 403 exposure_mismatch on every internal message',
    ).not.toBe("PUBLIC");
  });
});
