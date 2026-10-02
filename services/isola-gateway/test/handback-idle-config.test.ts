/**
 * GATEWAY_HANDBACK_IDLE_ENABLED — idle handback is an explicit opt-in.
 *
 * The ratified contract is explicit-only handback. The flag must default to
 * false so that a deployment which never set it does NOT hand conversations
 * back on idleness, and an unrecognised value must not read as "on".
 */
import { describe, expect, it } from "vitest";

import { envConfig } from "./harness.js";

describe("handbackIdleEnabled", () => {
  it("defaults to FALSE with the variable unset", () => {
    expect(envConfig().handbackIdleEnabled).toBe(false);
  });

  it("CONTROL: is true when explicitly set to true, so the default above is a choice not a constant", () => {
    expect(envConfig({ GATEWAY_HANDBACK_IDLE_ENABLED: "true" }).handbackIdleEnabled).toBe(true);
  });

  it("an unrecognised value does not turn it on", () => {
    expect(envConfig({ GATEWAY_HANDBACK_IDLE_ENABLED: "yes-please" }).handbackIdleEnabled).toBe(false);
  });
});
