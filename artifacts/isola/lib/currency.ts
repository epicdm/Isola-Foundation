/**
 * lib/currency.ts — EC$ (XCD) ↔ US$ conversion. Single source of truth for
 * the USD→EC$ rate used anywhere in this repo that has to convert.
 *
 * FINDING (verified 2026-07-12): Magnus bills natively in EC$ (XCD) —
 * `engines/magnus.ts`'s balance read hardcodes `currency: 'EC
`, and every
 * `Wallet.currency` in our own schema defaults to `"EC$"`. There is no
 * per-rate currency field in Magnus's `rate` module because the whole
 * account (and therefore every rate on it) is denominated in the plan
 * owner's single Magnus `user.credit` balance, which is EC$.
 *
 * `ecdToUsd()` is a reference conversion for the admin UI, so an operator
 * thinking in US$ (e.g. pricing against a diaspora competitor) can see
 * roughly what an EC$ rate looks like in US$. It does NOT affect what gets
 * written to Magnus for that flow — every rate write is still the EC$
 * `rateinitial` value. Adjustable at runtime via the rate calculator's own
 * input; this is just the starting default.
 *
 * `usdToEcd()` is the REAL conversion used by the direct-card wallet top-up
 * path (`/api/wallet/topup`) to compute how much EC$ to credit for a USD
 * charge — see that route for why this was added (2026-07-13 FX bug fix:
 * that path was crediting Magnus 1:1 regardless of the charge currency).
 * The BFF Lite pay-link top-up path applies FX on its own side and does not
 * use this file at all — do not wire this into that path.
 */
export const DEFAULT_ECD_PER_USD = 2.7;

export function ecdToUsd(ecd: number, ecdPerUsd: number = DEFAULT_ECD_PER_USD): number {
  if (!ecdPerUsd) return 0;
  return ecd / ecdPerUsd;
}

export function usdToEcd(usd: number, ecdPerUsd: number = DEFAULT_ECD_PER_USD): number {
  return usd * ecdPerUsd;
}
