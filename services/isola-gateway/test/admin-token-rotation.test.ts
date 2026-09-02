/**
 * ADMIN TOKEN ROTATION GRACE.
 *
 * `GATEWAY_ADMIN_TOKEN` has more than one holder — the portal API calls this
 * service's admin surface — and they deploy independently. Without an overlap,
 * rotating it means an interval where a legitimate client is refused.
 *
 * These are HTTP-level tests, deliberately. A unit test of the comparison would
 * prove the function works; it would not prove the ROUTE accepts the second
 * value, and the route is what a client actually meets.
 *
 * Every "rejected" assertion is paired with an "accepted" one in the same state,
 * so a gateway that refused EVERYTHING could not pass this file.
 */
import { describe, expect, it } from "vitest";

import { bootErrors } from "../src/config.js";
import { ADMIN_TOKEN, envConfig, get, placeholder, startServer } from "./harness.js";

const NEW_ADMIN = placeholder("admin-next");
const UNRELATED = placeholder("unrelated-admin");

/** Ask /v1/bindings with a given bearer and return the status. */
async function status(config: ReturnType<typeof envConfig>, token: string): Promise<number> {
  const server = await startServer({ config });
  try {
    return (await get(server.url, "/v1/bindings", token)).status;
  } finally {
    await server.close();
  }
}

const BEFORE = () => envConfig();
const OVERLAP = () => envConfig({ GATEWAY_ADMIN_TOKEN_NEXT: NEW_ADMIN });
const AFTER = () => envConfig({ GATEWAY_ADMIN_TOKEN: NEW_ADMIN });

describe("the rotation matrix for GATEWAY_ADMIN_TOKEN", () => {
  it("BEFORE grace: old accepted, new rejected", async () => {
    expect(await status(BEFORE(), ADMIN_TOKEN)).toBe(200);
    expect(await status(BEFORE(), NEW_ADMIN)).toBe(401);
  });

  it("DURING overlap: BOTH old and new accepted", async () => {
    expect(await status(OVERLAP(), ADMIN_TOKEN)).toBe(200);
    expect(await status(OVERLAP(), NEW_ADMIN)).toBe(200);
  });

  it("AFTER cutover: old rejected, new accepted", async () => {
    expect(await status(AFTER(), ADMIN_TOKEN)).toBe(401);
    expect(await status(AFTER(), NEW_ADMIN)).toBe(200);
  });

  it("an unrelated token is rejected in ALL THREE states", async () => {
    expect(await status(BEFORE(), UNRELATED)).toBe(401);
    expect(await status(OVERLAP(), UNRELATED)).toBe(401);
    expect(await status(AFTER(), UNRELATED)).toBe(401);
  });

  it("removing the grace value ends the rotation immediately", async () => {
    // The step that actually completes a rotation. If it did not work the old
    // credential would remain valid forever and the rotation would be theatre.
    expect(await status(OVERLAP(), ADMIN_TOKEN)).toBe(200);
    expect(await status(AFTER(), ADMIN_TOKEN)).toBe(401);
  });
});

describe("with no grace configured, behaviour is exactly what it was", () => {
  it("adminTokenNext is null and the existing checks are untouched", async () => {
    const config = BEFORE();
    expect(config.adminTokenNext).toBeNull();
    expect(await status(config, ADMIN_TOKEN)).toBe(200);
    expect(await status(config, UNRELATED)).toBe(401);
  });

  it("still fails closed with 503 when no admin token is configured at all", async () => {
    const config = envConfig({ GATEWAY_ADMIN_TOKEN: "" });
    const server = await startServer({ config });
    try {
      const res = await get(server.url, "/v1/bindings", ADMIN_TOKEN);
      expect(res.status).toBe(503);
      expect(res.json["outcome"]).toBe("no_admin_token_configured");
    } finally {
      await server.close();
    }
  });

  it("still 405s a write verb — grace adds no write path", async () => {
    const server = await startServer({ config: OVERLAP() });
    try {
      expect((await fetch(`${server.url}/v1/bindings`, { method: "POST" })).status).toBe(405);
    } finally {
      await server.close();
    }
  });

  it("an absent bearer is still rejected during overlap", async () => {
    const server = await startServer({ config: OVERLAP() });
    try {
      expect((await get(server.url, "/v1/bindings")).status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe("mis-configured grace REFUSES STARTUP", () => {
  it("a NEXT with no CURRENT is fatal", () => {
    const config = envConfig({ GATEWAY_ADMIN_TOKEN: "", GATEWAY_ADMIN_TOKEN_NEXT: NEW_ADMIN });
    expect(bootErrors(config).join(" | ")).toContain(
      "GATEWAY_ADMIN_TOKEN_NEXT is set but GATEWAY_ADMIN_TOKEN is not",
    );
  });

  it("a NEXT identical to its CURRENT is fatal", () => {
    const config = envConfig({ GATEWAY_ADMIN_TOKEN_NEXT: ADMIN_TOKEN });
    expect(bootErrors(config).join(" | ")).toContain("identical to GATEWAY_ADMIN_TOKEN");
  });

  it("POSITIVE CONTROL: valid configurations are NOT fatal", () => {
    // Without this, the two tests above would pass against a bootErrors() that
    // simply refused every configuration.
    expect(bootErrors(BEFORE())).toEqual([]);
    expect(bootErrors(OVERLAP())).toEqual([]);
    expect(bootErrors(AFTER())).toEqual([]);
  });
});

describe("no credential value escapes", () => {
  it("neither token appears in the response body during overlap", async () => {
    const server = await startServer({ config: OVERLAP() });
    try {
      const res = await get(server.url, "/v1/bindings", NEW_ADMIN);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(ADMIN_TOKEN);
      expect(res.text).not.toContain(NEW_ADMIN);
    } finally {
      await server.close();
    }
  });

  it("refusal messages name the VARIABLE, never the value", () => {
    const cases = [
      envConfig({ GATEWAY_ADMIN_TOKEN: "", GATEWAY_ADMIN_TOKEN_NEXT: NEW_ADMIN }),
      envConfig({ GATEWAY_ADMIN_TOKEN_NEXT: ADMIN_TOKEN }),
    ];
    for (const c of cases) {
      const text = bootErrors(c).join(" | ");
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain(ADMIN_TOKEN);
      expect(text).not.toContain(NEW_ADMIN);
    }
  });

  it("POSITIVE CONTROL: the scan detects a sentinel when one IS present", () => {
    expect(`prefix ${NEW_ADMIN} suffix`).toContain(NEW_ADMIN);
  });
});
