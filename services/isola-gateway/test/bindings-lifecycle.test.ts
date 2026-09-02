/**
 * Lifecycle enforcement at the routing boundary.
 *
 * Lifecycle used to be Paperclip metadata (`isolaLifecycle`) that nothing read.
 * A PUBLIC agent marked `staged-not-ready` woke and replied to a customer
 * message. These tests exist so that cannot recur: `accepted` is now a routing
 * precondition, and everything else fails closed.
 *
 * Dependency-free — pure functions only, no network, no filesystem, no clock.
 */
import { describe, expect, it } from "vitest";
import {
  isRoutableLifecycle,
  parseBindings,
  redactBinding,
  resolveBinding,
  ROUTABLE_LIFECYCLE,
  type Binding,
} from "../src/bindings.js";

/** A binding that is servable in every respect except what a test overrides. */
function binding(over: Partial<Binding> = {}): Binding {
  return {
    tenantId: "t-1",
    chatwootAccountId: 2,
    chatwootInboxId: 6,
    chatwootAgentBotId: 2,
    agentBotSecret: "s",
    agentBotAccessToken: "a",
    paperclipCompanyId: "c-1",
    paperclipAgentId: "ag-1",
    templateId: "tpl@v1",
    exposure: "PUBLIC",
    allowedSenders: [],
    status: "active",
    lifecycle: ROUTABLE_LIFECYCLE,
    ...over,
  };
}
const resolve = (b: Binding) => resolveBinding([b], 2, 6);

describe("isRoutableLifecycle — fail closed on anything but the exact string", () => {
  it("accepts only the exact literal", () => {
    expect(isRoutableLifecycle("accepted")).toBe(true);
    expect(ROUTABLE_LIFECYCLE).toBe("accepted");
  });

  it.each([
    ["absent/undefined", undefined],
    ["null", null],
    ["staged-not-ready", "staged-not-ready"],
    ["rejected", "rejected"],
    ["provisioning", "provisioning"],
    ["failed", "failed"],
    ["unknown value", "totally-unknown-state"],
    ["empty string", ""],
    ["differing case", "Accepted"],
    ["uppercase", "ACCEPTED"],
    ["leading whitespace", " accepted"],
    ["trailing whitespace", "accepted "],
    ["boolean true", true],
    ["number", 1],
    ["object", { lifecycle: "accepted" }],
    ["array", ["accepted"]],
  ])("refuses %s", (_label, value) => {
    expect(isRoutableLifecycle(value)).toBe(false);
  });
});

describe("resolveBinding — lifecycle gates routing", () => {
  it("accepted + active + PUBLIC proceeds to the next authorization layer", () => {
    const r = resolve(binding());
    expect(r.kind).toBe("ok");
  });

  it("staged-not-ready cannot receive traffic", () => {
    const r = resolve(binding({ lifecycle: "staged-not-ready" }));
    expect(r.kind).toBe("not_accepted");
    if (r.kind === "not_accepted") expect(r.lifecycle).toBe("staged-not-ready");
  });

  it("PUBLIC + staged-not-ready cannot receive traffic — exposure never implies acceptance", () => {
    const r = resolve(binding({ exposure: "PUBLIC", lifecycle: "staged-not-ready" }));
    expect(r.kind).toBe("not_accepted");
  });

  it("accepted + inactive (retired) binding cannot receive traffic", () => {
    const r = resolve(binding({ lifecycle: "accepted", status: "retired" }));
    expect(r.kind).not.toBe("ok");
    expect(r.kind).toBe("retired");
  });

  it("an unknown lifecycle cannot receive traffic", () => {
    const r = resolve(binding({ lifecycle: "some-future-state" }));
    expect(r.kind).toBe("not_accepted");
  });

  it("lifecycle absence cannot receive traffic", () => {
    const r = resolve(binding({ lifecycle: null }));
    expect(r.kind).toBe("not_accepted");
    if (r.kind === "not_accepted") expect(r.lifecycle).toBeNull();
  });

  it("a stale projection value cannot receive traffic", () => {
    const r = resolve(binding({ lifecycle: "accepted@v0" }));
    expect(r.kind).toBe("not_accepted");
  });

  it("routes INTERNAL now — refusal moved to the per-sender allowlist", () => {
    const r = resolve(binding({ exposure: "INTERNAL", lifecycle: "accepted" }));
    expect(r.kind).toBe("ok");
  });

  it("but lifecycle STILL gates an INTERNAL binding — exposure grants nothing", () => {
    // The old ordering comment stands: exposure passing never short-circuits
    // readiness. An unaccepted internal agent is as unroutable as a public one.
    expect(resolve(binding({ exposure: "INTERNAL", lifecycle: "staged-not-ready" })).kind)
      .toBe("not_accepted");
  });
});

/**
 * Precedence: match -> status -> exposure -> lifecycle.
 *
 * The operator's deliberate disposition (retired) must never be masked by a
 * derived platform state (lifecycle). An earlier revision evaluated lifecycle
 * first; it was routing-inert but rewrote audit evidence for retired bindings.
 */
describe("resolution precedence preserves the operator's disposition", () => {
  it("retired + missing lifecycle -> retired", () => {
    expect(resolve(binding({ status: "retired", lifecycle: null })).kind).toBe("retired");
  });

  it("retired + accepted -> retired", () => {
    expect(resolve(binding({ status: "retired", lifecycle: "accepted" })).kind).toBe("retired");
  });

  it("retired + staged-not-ready -> retired (lifecycle must not mask the disposition)", () => {
    expect(resolve(binding({ status: "retired", lifecycle: "staged-not-ready" })).kind).toBe("retired");
  });

  it("retired + unknown lifecycle -> retired", () => {
    expect(resolve(binding({ status: "retired", lifecycle: "who-knows" })).kind).toBe("retired");
  });

  it("active + missing lifecycle -> not_accepted", () => {
    expect(resolve(binding({ status: "active", lifecycle: null })).kind).toBe("not_accepted");
  });

  it("active + staged-not-ready -> not_accepted", () => {
    expect(resolve(binding({ status: "active", lifecycle: "staged-not-ready" })).kind).toBe("not_accepted");
  });

  it("active + accepted + UNRECOGNISED exposure -> exposure denial", () => {
    // INTERNAL is admissible since 2026-08-17; an exposure nobody defined is not.
    expect(
      resolve(binding({ status: "active", lifecycle: "accepted", exposure: "SEMI" as never })).kind,
    ).toBe("not_public");
  });

  it("active + accepted + eligible exposure -> proceeds", () => {
    expect(resolve(binding({ status: "active", lifecycle: "accepted", exposure: "PUBLIC" })).kind)
      .toBe("ok");
  });

  it("the retired refusal shape is byte-identical to the pre-change contract", () => {
    // No field added, no field removed: downstream audit and metrics that keyed
    // on this object continue to see exactly what they saw before.
    const b = binding({ status: "retired", lifecycle: null });
    expect(resolve(b)).toEqual({ kind: "retired", tenantId: b.tenantId });
  });

  it("every retired binding reports retired regardless of lifecycle", () => {
    const lifecycles = [null, "accepted", "staged-not-ready", "rejected", "", "ACCEPTED", "future"];
    const kinds = new Set(
      lifecycles.map((l) => resolve(binding({ status: "retired", lifecycle: l })).kind),
    );
    expect([...kinds]).toEqual(["retired"]);
  });

  it("no lifecycle value can rescue a duplicate routing key", () => {
    const r = resolveBinding([binding(), binding({ tenantId: "t-2" })], 2, 6);
    expect(r.kind).toBe("duplicate");
  });

  it("exhaustive sweep: only the exact accepted literal ever resolves ok", () => {
    const values: unknown[] = [
      "accepted", "Accepted", "ACCEPTED", " accepted", "accepted ", "",
      "staged-not-ready", "rejected", "provisioning", "failed", "active",
      null, undefined, 0, 1, true, false, {}, [],
    ];
    const ok = values.filter(
      (v) => resolve(binding({ lifecycle: v as Binding["lifecycle"] })).kind === "ok",
    );
    expect(ok).toEqual(["accepted"]);
  });
});

describe("parseBindings — lifecycle never breaks boot (inertness guarantee)", () => {
  const base = {
    tenantId: "t-1",
    chatwootAccountId: 2,
    chatwootInboxId: 6,
    chatwootAgentBotId: 2,
    agentBotSecret: "s",
    agentBotAccessToken: "a",
    paperclipCompanyId: "c-1",
    paperclipAgentId: "ag-1",
    templateId: "tpl@v1",
    exposure: "PUBLIC",
    allowedSenders: [],
    status: "retired",
  };

  it("parses a pre-existing binding that has NO lifecycle field", () => {
    const r = parseBindings(JSON.stringify([base]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bindings[0]?.lifecycle).toBeNull();
  });

  it("a malformed lifecycle costs that binding its routability, not the boot", () => {
    const r = parseBindings(JSON.stringify([{ ...base, status: "active", lifecycle: 42 }]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bindings[0]?.lifecycle).toBeNull();
      expect(resolveBinding(r.bindings, 2, 6).kind).toBe("not_accepted");
    }
  });

  it("keeps an unknown lifecycle verbatim so the refusal can report it", () => {
    const r = parseBindings(JSON.stringify([{ ...base, status: "active", lifecycle: "weird" }]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bindings[0]?.lifecycle).toBe("weird");
  });

  it("admits INTERNAL at boot; an UNKNOWN exposure is still refused", () => {
    const admitted = parseBindings(
      JSON.stringify([{ ...base, exposure: "INTERNAL", lifecycle: "accepted" }]),
    );
    expect(admitted.ok).toBe(true);

    const refused = parseBindings(
      JSON.stringify([{ ...base, exposure: "SEMI-PUBLIC", lifecycle: "accepted" }]),
    );
    expect(refused.ok).toBe(false);
  });
});

describe("redactBinding — routability is explicit and no secret leaks", () => {
  it("surfaces lifecycle and a computed routable flag", () => {
    const out = redactBinding(binding({ lifecycle: "staged-not-ready" }));
    expect(out.lifecycle).toBe("staged-not-ready");
    expect(out.lifecycleRoutable).toBe(false);
    expect(redactBinding(binding()).lifecycleRoutable).toBe(true);
  });

  it("never returns secret material", () => {
    const out = JSON.stringify(redactBinding(binding()));
    expect(out).not.toContain("\"s\"");
    expect(out).toContain("[redacted]");
  });
});

describe("regression: the fd2867d1 shape cannot route", () => {
  // The production binding as it exists today: PUBLIC, retired, no lifecycle.
  it("refuses, and refused before this change too — proving inertness", () => {
    const r = resolve(binding({ lifecycle: null, status: "retired" }));
    expect(r.kind).not.toBe("ok");
  });

  // The dangerous shape: someone flips status to active without acceptance.
  it("flipping status to active is NOT sufficient to route", () => {
    const r = resolve(binding({ lifecycle: null, status: "active" }));
    expect(r.kind).toBe("not_accepted");
  });
});
