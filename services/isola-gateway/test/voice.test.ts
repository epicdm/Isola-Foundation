/**
 * `GET /v1/tenants/{tenantId}/members/{memberId}/personal-line`
 *
 * The read-only personal-line projection: authentication, tenant/member scope,
 * non-enumeration, the allowlist projection, redaction of `provisioning_error`,
 * the kill switch, rate limiting, and the audit line.
 */
import { describe, expect, it } from "vitest";

import type { PersonalLineSource, VoiceSeat } from "../src/voice.js";
import {
  parseVoiceSeats,
  projectPersonalLine,
  resolveSeat,
  safeProvisioningError,
} from "../src/voice.js";
import { redactSecret, redactSecrets } from "../src/redact-secret.js";
import { createLogger } from "../src/log.js";
import { envConfig, get, placeholder, startServer } from "./harness.js";

const VOICE_TOKEN = placeholder("voice-read");
const TENANT = "tenant-acme";
const MEMBER = "member-eric";
const OTHER_TENANT = "tenant-other";
const SIP_SECRET = placeholder("sip-registration");

const SEATS = JSON.stringify([
  { tenantId: TENANT, memberId: MEMBER, magnusExtension: "9610" },
  { tenantId: OTHER_TENANT, memberId: "member-someone", magnusExtension: "9611" },
]);

function voiceEnv(overrides: Record<string, string | undefined> = {}) {
  return envConfig({
    GATEWAY_VOICE_READ_ENABLED: "true",
    GATEWAY_VOICE_READ_TOKEN: VOICE_TOKEN,
    GATEWAY_VOICE_SEATS_JSON: SEATS,
    MAGNUS_URL: "https://magnus.example.test",
    MAGNUS_API_KEY: placeholder("magnus-key"),
    MAGNUS_API_SECRET: placeholder("magnus-secret"),
    ...overrides,
  });
}

/** A Magnus record carrying every prohibited field alongside the real ones. */
function hostileUpstream(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "active",
    sip_username: "9610",
    activation_state: "activated",
    did_number: "17678181234",
    registration_server: "voice00.epic.dm",
    forward_to_cell: true,
    cell_number: "17678185555",
    // None of the following may ever surface.
    sip_password: SIP_SECRET,
    ha1: "a".repeat(32),
    provisioning_url: `csc:9610:${SIP_SECRET}@EPIC.VOICE.LITE`,
    qr_payload: "data:image/png;base64,AAAA",
    provider_config: { raw: "everything" },
    unknown_future_field: "should be discarded",
    ...overrides,
  };
}

function stubSource(record: Record<string, unknown> | null): PersonalLineSource {
  return { fetchSeat: async (_seat: VoiceSeat) => record };
}

const PATH = `/v1/tenants/${TENANT}/members/${MEMBER}/personal-line`;

// ---------------------------------------------------------------------------
// Projection — the containment core
// ---------------------------------------------------------------------------

describe("projection", () => {
  it("returns exactly the seven approved fields", () => {
    const out = projectPersonalLine(hostileUpstream()) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(
      [
        "activation_state",
        "cell_number",
        "did_number",
        "forward_to_cell",
        "registration_server",
        "sip_username",
        "state",
      ].sort(),
    );
  });

  it("discards unknown upstream fields", () => {
    const out = projectPersonalLine(hostileUpstream()) as Record<string, unknown>;
    expect(out["unknown_future_field"]).toBeUndefined();
    expect(out["provider_config"]).toBeUndefined();
  });

  it("never emits the SIP secret under any key", () => {
    const serialised = JSON.stringify(projectPersonalLine(hostileUpstream()));
    expect(serialised).not.toContain(SIP_SECRET);
    expect(serialised).not.toContain("csc:");
    expect(serialised).not.toContain("data:image/");
  });

  it("drops a credential-shaped value even under an allowlisted key", () => {
    // The upstream puts a csc: URI into an approved field. Absence, not masking.
    const out = projectPersonalLine(
      hostileUpstream({ registration_server: `csc:9610:${SIP_SECRET}@EPIC.VOICE.LITE` }),
    ) as Record<string, unknown>;
    expect(out["registration_server"]).toBeUndefined();
  });
});

describe("provisioning_error redaction", () => {
  it("passes through the established redactor", () => {
    const out = projectPersonalLine(
      hostileUpstream({ provisioning_error: `magnus rejected secret ${SIP_SECRET} for 9610` }),
    );
    expect(out.provisioning_error).toBeDefined();
    expect(out.provisioning_error).not.toContain(SIP_SECRET);
    expect(out.provisioning_error).toContain("[redacted]");
  });

  it("withholds the diagnostic entirely when it still looks credential-bearing", () => {
    // A credential we never saw as its own field, so redaction cannot name it.
    const out = projectPersonalLine({
      state: "error",
      provisioning_error: "failed to apply csc:9610:zzzzzzzzzzzz@EPIC.VOICE.LITE",
    });
    expect(out.provisioning_error).toBe("provisioning failed; details withheld");
  });

  it("withholds a user:password@host URI", () => {
    expect(
      safeProvisioningError("upstream said https://admin:hunter2000@magnus.example", []),
    ).toBe("provisioning failed; details withheld");
  });

  it("leaves an ordinary diagnostic intact", () => {
    expect(safeProvisioningError("DID not available in this region", [SIP_SECRET])).toBe(
      "DID not available in this region",
    );
  });

  /** Pins the ported redactor against the original's documented contract. */
  it("matches the established redactor's semantics", () => {
    expect(redactSecret(null, "abcdef")).toBeNull();
    expect(redactSecret("hello", null)).toBe("hello");
    expect(redactSecret("hello short", "short")).toBe("hello short"); // under 6 chars
    expect(redactSecret("a SECRETVALUE b", "SECRETVALUE")).toBe("a [redacted] b");
    expect(redactSecret("a secretvalue b", "SECRETVALUE")).toBe("a secretvalue b"); // case-sensitive
    expect(redactSecrets("x AAAAAA y BBBBBB", ["AAAAAA", "BBBBBB"])).toBe(
      "x [redacted] y [redacted]",
    );
  });
});

// ---------------------------------------------------------------------------
// Seat mapping and scope
// ---------------------------------------------------------------------------

describe("seat mapping", () => {
  it("fails closed on malformed JSON", () => {
    const result = parseVoiceSeats("{not json");
    expect(result.ok).toBe(false);
    expect(result.seats).toEqual([]);
  });

  it("refuses an ambiguous (tenant, member) mapping", () => {
    const dup = JSON.stringify([
      { tenantId: TENANT, memberId: MEMBER, magnusExtension: "1" },
      { tenantId: TENANT, memberId: MEMBER, magnusExtension: "2" },
    ]);
    const result = parseVoiceSeats(dup);
    expect(result.ok).toBe(false);
  });

  it("resolves only an exact tenant AND member match", () => {
    const seats = parseVoiceSeats(SEATS).seats;
    expect(resolveSeat(seats, TENANT, MEMBER)?.magnusExtension).toBe("9610");
    // Right member, wrong tenant — the cross-tenant case.
    expect(resolveSeat(seats, OTHER_TENANT, MEMBER)).toBeNull();
    expect(resolveSeat(seats, TENANT, "member-nobody")).toBeNull();
    expect(resolveSeat(seats, "", "")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

describe("HTTP", () => {
  it("returns the projection for an authenticated, in-scope caller", async () => {
    const server = await startServer({
      config: voiceEnv(),
      personalLineSource: stubSource(hostileUpstream()),
    });
    try {
      const res = await get(server.url, PATH, VOICE_TOKEN);
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("ok");
      const line = res.json["personalLine"] as Record<string, unknown>;
      expect(line["sip_username"]).toBe("9610");
      expect(res.text).not.toContain(SIP_SECRET);
      expect(res.text).not.toContain("csc:");
    } finally {
      await server.close();
    }
  });

  it("refuses an unauthenticated caller", async () => {
    const server = await startServer({
      config: voiceEnv(),
      personalLineSource: stubSource(hostileUpstream()),
    });
    try {
      const res = await get(server.url, PATH);
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("refuses a wrong bearer", async () => {
    const server = await startServer({
      config: voiceEnv(),
      personalLineSource: stubSource(hostileUpstream()),
    });
    try {
      const res = await get(server.url, PATH, placeholder("wrong"));
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("is 503 when no voice token is configured", async () => {
    const server = await startServer({
      config: voiceEnv({ GATEWAY_VOICE_READ_TOKEN: undefined }),
      personalLineSource: stubSource(hostileUpstream()),
    });
    try {
      const res = await get(server.url, PATH, VOICE_TOKEN);
      expect(res.status).toBe(503);
      expect(res.json["outcome"]).toBe("no_voice_token_configured");
    } finally {
      await server.close();
    }
  });

  it("answers a cross-tenant lookup with 404, not 403", async () => {
    const server = await startServer({
      config: voiceEnv(),
      personalLineSource: stubSource(hostileUpstream()),
    });
    try {
      // A real member, asked for under a tenant they do not belong to.
      const res = await get(
        server.url,
        `/v1/tenants/${OTHER_TENANT}/members/${MEMBER}/personal-line`,
        VOICE_TOKEN,
      );
      expect(res.status).toBe(404);
      // Identical body to an unknown route: nothing distinguishes the two.
      const unknown = await get(server.url, "/v1/nothing-here", VOICE_TOKEN);
      expect(unknown.status).toBe(404);
      expect(res.json["outcome"]).toBe(unknown.json["outcome"]);
    } finally {
      await server.close();
    }
  });

  it("answers an unknown member with 404", async () => {
    const server = await startServer({
      config: voiceEnv(),
      personalLineSource: stubSource(hostileUpstream()),
    });
    try {
      const res = await get(
        server.url,
        `/v1/tenants/${TENANT}/members/member-nobody/personal-line`,
        VOICE_TOKEN,
      );
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("is invisible while the kill switch is off", async () => {
    const server = await startServer({
      config: voiceEnv({ GATEWAY_VOICE_READ_ENABLED: "false" }),
      personalLineSource: stubSource(hostileUpstream()),
    });
    try {
      const res = await get(server.url, PATH, VOICE_TOKEN);
      expect(res.status).toBe(404);
      expect(res.json["outcome"]).toBe("not_found");
    } finally {
      await server.close();
    }
  });

  it("refuses every unsafe method", async () => {
    const server = await startServer({
      config: voiceEnv(),
      personalLineSource: stubSource(hostileUpstream()),
    });
    try {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await fetch(`${server.url}${PATH}`, {
          method,
          headers: { authorization: `Bearer ${VOICE_TOKEN}` },
        });
        expect(res.status).toBe(405);
      }
    } finally {
      await server.close();
    }
  });

  it("rate limits after the configured budget", async () => {
    const server = await startServer({
      config: voiceEnv({ GATEWAY_VOICE_RATE_LIMIT: "2" }),
      personalLineSource: stubSource(hostileUpstream()),
    });
    try {
      expect((await get(server.url, PATH, VOICE_TOKEN)).status).toBe(200);
      expect((await get(server.url, PATH, VOICE_TOKEN)).status).toBe(200);
      const third = await get(server.url, PATH, VOICE_TOKEN);
      expect(third.status).toBe(429);
      expect(third.json["outcome"]).toBe("rate_limited");
    } finally {
      await server.close();
    }
  });

  it("returns 404 when Magnus has no seat, and never echoes upstream text", async () => {
    const server = await startServer({
      config: voiceEnv(),
      personalLineSource: stubSource(null),
    });
    try {
      const res = await get(server.url, PATH, VOICE_TOKEN);
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("reports an upstream failure as a category, never as raw provider text", async () => {
    const leaky: PersonalLineSource = {
      fetchSeat: async () => {
        throw new Error(`Magnus error: rejected secret ${SIP_SECRET}`);
      },
    };
    const server = await startServer({ config: voiceEnv(), personalLineSource: leaky });
    try {
      const res = await get(server.url, PATH, VOICE_TOKEN);
      expect(res.status).toBe(503);
      expect(res.json["outcome"]).toBe("voice_upstream_unavailable");
      expect(res.text).not.toContain(SIP_SECRET);
      expect(res.text).not.toContain("Magnus error");
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

describe("audit", () => {
  it("records route, outcome and correlation id, and no credential", async () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    const server = await startServer({
      config: voiceEnv(),
      logger,
      personalLineSource: stubSource(
        hostileUpstream({ provisioning_error: `rejected ${SIP_SECRET}` }),
      ),
    });
    try {
      const res = await get(server.url, PATH, VOICE_TOKEN);
      expect(res.status).toBe(200);

      const audit = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      const entry = audit.find((l) => l["event"] === "personal_line_read");
      expect(entry).toBeDefined();
      expect(entry!["route"]).toBe(
        "/v1/tenants/:tenantId/members/:memberId/personal-line",
      );
      expect(entry!["outcome"]).toBe("ok");
      expect(entry!["correlationId"]).toEqual(expect.any(String));
      expect(entry!["tenantId"]).toBe(TENANT);

      const all = lines.join("\n");
      expect(all).not.toContain(SIP_SECRET);
      expect(all).not.toContain(VOICE_TOKEN);
      expect(all).not.toContain("csc:");
    } finally {
      await server.close();
    }
  });
});
