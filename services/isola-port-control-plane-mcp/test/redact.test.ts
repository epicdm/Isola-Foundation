import { describe, it, expect } from "vitest";
import {
  maskPhoneNumber,
  maskEmail,
  redactValue,
  sanitizeEntity,
  sanitizeEntities,
  isAllowlistedBlueprint
} from "../src/redact.js";

describe("phone number masking", () => {
  it("masks all but last 4 digits", () => {
    expect(maskPhoneNumber("+17678183742")).toBe("*******3742");
  });

  it("masks a dashed phone number, preserving trailing 4 digits", () => {
    const masked = maskPhoneNumber("767-818-3742");
    expect(masked.endsWith("3742")).toBe(true);
    expect(masked).not.toMatch(/818/);
  });

  it("keeps last 4 digits visible for a plain 10-digit number", () => {
    const masked = maskPhoneNumber("7678183742");
    expect(masked.endsWith("3742")).toBe(true);
    expect(masked).not.toContain("767818");
  });
});

describe("email masking", () => {
  it("keeps first char of local part + TLD only", () => {
    expect(maskEmail("eric@epic.dm")).toBe("e***@dm");
    expect(maskEmail("phillip@example.com")).toBe("p***@com");
  });

  it("leaves non-email strings untouched", () => {
    expect(maskEmail("not-an-email")).toBe("not-an-email");
  });
});

describe("redactValue - secret-key fields", () => {
  it("fully redacts any key matching /(secret|token|key|password|credential)/i regardless of type", () => {
    const input = {
      clientSecret: "abc123",
      apiKey: 12345,
      accessToken: { nested: "value" },
      password: ["a", "b"],
      PORT_CLIENT_CREDENTIAL: "xyz",
      normalField: "keep me"
    };
    const result = redactValue(input) as Record<string, unknown>;
    expect(result.clientSecret).toBe("[REDACTED]");
    expect(result.apiKey).toBe("[REDACTED]");
    expect(result.accessToken).toBe("[REDACTED]");
    expect(result.password).toBe("[REDACTED]");
    expect(result.PORT_CLIENT_CREDENTIAL).toBe("[REDACTED]");
    expect(result.normalField).toBe("keep me");
  });
});

describe("redactValue - phone/email in nested fixtures", () => {
  it("masks phone and email fields nested in an object", () => {
    const input = {
      properties: {
        contact_phone: "+17678183742",
        contact_email: "eric@epic.dm",
        title: "Some decision title"
      }
    };
    const result = redactValue(input) as any;
    expect(result.properties.contact_phone).toBe("*******3742");
    expect(result.properties.contact_email).toBe("e***@dm");
    expect(result.properties.title).toBe("Some decision title");
  });

  it("strips message body / transcript fields entirely (defense in depth)", () => {
    const input = { body: "hey this is a WhatsApp transcript", message: "call me back", normalField: "x" };
    const result = redactValue(input) as any;
    expect(result.body).toBe("[STRIPPED]");
    expect(result.message).toBe("[STRIPPED]");
    expect(result.normalField).toBe("x");
  });
});

describe("entity-type allowlist", () => {
  it("accepts allowlisted blueprints", () => {
    expect(isAllowlistedBlueprint("decision")).toBe(true);
    expect(isAllowlistedBlueprint("build_task")).toBe(true);
    expect(isAllowlistedBlueprint("requirement")).toBe(true);
    expect(isAllowlistedBlueprint("defect")).toBe(true);
  });

  it("rejects a non-allowlisted blueprint entity via sanitizeEntity", () => {
    const entity = { blueprint: "customer_pii_record", identifier: "cust-1", properties: { phone: "+17678183742" } };
    expect(sanitizeEntity(entity)).toBeNull();
  });

  it("rejects entities with no blueprint field at all", () => {
    const entity = { identifier: "mystery-1", properties: {} };
    expect(sanitizeEntity(entity)).toBeNull();
  });

  it("sanitizeEntities drops non-allowlisted entities and keeps allowlisted ones", () => {
    const entities = [
      { blueprint: "build_task", identifier: "bt-1", properties: { status: "Backlog" } },
      { blueprint: "secret_blueprint", identifier: "s-1", properties: {} },
      { blueprint: "decision", identifier: "decision-1", properties: {} }
    ];
    const result = sanitizeEntities(entities);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.blueprint)).toEqual(["build_task", "decision"]);
  });

  it("accepts a real confirmed-live entity id shape and redacts nested PII while keeping structure", () => {
    const entity = {
      blueprint: "build_task",
      identifier: "bt-release-control-implementation",
      $updatedAt: "2026-07-01T00:00:00Z",
      properties: {
        status: "Backlog",
        owner_phone: "+17678183742",
        owner_email: "eric@epic.dm",
        description: "Implement release-boundary enforcement"
      }
    };
    const result = sanitizeEntity(entity) as any;
    expect(result).not.toBeNull();
    expect(result.identifier).toBe("bt-release-control-implementation");
    expect(result.properties.owner_phone).toBe("*******3742");
    expect(result.properties.owner_email).toBe("e***@dm");
  });
});

