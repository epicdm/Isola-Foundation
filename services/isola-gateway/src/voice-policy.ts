/**
 * DECLARATIONS ONLY. No logic, no projection, no network, no serialisation.
 *
 * This module exists for one reason: the credential source scan
 * (`test/voice-credential-surface.test.ts`) needs somewhere to read the
 * forbidden names from, and any file it reads them from must be exempt from
 * its own checks. Keeping the declarations here — and NOTHING else — means the
 * exemption is one tiny declaration-only file rather than a whole-file blind
 * spot over `voice.ts`, which is where the browser projection and the upstream
 * adapter actually live.
 *
 * The first revision of this work exempted `voice.ts`. A credential
 * construction added to the most important file in the feature would have
 * evaded the invariant entirely. Do not move these constants back.
 *
 * Rule for this file: if you are about to add a function, it belongs in
 * `voice.ts`. The scan asserts this file declares and does not execute.
 */

/**
 * The ONLY fields a caller may ever receive. Widening this list is a security
 * decision, not a formatting one.
 */
export const PERSONAL_LINE_FIELDS = [
  "state",
  "sip_username",
  "activation_state",
  "did_number",
  "registration_server",
  "forward_to_cell",
  "cell_number",
] as const;

export type PersonalLineField = (typeof PERSONAL_LINE_FIELDS)[number];

/**
 * Field names that must never appear in a projected response, and whose values
 * are treated as credentials to be scrubbed out of any diagnostic string.
 *
 * `sip_password` is the field from the original P0 (PR #100). The rest are the
 * shapes a credential has historically arrived in once the obvious name was
 * removed — including the camelCase aliases a future TypeScript-side mapping
 * would introduce.
 */
export const PROHIBITED_FIELDS = [
  "sip_password",
  "sipPassword",
  "sipPass",
  "sip_pass",
  "password",
  "passwd",
  "secret",
  "sip_secret",
  "sipSecret",
  "auth_password",
  "authPassword",
  "ha1",
  "provisioning_url",
  "provisioningUrl",
  "provisioning_uri",
  "provisioningUri",
  "qr",
  "qr_payload",
  "qrPayload",
  "qr_code",
  "qrCode",
  "csc_url",
  "cscUrl",
  "config_url",
  "configUrl",
  "raw",
  "raw_config",
  "rawConfig",
  "provider_config",
  "providerConfig",
] as const;

/**
 * A value that *looks* like a credential regardless of the key it arrived
 * under. Deliberately unanchored: an earlier revision required the scheme to
 * start the string or follow whitespace, so an ordinary diagnostic such as
 *
 *     rejected "csc:user:password@host"
 *     invalid (https://user:password@host)
 *
 * slipped through with the credential intact. Punctuation must not be an
 * escape hatch, so there is no leading context requirement at all.
 *
 * Three shapes:
 *  1. the Acrobits `csc:` provisioning scheme, with any number of slashes;
 *  2. any `scheme://user:password@host` userinfo pair;
 *  3. a `data:image/` URI, which is how a QR payload travels.
 */
export const CREDENTIAL_SHAPED_VALUE =
  /csc:\/{0,2}|[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@|data:image\//i;
