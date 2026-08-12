/**
 * Secret redaction for values that must never reach a browser or a log.
 *
 * PROVENANCE. This is a faithful port of `artifacts/isola/lib/redact-secret.ts`,
 * the redactor established by the P0 SIP-credential containment (2026-08-12,
 * PR #100). It is copied rather than imported because this service is a
 * standalone npm package with its own lockfile and Dockerfile — the container
 * build copies only `services/isola-gateway`, so a cross-package relative
 * import would type-check locally and then fail to build the image.
 *
 * `test/voice.test.ts` pins the behaviour against the same cases the original's
 * unit test asserts, so the two cannot drift silently.
 *
 * The finding it exists for: `provisioning_error` is assembled from upstream
 * Magnus responses and was returned verbatim. An upstream error that echoes the
 * credential it rejected turns a legitimate diagnostic field into a credential
 * leak — one that removing `sip_password` from the response shape would never
 * have caught, because the credential arrives through a field nobody classifies
 * as sensitive.
 */

/**
 * Below this length a "secret" is too short to redact without mangling ordinary
 * text — and a real Magnus secret is 12+ characters.
 */
const MIN_REDACTABLE_LENGTH = 6;

export const REDACTED = "[redacted]";

/**
 * Remove every occurrence of `secret` from `text`.
 *
 * Returns `text` unchanged when there is nothing to redact, so callers can pass
 * a possibly-null secret without branching. Matching is exact and
 * case-sensitive: SIP secrets are generated with `crypto.randomBytes(...)` and
 * are case-significant, so a case-insensitive match would only widen the blast
 * radius into ordinary words.
 */
export function redactSecret(
  text: string | null | undefined,
  secret: string | null | undefined,
): string | null {
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
