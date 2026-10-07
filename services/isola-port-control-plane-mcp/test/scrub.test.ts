import { describe, it, expect } from "vitest";
import { scrubSecrets, redactFreeText, redactValue, isFreeTextKey, isAllowlistedBlueprint, ALLOWLISTED_BLUEPRINTS } from "../src/redact.js";
import { FAKE, SURVIVORS, seededDescription } from "./helpers/fixtures.js";

describe("value-level scrub with positive controls", () => {
  const out = redactFreeText(seededDescription());

  it("CONTROL: the scrubber is not a no-op (fires on a known-bad value)", () => {
    const bad = FAKE.sk;
    expect(scrubSecrets(bad)).not.toBe(bad);
    expect(scrubSecrets(bad)).toContain("[REDACTED:api_key]");
    // and the seeded text really did contain every bad value before scrubbing
    const before = seededDescription();
    for (const v of [FAKE.bearer, FAKE.sk, FAKE.jwt, FAKE.pwAssign, FAKE.conn, FAKE.phonePlus, FAKE.phoneCompact, FAKE.phoneDashed]) {
      expect(before).toContain(v);
    }
    expect(before).toContain("PRIVATE KEY");
  });

  it("scrubs bearer, auth header, sk-, JWT, PEM, assignment, connection string, phones, email", () => {
    expect(out).not.toContain("abcDEF123456");
    expect(out).toContain("[REDACTED:authorization_header]");
    expect(out).not.toContain(FAKE.sk);
    expect(out).toContain("[REDACTED:api_key]");
    expect(out).not.toContain(FAKE.jwt);
    expect(out).toContain("[REDACTED:jwt]");
    expect(out).not.toContain("MIIBOgIBAAJB");
    expect(out).toContain("[REDACTED:pem_private_key]");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[REDACTED:credential_assignment]");
    expect(out).not.toContain("s3cretpw");
    expect(out).toContain("[REDACTED:connection_string]");
    expect(out).not.toMatch(/767[ -]818|818[ -]0001|17678180001/);
    expect(out).toContain("0001"); // last four kept
    expect(out).not.toContain("eric@epic.dm");
    expect(out).toContain("e***@dm");
  });

  it("leaves ISO timestamp, date, version, uuid, labelled sha256, labelled commit, entity id, pct, amount untouched", () => {
    for (const v of Object.values(SURVIVORS)) expect(out).toContain(v);
  });

  it("scrubs the other key shapes", () => {
    const cases: [string, string][] = [
      ["gh" + "p_" + "a".repeat(30), "github_token"],
      ["github_pat_" + "B".repeat(30), "github_token"],
      ["xox" + "b-" + "1234567890-abcdefghij", "slack_token"],
      ["AKIA" + "ABCDEFGHIJKLMNOP", "aws_access_key"],
      ["AIza" + "C".repeat(35), "google_api_key"]
    ];
    for (const [v, kind] of cases) {
      const r = scrubSecrets(`value ${v} end`);
      expect(r).not.toContain(v);
      expect(r).toContain(`[REDACTED:${kind}]`);
    }
  });

  it("scrubs unlabelled long hex / mixed runs but passes labelled digests", () => {
    const hex = "ab12".repeat(10);
    expect(scrubSecrets(`blob ${hex}`)).toContain("[REDACTED:long_secret_like_string]");
    expect(scrubSecrets(`sha256: ${hex}`)).toContain(hex);
    expect(scrubSecrets(`digest=${hex}`)).toContain(hex);
    expect(scrubSecrets("x" + "Q9".repeat(20))).toContain("[REDACTED:long_secret_like_string]");
  });

  it("strict phone mask does not mangle dates/versions/ids but masks E.164-style", () => {
    expect(redactFreeText("on 2026-10-07 at 2026-10-07T01:02:03Z v1.2.3 req-p00-2026 12%")).toBe("on 2026-10-07 at 2026-10-07T01:02:03Z v1.2.3 req-p00-2026 12%");
    expect(redactFreeText("ring +1 767 818 0001 now")).toBe("ring *******0001 now");
    expect(redactFreeText("ring 767-818-0001.")).toContain("******0001");
    expect(redactFreeText("(767) 818-0001")).not.toContain("818");
  });

  it("applies to structured strings too, without breaking existing phone/email masking or dates", () => {
    const r = redactValue({ a: `x ${FAKE.sk}`, phone: "+17678183742", when: "2026-07-01T00:00:00Z", d: "2026-10-07", sha256: SURVIVORS.sha256 }) as any;
    expect(r.a).toContain("[REDACTED:api_key]");
    expect(r.phone).toBe("*******3742");
    expect(r.when).toBe("2026-07-01T00:00:00Z");
    expect(r.d).toBe("2026-10-07");
    expect(r.sha256).toBe(SURVIVORS.sha256);
  });
});

describe("free-text whitelist and allowlist", () => {
  it("permits prose fields, never conversation or secret-looking keys", () => {
    for (const k of ["description", "plan", "current_state", "next_action", "decision_text", "rationale", "objective", "acceptance", "evidence_needed", "rollback", "root_cause", "resolution", "contract"]) {
      expect(isFreeTextKey("execution_plan", k)).toBe(true);
    }
    for (const k of ["body", "message", "transcript", "content", "text", "api_token", "secret_note", "key"]) {
      expect(isFreeTextKey("execution_plan", k)).toBe(false);
    }
    expect(isFreeTextKey("customer", "description")).toBe(false);
  });

  it("allowlist includes the five additions and keeps the originals", () => {
    for (const bp of ["execution_plan", "execution_packet", "isola_launch_gate", "isola_component", "agent_contract", "decision", "build_task", "risk"]) {
      expect(isAllowlistedBlueprint(bp)).toBe(true);
    }
    for (const bp of ["customer", "contract", "customer_pii_record"]) expect(isAllowlistedBlueprint(bp)).toBe(false);
    expect(ALLOWLISTED_BLUEPRINTS.length).toBe(16);
  });
});
