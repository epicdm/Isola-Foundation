/**
 * Which lane wrote an operation row.
 *
 * The two id schemes are structurally distinct — `op_` + 64 hex from the neutral
 * ledger, `op-` + 32 hex from the pre-existing customer scheme — so the lane is
 * recoverable from the id alone, with no extra column and no guessing. This is
 * written down and tested rather than left as something everyone is assumed to
 * know.
 */

import { LEGACY_ID_PREFIX, NEUTRAL_ID_PREFIX, type CallerClass } from './ledger'

export type CallerClassVerdict =
  | { known: true; callerClass: CallerClass; basis: 'id_scheme' | 'envelope' }
  | { known: false; reason: string }

/**
 * @param operationId the stored operation id
 * @param envelopeCallerClass the caller class recorded in the envelope, when the
 *        row has one. An envelope is a direct statement and beats inference.
 */
export function callerClassOf(
  operationId: string,
  envelopeCallerClass?: CallerClass | null,
): CallerClassVerdict {
  if (envelopeCallerClass) {
    return { known: true, callerClass: envelopeCallerClass, basis: 'envelope' }
  }
  if (operationId.startsWith(NEUTRAL_ID_PREFIX)) {
    return { known: true, callerClass: 'foundation_staff', basis: 'id_scheme' }
  }
  if (operationId.startsWith(LEGACY_ID_PREFIX)) {
    return { known: true, callerClass: 'customer_agent', basis: 'id_scheme' }
  }
  // Say so rather than defaulting. A wrong attribution in an audit trail is
  // worse than an absent one.
  return { known: false, reason: `operation id "${operationId}" matches no known scheme` }
}
