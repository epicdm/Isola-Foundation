/**
 * lib/dominica-phone.ts — normalizes a consumer-entered destination number
 * into the exact E.164 Dominica format the BFF Lite `/api/lite/callback`
 * endpoint requires on its `toDominicaNumber` field: "+1767XXXXXXX".
 *
 * WHY DOMINICA-ONLY, TODAY (confirmed live against bff.epic.dm, 2026-07-13):
 *   The BFF's callback endpoint only accepts a field literally named
 *   `toDominicaNumber`, validated with a Dominica-specific regex — this is
 *   true regardless of whether valid `sipUsername`/`sipPassword` credentials
 *   are also sent. Per the product owner (2026-07-13), this restriction is
 *   a WORKAROUND for a known issue on Magnus's outbound trunk, not a
 *   permanent product decision — once that trunk issue is fixed, the BFF
 *   is expected to accept other destinations too. Until then we test with
 *   1767 destinations only.
 *
 *   `CALLBACK_ALLOW_ALL_DESTINATIONS=true` is the single switch to flip once
 *   that fix lands: it relaxes validation on OUR side to accept any E.164
 *   destination. It does NOT change the BFF's own contract — if the BFF
 *   still 422s on non-Dominica numbers at that point, the trunk fix hasn't
 *   actually landed on the BFF side yet, and this flag should stay off.
 */

const DOMINICA_CC_AC = '1767'; // country code (1) + Dominica area code (767)

export interface DominicaNumberResult {
  ok: boolean;
  e164?: string; // "+1767XXXXXXX" (or any E.164 number once the flag below is on)
  error?: string;
}

/** Temporary escape hatch — see file header. Defaults to restricted (false). */
export function callbackAllowsAllDestinations(): boolean {
  return process.env.CALLBACK_ALLOW_ALL_DESTINATIONS === 'true';
}

/** Accepts local 7-digit, 767XXXXXXX, 1767XXXXXXX, or +1767XXXXXXX input. */
export function normalizeDominicaNumber(raw: string): DominicaNumberResult {
  const digits = (raw || '').replace(/[^\d]/g, '');

  let full: string | null = null;
  if (digits.length === 7) {
    full = `${DOMINICA_CC_AC}${digits}`;
  } else if (digits.length === 10 && digits.startsWith('767')) {
    full = `1${digits}`;
  } else if (digits.length === 11 && digits.startsWith(DOMINICA_CC_AC)) {
    full = digits;
  }

  if (!full || !/^1767\d{7}$/.test(full)) {
    return {
      ok: false,
      error: 'Enter a valid Dominica number (e.g. 767-XXX-XXXX). Other countries are temporarily unavailable while we finish a carrier fix.',
    };
  }

  return { ok: true, e164: `+${full}` };
}

/**
 * Generic E.164 normalizer for the post-flag world: accepts local Dominica
 * formats (same as normalizeDominicaNumber) OR any other number that's
 * already/coercible to a plausible E.164 shape (8-15 digits, optional
 * leading +). Used only when callbackAllowsAllDestinations() is true.
 */
export function normalizeAnyDestination(raw: string): DominicaNumberResult {
  const dominica = normalizeDominicaNumber(raw);
  if (dominica.ok) return dominica;

  const digits = (raw || '').replace(/[^\d]/g, '');
  if (digits.length < 8 || digits.length > 15) {
    return { ok: false, error: 'Enter a valid phone number in international format.' };
  }
  return { ok: true, e164: `+${digits}` };
}

/** Picks the right normalizer based on the current feature-flag state. */
export function normalizeCallbackDestination(raw: string): DominicaNumberResult {
  return callbackAllowsAllDestinations() ? normalizeAnyDestination(raw) : normalizeDominicaNumber(raw);
}
