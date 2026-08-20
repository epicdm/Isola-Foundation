/**
 * CREDENTIAL ROTATION GRACE.
 *
 * The gateway and this service live in DIFFERENT STACKS and cannot be rolled
 * atomically. Before this existed, replacing a shared secret meant an interval
 * where the caller presented the new value and the callee still expected the old
 * one — and on the public path that interval is every customer message failing
 * closed. Grace is a second accepted value per exposure class, so the two sides
 * can be rolled separately.
 *
 * The danger of a grace mechanism is that it quietly WIDENS authority. This file
 * exists mostly to prove it does not: a NEXT value resolves to the SAME exposure
 * as the CURRENT value beside it, never the other one, and a NEXT that collides
 * with the other class refuses startup rather than dissolving the boundary the
 * service exists to enforce.
 *
 * Every "rejected" assertion here is paired with an "accepted" one in the same
 * run, so a resolver that refused EVERYTHING could not pass this file.
 */
import { describe, expect, it } from "vitest";

import { resolveCredential } from "../src/auth.js";
import { bootErrors } from "../src/config.js";
import { envConfig, INTERNAL_SECRET, PUBLIC_SECRET, placeholder } from "./harness.js";

const NEW_PUBLIC = placeholder("public-next");
const NEW_INTERNAL = placeholder("internal-next");
const UNRELATED = placeholder("unrelated");

const bearer = (t: string) => `Bearer ${t}`;
const kindOf = (config: ReturnType<typeof envConfig>, token: string) =>
  resolveCredential(config, bearer(token));

/** The three rotation states, as configuration. */
const BEFORE = () => envConfig();
const OVERLAP = () => envConfig({ RUNTIME_SECRET_PUBLIC_NEXT: NEW_PUBLIC });
const AFTER = () => envConfig({ RUNTIME_SECRET_PUBLIC: NEW_PUBLIC });

describe("the rotation matrix for RUNTIME_SECRET_PUBLIC", () => {
  it("BEFORE grace: old accepted, new rejected", () => {
    const c = BEFORE();
    expect(kindOf(c, PUBLIC_SECRET)).toEqual({ kind: "ok", credentialExposure: "PUBLIC" });
    expect(kindOf(c, NEW_PUBLIC).kind).toBe("unauthorized");
  });

  it("DURING overlap: BOTH old and new accepted, as PUBLIC", () => {
    const c = OVERLAP();
    expect(kindOf(c, PUBLIC_SECRET)).toEqual({ kind: "ok", credentialExposure: "PUBLIC" });
    expect(kindOf(c, NEW_PUBLIC)).toEqual({ kind: "ok", credentialExposure: "PUBLIC" });
  });

  it("AFTER cutover: old rejected, new accepted", () => {
    const c = AFTER();
    expect(kindOf(c, PUBLIC_SECRET).kind).toBe("unauthorized");
    expect(kindOf(c, NEW_PUBLIC)).toEqual({ kind: "ok", credentialExposure: "PUBLIC" });
  });

  it("an unrelated token is rejected in ALL THREE states", () => {
    for (const c of [BEFORE(), OVERLAP(), AFTER()]) {
      expect(kindOf(c, UNRELATED).kind).toBe("unauthorized");
    }
  });

  it("removing the grace value makes the old credential fail immediately", () => {
    // This is the step that actually ends a rotation. If it did not work, the
    // old credential would stay valid forever and the rotation would be theatre.
    expect(kindOf(OVERLAP(), PUBLIC_SECRET).kind).toBe("ok");
    expect(kindOf(AFTER(), PUBLIC_SECRET).kind).toBe("unauthorized");
  });
});

describe("grace does not widen authority", () => {
  it("a PUBLIC grace value is never accepted as INTERNAL", () => {
    const c = OVERLAP();
    const r = kindOf(c, NEW_PUBLIC);
    expect(r).toEqual({ kind: "ok", credentialExposure: "PUBLIC" });
    expect(r).not.toEqual({ kind: "ok", credentialExposure: "INTERNAL" });
  });

  it("an INTERNAL grace value is never accepted as PUBLIC", () => {
    const c = envConfig({ RUNTIME_SECRET_INTERNAL_NEXT: NEW_INTERNAL });
    expect(kindOf(c, NEW_INTERNAL)).toEqual({ kind: "ok", credentialExposure: "INTERNAL" });
  });

  it("the INTERNAL credential is untouched while PUBLIC is mid-rotation", () => {
    const c = OVERLAP();
    expect(kindOf(c, INTERNAL_SECRET)).toEqual({ kind: "ok", credentialExposure: "INTERNAL" });
  });

  it("both classes can hold a grace value at once without crossing", () => {
    const c = envConfig({
      RUNTIME_SECRET_PUBLIC_NEXT: NEW_PUBLIC,
      RUNTIME_SECRET_INTERNAL_NEXT: NEW_INTERNAL,
    });
    expect(kindOf(c, PUBLIC_SECRET)).toEqual({ kind: "ok", credentialExposure: "PUBLIC" });
    expect(kindOf(c, NEW_PUBLIC)).toEqual({ kind: "ok", credentialExposure: "PUBLIC" });
    expect(kindOf(c, INTERNAL_SECRET)).toEqual({ kind: "ok", credentialExposure: "INTERNAL" });
    expect(kindOf(c, NEW_INTERNAL)).toEqual({ kind: "ok", credentialExposure: "INTERNAL" });
    expect(kindOf(c, UNRELATED).kind).toBe("unauthorized");
  });
});

describe("with no grace configured, behaviour is exactly what it was", () => {
  it("secretsNext is null for both classes and nothing changes", () => {
    const c = envConfig();
    expect(c.secretsNext.PUBLIC).toBeNull();
    expect(c.secretsNext.INTERNAL).toBeNull();
    expect(kindOf(c, PUBLIC_SECRET)).toEqual({ kind: "ok", credentialExposure: "PUBLIC" });
    expect(kindOf(c, INTERNAL_SECRET)).toEqual({ kind: "ok", credentialExposure: "INTERNAL" });
    expect(kindOf(c, UNRELATED).kind).toBe("unauthorized");
  });

  it("a blank grace value is treated as absent, not as an empty credential", () => {
    const c = envConfig({ RUNTIME_SECRET_PUBLIC_NEXT: "" });
    expect(c.secretsNext.PUBLIC).toBeNull();
    expect(bootErrors(c)).toEqual([]);
    // And the empty string must never authenticate.
    expect(resolveCredential(c, "Bearer ").kind).toBe("unauthorized");
  });

  it("the pre-existing identical-secrets refusal still holds", () => {
    const c = envConfig({ RUNTIME_SECRET_PUBLIC: INTERNAL_SECRET });
    expect(kindOf(c, INTERNAL_SECRET).kind).toBe("unauthorized");
  });
});

describe("mis-configured grace REFUSES STARTUP", () => {
  it("a NEXT with no CURRENT is fatal", () => {
    const c = envConfig({ RUNTIME_SECRET_PUBLIC: "", RUNTIME_SECRET_PUBLIC_NEXT: NEW_PUBLIC });
    const errs = bootErrors(c).join(" | ");
    expect(errs).toContain("RUNTIME_SECRET_PUBLIC_NEXT is set but RUNTIME_SECRET_PUBLIC is not");
  });

  it("a NEXT identical to its CURRENT is fatal", () => {
    const c = envConfig({ RUNTIME_SECRET_PUBLIC_NEXT: PUBLIC_SECRET });
    expect(bootErrors(c).join(" | ")).toContain("identical to RUNTIME_SECRET_PUBLIC");
  });

  it("a PUBLIC NEXT colliding with the INTERNAL credential is fatal", () => {
    // The boundary must survive rotation. Without this, grace would be the way
    // to quietly dissolve the only separation this service enforces.
    const c = envConfig({ RUNTIME_SECRET_PUBLIC_NEXT: INTERNAL_SECRET });
    expect(bootErrors(c).join(" | ")).toContain("collides with a INTERNAL credential");
  });

  it("a PUBLIC NEXT colliding with the INTERNAL NEXT is fatal", () => {
    const c = envConfig({
      RUNTIME_SECRET_PUBLIC_NEXT: NEW_PUBLIC,
      RUNTIME_SECRET_INTERNAL_NEXT: NEW_PUBLIC,
    });
    expect(bootErrors(c).join(" | ")).toContain("collides with");
  });

  it("POSITIVE CONTROL: a correctly configured overlap is NOT fatal", () => {
    // Without this, every test above would pass against a bootErrors() that
    // simply refused everything.
    expect(bootErrors(OVERLAP())).toEqual([]);
    expect(bootErrors(BEFORE())).toEqual([]);
    expect(bootErrors(AFTER())).toEqual([]);
  });
});

describe("no credential value escapes", () => {
  it("refusal messages name the VARIABLE, never the value", () => {
    const cases = [
      envConfig({ RUNTIME_SECRET_PUBLIC: "", RUNTIME_SECRET_PUBLIC_NEXT: NEW_PUBLIC }),
      envConfig({ RUNTIME_SECRET_PUBLIC_NEXT: PUBLIC_SECRET }),
      envConfig({ RUNTIME_SECRET_PUBLIC_NEXT: INTERNAL_SECRET }),
    ];
    for (const c of cases) {
      const text = bootErrors(c).join(" | ");
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain(PUBLIC_SECRET);
      expect(text).not.toContain(INTERNAL_SECRET);
      expect(text).not.toContain(NEW_PUBLIC);
    }
  });

  it("POSITIVE CONTROL: the scan can detect a sentinel when one IS present", () => {
    // Proves the assertions above are not passing vacuously.
    expect(`prefix ${NEW_PUBLIC} suffix`).toContain(NEW_PUBLIC);
  });
});
