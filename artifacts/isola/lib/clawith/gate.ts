/**
 * Feature gate for the live AI-first customer loop.
 *
 * DEFAULT OFF, in every environment, with no exception. Nothing in this
 * commit changes production behaviour until someone deliberately sets
 * `ISOLA_AI_LOOP_ENABLED=true` AND the Foundation ↔ Clawith integration has
 * been accepted end to end.
 *
 * Two independent conditions must both hold, mirroring the reasoning behind
 * HERMES_ALLOWED_PHONE_NUMBER_IDS in lib/brain-provider.ts: a single boolean
 * is not defence enough on a shared webhook surface. The master switch says
 * "the loop may run at all"; the per-door key says "and only on this door".
 * Flipping the master switch alone reaches nothing.
 */

/** Master switch. Must be exactly the string `true`. */
export const AI_LOOP_ENABLED_ENV = 'ISOLA_AI_LOOP_ENABLED';
/** Comma-separated `<chatwoot_account_id>:<inbox_id>` keys. Additive only. */
export const AI_LOOP_INBOX_KEYS_ENV = 'ISOLA_AI_LOOP_INBOX_KEYS';

/**
 * The always-on floor of doors the loop is DESIGNED for. Listing 6737 here is
 * not "6737 is live" — it is unreachable while the master switch is off. It
 * documents the one door this work targets so a future operator cannot enable
 * the loop and silently reach a door nobody designed it for.
 */
const _GATED_DOORS_HARDCODED: readonly string[] = [
  '5:46', // Chatwoot account 5 / inbox 46 — EPIC 295-6737, Channel::Whatsapp
];

export function doorKey(chatwootAccountId: string | number, inboxId: string | number): string {
  return `${String(chatwootAccountId).trim()}:${String(inboxId).trim()}`;
}

export function gatedDoors(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set([
    ..._GATED_DOORS_HARDCODED,
    ...(env[AI_LOOP_INBOX_KEYS_ENV]?.split(',').map((s) => s.trim()).filter(Boolean) ?? []),
  ]);
}

/** Master switch only. Strict equality with `true` — a stray `1`, `yes` or
 *  `TRUE` does not enable a live customer path. */
export function isAiLoopEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AI_LOOP_ENABLED_ENV] === 'true';
}

/** True only when the master switch is on AND this specific door is listed. */
export function isAiLoopGatedDoor(
  chatwootAccountId: string | number,
  inboxId: string | number | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isAiLoopEnabled(env)) return false;
  if (inboxId === null || inboxId === undefined || String(inboxId).trim() === '') return false;
  return gatedDoors(env).has(doorKey(chatwootAccountId, inboxId));
}
