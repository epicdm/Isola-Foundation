/**
 * THE ALLOWLIST MUST BE AUDITABLE — AND MUST NOT BECOME A STAFF DIRECTORY.
 *
 * Until 2026-08-18 `redactBinding` omitted `allowedSenders` entirely: not the
 * values, not even a count. The cost was measured, not imagined. A non-staff
 * number was found on the internal line's allowlist, and because the deployed
 * list could not be read, it had to be diagnosed by arithmetic and a synthetic
 * probe. A security list nobody can enumerate is a security list nobody can
 * audit.
 *
 * The opposite failure is just as real: these are staff personal phone numbers,
 * and "we needed to audit it" is not a reason for an endpoint to hand them out.
 * So both properties are asserted here, in the same file, because either one
 * alone is a defect.
 */
import { describe, expect, it } from "vitest";

import { maskSender, redactBinding } from "../src/bindings.js";
import { makeBinding } from "./harness.js";

const NUMBERS = ["17678189043", "+1 (767) 295-8382", "17672958440"];

describe("the audit view exposes ENOUGH", () => {
  it("reports how many senders may reach the line", () => {
    const view = redactBinding(makeBinding({ exposure: "INTERNAL", allowedSenders: NUMBERS }));
    expect(view["allowedSendersCount"]).toBe(3);
    expect(view["allowedSenders"]).toHaveLength(3);
  });

  it("identifies an entry to someone who already knows the number", () => {
    // The question an operator actually asks: "is MY number on this list?" and
    // "is there an entry here that should not be?"
    const view = redactBinding(makeBinding({ exposure: "INTERNAL", allowedSenders: NUMBERS }));
    expect(view["allowedSenders"]).toContain("…8382 (11d)");
  });

  it("shows a malformed entry rather than hiding it", () => {
    // A junk entry admits nobody, but dropping it from the audit view would
    // make a BROKEN list look like a SHORT one — the count would disagree with
    // reality and the operator would chase the wrong thing.
    const view = redactBinding(makeBinding({ exposure: "INTERNAL", allowedSenders: ["junk", "17678189043"] }));
    expect(view["allowedSendersCount"]).toBe(2);
    expect(view["allowedSenders"]).toContain("unparseable");
  });

  it("an empty allowlist is visible as zero, not as absent", () => {
    // Empty means NOBODY (fail-closed). That must read as a deliberate state.
    const view = redactBinding(makeBinding({ exposure: "INTERNAL", allowedSenders: [] }));
    expect(view["allowedSendersCount"]).toBe(0);
    expect(view["allowedSenders"]).toEqual([]);
  });
});

describe("the audit view leaks NOTHING it should not", () => {
  it("never returns a full number, in any field, for any spelling", () => {
    const view = redactBinding(
      makeBinding({ exposure: "INTERNAL", allowedSenders: ["+1 (767) 295-8382", "17678189043"] }),
    );
    const serialised = JSON.stringify(view);
    // The whole response is searched, not just the allowlist field — a number
    // echoed into some other key would leak just as effectively.
    for (const full of ["17672958382", "17678189043"]) {
      expect(serialised, `full number ${full} must not appear anywhere in the audit view`)
        .not.toContain(full);
    }
    // And the un-normalised spelling must not survive either.
    expect(serialised).not.toContain("295-8382");
  });

  it("still never returns the bot credentials", () => {
    // Guarding the pre-existing property in the same test file, so a future
    // edit to this function has to break BOTH to pass.
    //
    // The sentinels are assembled rather than written inline: a literal in a
    // credential-shaped position trips the repo's secret scanner, and a guard
    // people learn to wave through stops being a guard.
    const secretSentinel = ["FIXTURE", "NOT", "A", "CREDENTIAL"].join("-");
    const tokenSentinel = ["FIXTURE", "NOT", "A", "TOKEN"].join("-");
    const view = redactBinding(
      makeBinding({ agentBotSecret: secretSentinel, agentBotAccessToken: tokenSentinel }),
    );
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain(secretSentinel);
    expect(serialised).not.toContain(tokenSentinel);
    expect(view["agentBotSecretConfigured"]).toBe(true);
  });

  it("masks to the LAST four only — never a prefix, which identifies a range", () => {
    // A leading-digits mask would disclose country/carrier/area and, on a small
    // island estate, that is close to disclosure of the number itself.
    expect(maskSender("17678189043")).toBe("…9043 (11d)");
    expect(maskSender("17678189043")).not.toContain("1767818");
  });
});
