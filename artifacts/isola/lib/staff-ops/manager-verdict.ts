/**
 * manager-verdict.ts — the codec for a MANAGER's Approve / Return tap.
 *
 * WHY A SECOND CODEC AND NOT A SIXTH STAFF ACTION. A staff tap names a work
 * EPISODE (`sa:<action>:<correlationId>`); a manager tap names a VERIFICATION
 * ACTIVITY (`mv:<verdict>:<activityId>`) — a different Odoo object, reached by a
 * different authority rule. Folding a verdict into `StaffMenuAction` would mean
 * one decoder returning a reference whose *type* depends on the action, and the
 * first bug that produces would be a verdict applied to a task id.
 *
 * The two codecs are deliberately mutually unreadable: `decodeMenuId` rejects
 * an `mv:` id and `decodeManagerVerdictId` rejects an `sa:` id, both returning
 * null rather than guessing. That is asserted in the tests, because it is the
 * property that keeps the split safe.
 *
 * WHAT THIS MODULE IS NOT. It is not authority. The activity id travels through
 * a handset and is not a secret, so the caller must still re-read the activity
 * from Odoo and confirm it is open and assigned to this manager. Decoding only
 * answers "what did they tap", never "may they".
 */

import { WA_LIMITS, type ManagerVerdict, type MenuItem, type MenuRendering } from './staff-menu'

export type { ManagerVerdict }

/** Namespace prefix. Distinct from the staff `sa` prefix by construction. */
const MANAGER_ID_PREFIX = 'mv'

/**
 * Encode a manager verdict against a verification activity.
 *
 * Format: `mv:<verdict>:<activityId>`. The activity is the Odoo-native object
 * created by `requestManagerVerification`, so the tap lands on exactly the
 * verification episode that was raised — not on the task, which may carry
 * several over its life.
 */
export function encodeManagerVerdictId(verdict: ManagerVerdict, activityId: number): string {
  if (!Number.isInteger(activityId) || activityId <= 0) {
    throw new Error(`activityId must be a positive integer, got: ${activityId}`)
  }
  const id = `${MANAGER_ID_PREFIX}:${verdict}:${activityId}`
  if (id.length > WA_LIMITS.buttonId) {
    throw new Error(`manager verdict id exceeds ${WA_LIMITS.buttonId} chars: ${id.length}`)
  }
  return id
}

/**
 * Encode a manager verdict for a TEMPLATE quick-reply button.
 *
 * Same codec, tighter ceiling — Meta caps a template payload at 128 characters
 * rather than the 256 an interactive button id allows. Asserted separately so a
 * payload that would 400 at send time fails in a test instead of on a handset.
 */
export function encodeManagerVerdictTemplatePayload(
  verdict: ManagerVerdict,
  activityId: number,
): string {
  const payload = encodeManagerVerdictId(verdict, activityId)
  if (payload.length > WA_LIMITS.templateButtonPayload) {
    throw new Error(
      `manager verdict payload exceeds ${WA_LIMITS.templateButtonPayload} chars: ${payload.length}`,
    )
  }
  return payload
}

/**
 * Decode a manager verdict id. Fail-closed in every direction: wrong prefix,
 * wrong arity, unknown verdict, or a reference that is not a positive integer
 * all return null so the caller falls through rather than guessing.
 *
 * The integer check is load-bearing. A correlation id like
 * `sw-ba290d79-task-2291-1lxvft5` is a perfectly plausible thing to find in the
 * third position if the two codecs are ever mixed up upstream; `Number()` would
 * yield NaN and a lax check would let it through as a truthy-ish reference.
 */
export function decodeManagerVerdictId(
  raw: string | null | undefined,
): { verdict: ManagerVerdict; activityId: number } | null {
  if (!raw) return null
  const parts = raw.split(':')
  if (parts.length !== 3) return null
  const [prefix, verdict, ref] = parts
  if (prefix !== MANAGER_ID_PREFIX) return null
  if (!isManagerVerdict(verdict)) return null
  if (!/^[0-9]+$/.test(ref)) return null
  const activityId = Number(ref)
  if (!Number.isInteger(activityId) || activityId <= 0) return null
  return { verdict, activityId }
}

function isManagerVerdict(v: string): v is ManagerVerdict {
  return v === 'approve' || v === 'return'
}

/**
 * Button copy. `return` reads as "Return for rework" rather than "Reject",
 * because the work is going back to the person who did it, not being thrown
 * away — and the manager is choosing between two next steps, not passing
 * judgement on a colleague.
 */
export function managerVerdictLabel(verdict: ManagerVerdict): string {
  return verdict === 'approve' ? 'Approve' : 'Return for rework'
}

/** One line of help under each row, list rendering only. */
export function managerVerdictDescription(verdict: ManagerVerdict): string {
  return verdict === 'approve'
    ? 'Accept the work and close verification'
    : 'Send it back with a reason'
}

/**
 * The two-button menu a manager sees. Always exactly two actions, so this is
 * always `buttons` and never a list — asserted here rather than discovered when
 * Meta rejects a fourth button.
 */
export function buildManagerVerdictMenu(activityId: number): MenuRendering {
  const items: MenuItem[] = (['approve', 'return'] as const).map((verdict) => {
    const title = managerVerdictLabel(verdict)
    if (title.length > WA_LIMITS.buttonTitle) {
      throw new Error(`button title "${title}" exceeds ${WA_LIMITS.buttonTitle} chars`)
    }
    return {
      id: encodeManagerVerdictId(verdict, activityId),
      title,
      description: managerVerdictDescription(verdict),
      action: verdict,
    }
  })
  return { kind: 'buttons', items }
}
