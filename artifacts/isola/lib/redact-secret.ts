/**
 * Redaction for values that must never reach a browser or a log.
 *
 * Written for a specific P0 finding (2026-08-12): the voice-line routes return
 * `provisioning_error` verbatim, and that string is assembled from upstream
 * Magnus responses. An upstream error that echoes the credential it rejected
 * turns a legitimate diagnostic field into a credential leak — a leak that no
 * amount of removing `sip_password` from the response shape would have caught,
 * because the credential arrives through a field nobody thinks of as sensitive.
 *
 * Deliberately shared by both auth realms. lib/session.ts and
 * lib/consumer-session.ts share no code on purpose — that separation is about
 * identity and trust, and it is why the same defect had to be fixed twice. A
 * pure string function carries no identity and no trust; duplicating it would
 * only mean fixing the next redaction bug twice as well.
 */

/** Below this length a "secret" is too short to redact without mangling
 *  ordinary text — and a real Magnus secret is 12+ characters. */
const MIN_REDACTABLE_LENGTH = 6;

export const REDACTED = '[redacted]';

/**
 * Remove every occurrence of `secret` from `text`.
 *
 * Returns `text` unchanged when there is nothing to redact, so callers can pass
 * a possibly-null secret without branching. Matching is exact and
 * case-sensitive: SIP secrets are generated with `crypto.randomBytes(...)` and
 * are case-significant, so a case-insensitive match would only widen the blast
 * radius into ordinary words.
 */
export function redactSecret(text: string | null | undefined, secret: string | null | undefined): string | null {
  if (text == null) return null;
  if (!secret || secret.length < MIN_REDACTABLE_LENGTH) return text;
  return text.split(secret).join(REDACTED);
}

/**
 * Redact several secrets from one string — for records that carry more than one
 * credential (a SIP secret and an API secret on the same row, say).
 */
export function redactSecrets(
  text: string | null | undefined,
  secrets: readonly (string | null | undefined)[],
): string | null {
  return secrets.reduce<string | null>((acc, s) => redactSecret(acc, s), text ?? null);
}
