/**
 * Lane-2 broker door allowlist.
 *
 * Deliberately INDEPENDENT of lib/clawith/gate.ts and ISOLA_AI_LOOP_ENABLED.
 * That gate/master-switch governs the existing NATIVE auto-reply path for
 * production door 5:46 (AgentBot 4). This module governs a different, new
 * surface entirely — the adapter-submitted broker turn endpoint — and must
 * share NO state with the native gate, so flipping either can never affect
 * the other. AgentBot 4 and inbox 46 are provably unaffected by this file.
 *
 * Same shape as HERMES_ALLOWED_PHONE_NUMBER_IDS / ISOLA_BRIDGE_ALLOWED_
 * PHONE_NUMBER_IDS in lib/brain-provider.ts and the door-key pattern in
 * lib/clawith/gate.ts: hardcoded floor + additive env var, so a new door
 * goes live with a Secret + restart, never a code deploy.
 */

/** Comma-separated `<chatwoot_account_id>:<inbox_id>` keys. Additive only. */
export const LANE2_BROKER_ALLOWED_DOOR_KEYS_ENV = 'LANE2_BROKER_ALLOWED_DOOR_KEYS';

/**
 * The always-on floor of doors this bounded release targets. Account 5 /
 * inbox 47 is the isolated SHADOW test door (dec-deepseek-foundation-
 * brokered-clawith-refactor-2026-08-02) — never inbox 46, never AgentBot 4.
 */
const _LANE2_BROKER_DOORS_HARDCODED: readonly string[] = ['5:47'];

export function lane2DoorKey(
  chatwootAccountId: string | number,
  inboxId: string | number,
): string {
  return `${String(chatwootAccountId).trim()}:${String(inboxId).trim()}`;
}

export function lane2BrokerAllowedDoors(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  return new Set([
    ..._LANE2_BROKER_DOORS_HARDCODED,
    ...(env[LANE2_BROKER_ALLOWED_DOOR_KEYS_ENV]?.split(',').map((s) => s.trim()).filter(Boolean) ?? []),
  ]);
}

/** True only when this exact (account, inbox) door is explicitly listed. */
export function isLane2BrokerDoor(
  chatwootAccountId: string | number | null | undefined,
  inboxId: string | number | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (chatwootAccountId === null || chatwootAccountId === undefined || String(chatwootAccountId).trim() === '') {
    return false;
  }
  if (inboxId === null || inboxId === undefined || String(inboxId).trim() === '') return false;
  return lane2BrokerAllowedDoors(env).has(lane2DoorKey(chatwootAccountId, inboxId));
}
