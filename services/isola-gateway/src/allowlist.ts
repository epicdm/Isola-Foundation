/**
 * WHO MAY TALK TO AN INTERNAL LINE.
 *
 * An INTERNAL binding is a staff line. It reaches an agent with an internal
 * charter, internal context, and — as capability grows — internal tools. A
 * stranger who finds the number must never reach the brain at all.
 *
 * THE DEFAULT IS REFUSAL, AND THAT IS THE WHOLE DESIGN. An INTERNAL binding
 * with an empty allowlist answers NOBODY. It is tempting to treat "no list
 * configured" as "not configured yet, so allow" — that reading is how a staff
 * line becomes a public one by omission, silently, at the moment someone
 * half-finishes the config. Fail-closed means the unfinished state is the safe
 * state.
 *
 * A sender we cannot IDENTIFY is also refused. Chatwoot does not always carry a
 * phone number, and "we could not tell who this was" is not a reason to let them
 * through to an internal agent.
 *
 * PUBLIC bindings are untouched. 6737 and 3742 must keep answering everyone;
 * this gate applies only where exposure says INTERNAL.
 */

/**
 * Digits only, so formatting can never decide access.
 *
 * "+1 (767) 818-9043", "17678189043" and "1-767-818-9043" are one number. This
 * does NOT try to be a phone-number library: no country inference, no
 * shortest-suffix matching. Suffix matching in particular would be a security
 * hole — "9043" must not match every number ending in 9043.
 */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D+/g, "");
  // Below 7 digits it is not a dialable international number; treating a short
  // string as an identity would make the list easy to satisfy by accident.
  return digits.length >= 7 ? digits : null;
}

export type SenderVerdict =
  | { allowed: true }
  | { allowed: false; reason: "not_allowlisted" | "empty_allowlist" | "unidentified_sender" };

export interface AllowlistBinding {
  exposure: "PUBLIC" | "INTERNAL";
  /** Staff numbers. Empty means nobody, deliberately. */
  allowedSenders: readonly string[];
}

/**
 * May this sender reach the brain?
 *
 * Returns a REASON on refusal, so the log distinguishes "a stranger messaged the
 * staff line" from "this binding is misconfigured and is refusing everyone".
 * Those need different responses from an operator and must not look alike.
 */
export function checkSender(
  binding: AllowlistBinding,
  senderPhoneRaw: string | null,
): SenderVerdict {
  if (binding.exposure !== "INTERNAL") return { allowed: true };

  if (binding.allowedSenders.length === 0) {
    return { allowed: false, reason: "empty_allowlist" };
  }

  const sender = normalisePhone(senderPhoneRaw);
  if (sender === null) return { allowed: false, reason: "unidentified_sender" };

  for (const entry of binding.allowedSenders) {
    const allowed = normalisePhone(entry);
    // Exact match on the full digit string. See normalisePhone: no suffixes.
    if (allowed !== null && allowed === sender) return { allowed: true };
  }
  return { allowed: false, reason: "not_allowlisted" };
}

/**
 * The one thing a refused sender is told.
 *
 * Static, and it says nothing about what this line is FOR beyond "staff". It
 * does not confirm whether the number is in use, does not name the agent, and
 * does not vary by reason — a message that differed between "not on the list"
 * and "list is empty" would let an outsider probe the configuration.
 *
 * It DOES point at the front door, because the likeliest refused sender is a
 * customer who found the wrong number, and leaving them with a dead end is the
 * failure this whole programme is against.
 */
export function refusalText(frontDoorNumber: string | null): string {
  const base = "This line is for EPIC staff.";
  if (frontDoorNumber === null || frontDoorNumber.trim().length === 0) return base;
  return `${base} For business enquiries please message ${frontDoorNumber.trim()}.`;
}
