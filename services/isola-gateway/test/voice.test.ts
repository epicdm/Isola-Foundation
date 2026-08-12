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
  MAGNUS_FIELD_MAP,
  MAGNUS_SIP_MODULE,
  MAGNUS_SIP_READ_ACTION,
  MAGNUS_SIP_SELECTOR_FIELD,
  normaliseMagnusRow,
  parseVoiceSeats,
  projectPersonalLine,
  resolveSeat,
  safeDecodeIdentifier,
  safeProvisioningError,
  selectExactSeatRow,
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

/** A source that records whether it was ever consulted. */
function countingSource(record: Record<string, unknown> | null = null): PersonalLineSource & {
  calls: number;
} {
  const source = {
    calls: 0,
    async fetchSeat(_seat: VoiceSeat) {
      source.calls += 1;
      return record;
    },
  };
  return source;
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

/**
 * BLOCKER 1. Validation is all-or-nothing: any invalid entry empties the whole
 * usable list. The first revision returned `ok: false` while retaining the
 * valid entries, and the request path read `.seats` directly — so a mapping
 * advertised as failing closed still served seats.
 */
const INVALID_MAPPINGS: Array<[string, string | undefined]> = [
  [
    "duplicate (tenantId, memberId)",
    JSON.stringify([
      { tenantId: TENANT, memberId: MEMBER, magnusExtension: "9610" },
      { tenantId: TENANT, memberId: MEMBER, magnusExtension: "9611" },
    ]),
  ],
  [
    "one valid entry plus one invalid entry",
    JSON.stringify([
      { tenantId: TENANT, memberId: MEMBER, magnusExtension: "9610" },
      { tenantId: "t2", magnusExtension: "9611" },
    ]),
  ],
  [
    "one valid entry plus one duplicate",
    JSON.stringify([
      { tenantId: TENANT, memberId: MEMBER, magnusExtension: "9610" },
      { tenantId: "t2", memberId: "m2", magnusExtension: "9612" },
      { tenantId: "t2", memberId: "m2", magnusExtension: "9613" },
    ]),
  ],
  [
    "missing tenant",
    JSON.stringify([{ memberId: MEMBER, magnusExtension: "9610" }]),
  ],
  [
    "missing member",
    JSON.stringify([{ tenantId: TENANT, magnusExtension: "9610" }]),
  ],
  [
    "missing Magnus identifier",
    JSON.stringify([{ tenantId: TENANT, memberId: MEMBER }]),
  ],
  ["malformed JSON", "{not json"],
  ["non-array JSON", JSON.stringify({ tenantId: TENANT })],
  ["empty mapping", undefined],
];

describe("seat mapping fails closed (blocker 1)", () => {
  for (const [label, raw] of INVALID_MAPPINGS) {
    it(`yields an empty usable seat list: ${label}`, () => {
      const result = parseVoiceSeats(raw);
      // Whatever `ok` says, nothing usable may survive.
      expect(result.seats).toEqual([]);
      expect(resolveSeat(result, TENANT, MEMBER)).toBeNull();
    });
  }

  it("refuses to resolve against a result whose ok is not true, even if seats leak in", () => {
    // Defensive: simulates a future caller reconstructing the result by hand.
    const forged = {
      ok: false,
      errors: ["anything"],
      seats: [{ tenantId: TENANT, memberId: MEMBER, magnusExtension: "9610" }],
    };
    expect(resolveSeat(forged, TENANT, MEMBER)).toBeNull();
  });

  it("resolves only an exact tenant AND member match on a valid document", () => {
    const parsed = parseVoiceSeats(SEATS);
    expect(parsed.ok).toBe(true);
    expect(resolveSeat(parsed, TENANT, MEMBER)?.magnusExtension).toBe("9610");
    // Right member, wrong tenant — the cross-tenant case.
    expect(resolveSeat(parsed, OTHER_TENANT, MEMBER)).toBeNull();
    expect(resolveSeat(parsed, TENANT, "member-nobody")).toBeNull();
    expect(resolveSeat(parsed, "", "")).toBeNull();
  });
});

describe("request-level: an invalid mapping 404s and never calls upstream (blocker 1)", () => {
  for (const [label, raw] of INVALID_MAPPINGS) {
    it(`${label} → 404, identical to an unknown route, upstream untouched`, async () => {
      const source = countingSource(hostileUpstream());
      const server = await startServer({
        config: voiceEnv({ GATEWAY_VOICE_SEATS_JSON: raw }),
        personalLineSource: source,
      });
      try {
        const res = await get(server.url, PATH, VOICE_TOKEN);
        const unknown = await get(server.url, "/v1/nothing-here", VOICE_TOKEN);
        expect(res.status).toBe(404);
        expect(res.json["outcome"]).toBe(unknown.json["outcome"]);
        expect(res.json["error"]).toBe(unknown.json["error"]);
        // The upstream must never be consulted for an unresolvable seat.
        expect(source.calls).toBe(0);
      } finally {
        await server.close();
      }
    });
  }
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
// BLOCKER 2 — the returned row must BE the requested seat
// ---------------------------------------------------------------------------

describe("upstream row binding (blocker 2)", () => {
  const SELECTOR = MAGNUS_SIP_SELECTOR_FIELD;

  it("uses the canonical live contract: sip / read / name", () => {
    // Matches the proven client in artifacts/isola/engines/magnus.ts
    // (findRowByField) and artifacts/isola/lib/magnus-voice.ts (findOneByField).
    expect(MAGNUS_SIP_MODULE).toBe("sip");
    expect(MAGNUS_SIP_READ_ACTION).toBe("read");
    expect(SELECTOR).toBe("name");
  });

  it("returns null when the filter was ignored and the first row is someone else", () => {
    const rows = [
      { [SELECTOR]: "9999", state: "active" },
      { [SELECTOR]: "8888", state: "active" },
    ];
    expect(selectExactSeatRow(rows, SELECTOR, "9610")).toBeNull();
  });

  it("finds the correct row when it appears after a mismatched first row", () => {
    const rows = [
      { [SELECTOR]: "9999", state: "other" },
      { [SELECTOR]: "9610", state: "mine" },
      { [SELECTOR]: "8888", state: "other" },
    ];
    expect(selectExactSeatRow(rows, SELECTOR, "9610")?.["state"]).toBe("mine");
  });

  it("returns null on zero matches", () => {
    expect(selectExactSeatRow([{ [SELECTOR]: "1" }], SELECTOR, "9610")).toBeNull();
    expect(selectExactSeatRow([], SELECTOR, "9610")).toBeNull();
  });

  it("returns null on duplicate exact matches rather than guessing", () => {
    const rows = [
      { [SELECTOR]: "9610", state: "a" },
      { [SELECTOR]: "9610", state: "b" },
    ];
    expect(selectExactSeatRow(rows, SELECTOR, "9610")).toBeNull();
  });

  it("accepts a numeric identifier that stringifies to the requested seat", () => {
    expect(selectExactSeatRow([{ [SELECTOR]: 9610 }], SELECTOR, "9610")).not.toBeNull();
  });

  it("does not match on a loose or padded identifier", () => {
    expect(selectExactSeatRow([{ [SELECTOR]: " 9610" }], SELECTOR, "9610")).toBeNull();
    expect(selectExactSeatRow([{ [SELECTOR]: "96100" }], SELECTOR, "9610")).toBeNull();
  });

  it("ignores non-object rows", () => {
    expect(selectExactSeatRow(["9610", null, 42], SELECTOR, "9610")).toBeNull();
  });

  /**
   * The live probe against voice00.epic.dm reported a `sip` row exposing only
   * `id` and `name`. Only the proven mapping is applied; the other six fields
   * are ABSENT rather than guessed from a same-named column.
   */
  describe("live-proven field mapping", () => {
    it("maps only the proven column, sip.name -> sip_username", () => {
      expect(MAGNUS_FIELD_MAP.map(([f]) => f)).toEqual(["sip_username"]);
      const mapped = normaliseMagnusRow({ id: "17", name: "9610" });
      expect(mapped["sip_username"]).toBe("9610");
    });

    it("leaves unproven fields absent rather than inventing them", () => {
      const projected = projectPersonalLine(normaliseMagnusRow({ id: "17", name: "9610" }));
      expect(Object.keys(projected)).toEqual(["sip_username"]);
      expect(projected).not.toHaveProperty("state");
      expect(projected).not.toHaveProperty("activation_state");
    });

    it("never emits a credential column carried through for redaction", () => {
      const mapped = normaliseMagnusRow({
        name: "9610",
        secret: SIP_SECRET,
        provisioning_error: `rejected ${SIP_SECRET}`,
      });
      // Carried on the intermediate record so the redactor can see it...
      expect(mapped["secret"]).toBe(SIP_SECRET);
      // ...but never projected, and scrubbed out of the diagnostic.
      const projected = projectPersonalLine(mapped) as Record<string, unknown>;
      expect(projected["secret"]).toBeUndefined();
      expect(JSON.stringify(projected)).not.toContain(SIP_SECRET);
      expect(projected["provisioning_error"]).toContain("[redacted]");
    });
  });
});

// ---------------------------------------------------------------------------
// BLOCKER 4 — path decoding must never throw
// ---------------------------------------------------------------------------

describe("path identifier decoding (blocker 4)", () => {
  it("rejects malformed percent-encoding instead of throwing", () => {
    expect(safeDecodeIdentifier("%E0%A4%A")).toBeNull();
    expect(safeDecodeIdentifier("%")).toBeNull();
    expect(safeDecodeIdentifier("%ZZ")).toBeNull();
  });

  it("rejects encoded separators and control characters", () => {
    expect(safeDecodeIdentifier("a%2Fb")).toBeNull(); // encoded slash
    expect(safeDecodeIdentifier("a%5Cb")).toBeNull(); // encoded backslash
    expect(safeDecodeIdentifier("a%00b")).toBeNull(); // NUL
    expect(safeDecodeIdentifier("a%20b")).toBeNull(); // space
    expect(safeDecodeIdentifier("")).toBeNull();
  });

  it("accepts ordinary opaque identifiers", () => {
    expect(safeDecodeIdentifier("tenant-acme")).toBe("tenant-acme");
    expect(safeDecodeIdentifier("8D3dp3z")).toBe("8D3dp3z");
    expect(safeDecodeIdentifier("member%2Deric")).toBe("member-eric");
  });

  const BAD_PATHS: Array<[string, string]> = [
    ["malformed percent sequence in tenant", "/v1/tenants/%E0%A4%A/members/m/personal-line"],
    ["malformed percent sequence in member", "/v1/tenants/t/members/%E0%A4%A/personal-line"],
    ["bare percent", "/v1/tenants/%/members/m/personal-line"],
    ["encoded slash", "/v1/tenants/a%2Fb/members/m/personal-line"],
    ["encoded NUL", "/v1/tenants/t/members/a%00b/personal-line"],
  ];

  for (const [label, path] of BAD_PATHS) {
    it(`${label} → 404 and the service stays up`, async () => {
      const source = countingSource(hostileUpstream());
      const server = await startServer({
        config: voiceEnv(),
        personalLineSource: source,
      });
      try {
        const res = await get(server.url, path, VOICE_TOKEN);
        expect(res.status).toBe(404);
        expect(source.calls).toBe(0);
        // The handler survived: a normal request still works afterwards.
        expect((await get(server.url, PATH, VOICE_TOKEN)).status).toBe(200);
      } finally {
        await server.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// BLOCKER 5 — GET only
// ---------------------------------------------------------------------------

describe("HTTP method contract (blocker 5)", () => {
  const REFUSED = ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

  for (const method of REFUSED) {
    it(`${method} is refused 405 and never reaches the upstream`, async () => {
      const source = countingSource(hostileUpstream());
      const server = await startServer({
        config: voiceEnv(),
        personalLineSource: source,
      });
      try {
        const res = await fetch(`${server.url}${PATH}`, {
          method,
          headers: { authorization: `Bearer ${VOICE_TOKEN}` },
        });
        expect(res.status).toBe(405);
        expect(source.calls).toBe(0);
      } finally {
        await server.close();
      }
    });
  }

  it("GET is the only method that performs a read", async () => {
    const source = countingSource(hostileUpstream());
    const server = await startServer({ config: voiceEnv(), personalLineSource: source });
    try {
      expect((await get(server.url, PATH, VOICE_TOKEN)).status).toBe(200);
      expect(source.calls).toBe(1);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Credential-shaped values after punctuation (Codex P1)
// ---------------------------------------------------------------------------

describe("credential detection is not defeated by punctuation", () => {
  const CASES = [
    'rejected "csc:user:password@host"',
    "invalid (https://user:password@host)",
    "[csc://user:password@host]",
    "error:csc:user:password@host",
    "see <sip://alice:hunter2000@voice00.epic.dm>",
    "payload=data:image/png;base64,AAAA",
  ];

  for (const text of CASES) {
    it(`withholds: ${text.slice(0, 34)}…`, () => {
      expect(safeProvisioningError(text, [])).toBe("provisioning failed; details withheld");
    });
  }

  it("still lets an ordinary diagnostic through", () => {
    expect(safeProvisioningError("DID not available (region: DM)", [])).toBe(
      "DID not available (region: DM)",
    );
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
