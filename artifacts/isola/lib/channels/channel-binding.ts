/**
 * Channel binding — Foundation's own record of a channel REQUEST and of what
 * Lane 2 reported back.
 *
 * BOUNDARY, stated so a future edit has to argue with it:
 * this module configures nothing. It does not call Meta, Chatwoot or Clawith.
 * It contains no `fetch`, and a test asserts that. Foundation validates the
 * business request, records it, and later records the result Lane 2 returns.
 * Provisioning is Lane 2's job; a row here is a business fact, not a side effect.
 *
 * It also refuses to store credentials. Everything Lane 2 hands back must be a
 * provider-SAFE reference — an opaque id the provider is happy to expose. A
 * token that reaches this module is a Lane 2 defect, and swallowing it here
 * would turn one lane's mistake into a permanent leak in ours.
 */

export const CHANNEL_CLASSIFICATIONS = ['customer_facing', 'internal_private'] as const
export type ChannelClassification = (typeof CHANNEL_CLASSIFICATIONS)[number]

export const CHANNEL_TYPES = ['whatsapp', 'telegram', 'voice', 'email'] as const
export type ChannelType = (typeof CHANNEL_TYPES)[number]

export const PROVISIONING_STATUSES = ['requested', 'provisioning', 'ready', 'failed'] as const
export type ProvisioningStatus = (typeof PROVISIONING_STATUSES)[number]

export type ChannelBindingRefusal =
  | 'no_tenant'
  | 'no_purpose'
  | 'no_requested_by'
  | 'unknown_type'
  | 'unknown_classification'
  | 'unknown_status'
  | 'classification_immutable'
  | 'secret_shaped_value'

export type ChannelBindingResult<T> =
  | { ok: true; value: T }
  | { ok: false; refusal: ChannelBindingRefusal; detail: string }

/**
 * Credential shapes we refuse outright. Deliberately broad: a false positive
 * costs Lane 2 one renamed field, a false negative costs us a leaked secret in
 * a table the product renders.
 */
const SECRET_SHAPES: ReadonlyArray<{ why: string; test: RegExp }> = [
  { why: 'meta access token', test: /^EAA[A-Za-z0-9]{20,}/ },
  { why: 'github token', test: /^gh[pousr]_[A-Za-z0-9]{20,}/ },
  { why: 'openai-style key', test: /^sk-[A-Za-z0-9_-]{16,}/ },
  { why: 'bearer header', test: /^Bearer\s+\S+/i },
  { why: 'jwt', test: /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { why: 'names itself a credential', test: /(secret|password|passwd|api[_-]?key|private[_-]?key)/i },
]

/** Anything longer than this is not an identifier, whatever it claims to be. */
const MAX_REF_LENGTH = 200

export function isProviderSafe(value: string): { safe: true } | { safe: false; why: string } {
  const v = value.trim()
  if (v.length > MAX_REF_LENGTH) return { safe: false, why: `longer than ${MAX_REF_LENGTH} chars` }
  for (const shape of SECRET_SHAPES) {
    if (shape.test.test(v)) return { safe: false, why: shape.why }
  }
  return { safe: true }
}

export interface ChannelRequestInput {
  tenantId: string
  purpose: string
  requestedType: string
  classification: string
  requestedBy: string
  clawithAgentRef?: string | null
  chatwootTeamRef?: string | null
  /** JSON text. Opaque here — operating hours, escalation windows. */
  operatingPolicy?: string | null
  /** Defaults TRUE. A channel requires approval unless someone deliberately says otherwise. */
  approvalRequired?: boolean
}

export interface ChannelRequestRecord {
  tenant_id: string
  purpose: string
  requested_type: ChannelType
  classification: ChannelClassification
  requested_by: string
  clawith_agent_ref: string | null
  chatwoot_team_ref: string | null
  operating_policy: string | null
  approval_required: boolean
  provisioning_status: ProvisioningStatus
  readiness: string
  health: string
}

/**
 * Validate and shape a channel request. Pure: returns the row to write, or a
 * named refusal. The caller persists it — this module does not own the
 * transaction, so it can be reused inside one.
 */
export function buildChannelRequest(
  input: ChannelRequestInput,
): ChannelBindingResult<ChannelRequestRecord> {
  const tenantId = (input.tenantId ?? '').trim()
  if (!tenantId) return { ok: false, refusal: 'no_tenant', detail: 'tenantId is required' }

  const purpose = (input.purpose ?? '').trim()
  if (!purpose) return { ok: false, refusal: 'no_purpose', detail: 'purpose is required' }

  const requestedBy = (input.requestedBy ?? '').trim()
  if (!requestedBy) {
    return { ok: false, refusal: 'no_requested_by', detail: 'requestedBy is required' }
  }

  const requestedType = (input.requestedType ?? '').trim()
  if (!(CHANNEL_TYPES as readonly string[]).includes(requestedType)) {
    return { ok: false, refusal: 'unknown_type', detail: `unknown channel type: ${requestedType}` }
  }

  const classification = (input.classification ?? '').trim()
  if (!(CHANNEL_CLASSIFICATIONS as readonly string[]).includes(classification)) {
    return {
      ok: false,
      refusal: 'unknown_classification',
      detail: `classification must be one of ${CHANNEL_CLASSIFICATIONS.join(' | ')}`,
    }
  }

  for (const [field, value] of [
    ['clawithAgentRef', input.clawithAgentRef],
    ['chatwootTeamRef', input.chatwootTeamRef],
  ] as const) {
    if (typeof value === 'string' && value.trim()) {
      const check = isProviderSafe(value)
      if (!check.safe) {
        return {
          ok: false,
          refusal: 'secret_shaped_value',
          detail: `${field} looks like a credential (${check.why}) and was refused`,
        }
      }
    }
  }

  return {
    ok: true,
    value: {
      tenant_id: tenantId,
      purpose,
      requested_type: requestedType as ChannelType,
      classification: classification as ChannelClassification,
      requested_by: requestedBy,
      clawith_agent_ref: input.clawithAgentRef?.trim() || null,
      chatwoot_team_ref: input.chatwootTeamRef?.trim() || null,
      operating_policy: input.operatingPolicy ?? null,
      approval_required: input.approvalRequired ?? true,
      provisioning_status: 'requested',
      readiness: 'not_ready',
      health: 'unknown',
    },
  }
}

export interface Lane2ResultInput {
  /** What Foundation already recorded. Used to prove classification did not move. */
  existingClassification: string
  status: string
  providerRef?: string | null
  inboxRef?: string | null
  agentRef?: string | null
  contractVersion?: string | null
  evidenceRef?: string | null
  readiness?: string | null
  health?: string | null
  chatwootDeepLink?: string | null
  clawithDeepLink?: string | null
  /** If Lane 2 echoes a classification it MUST match. It never gets to change ours. */
  echoedClassification?: string | null
  verifiedAt?: Date | null
}

export interface Lane2ResultRecord {
  provisioning_status: ProvisioningStatus
  provider_ref: string | null
  inbox_ref: string | null
  agent_ref: string | null
  lane2_contract_version: string | null
  lane2_evidence_ref: string | null
  readiness: string
  health: string
  chatwoot_deep_link: string | null
  clawith_deep_link: string | null
  last_verified_at: Date | null
}

/**
 * Shape what Lane 2 reported. Refuses credentials, and refuses to let Lane 2
 * reclassify a channel: customer-facing vs internal is a business decision made
 * in Foundation by a human, and a provisioning reply is not a place to change it.
 */
export function buildLane2Result(
  input: Lane2ResultInput,
): ChannelBindingResult<Lane2ResultRecord> {
  const status = (input.status ?? '').trim()
  if (!(PROVISIONING_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, refusal: 'unknown_status', detail: `unknown status: ${status}` }
  }

  if (
    typeof input.echoedClassification === 'string' &&
    input.echoedClassification.trim() &&
    input.echoedClassification.trim() !== input.existingClassification
  ) {
    return {
      ok: false,
      refusal: 'classification_immutable',
      detail:
        `Lane 2 echoed classification ${input.echoedClassification.trim()} but Foundation ` +
        `recorded ${input.existingClassification}; classification is Foundation's to set`,
    }
  }

  const refFields = [
    ['providerRef', input.providerRef],
    ['inboxRef', input.inboxRef],
    ['agentRef', input.agentRef],
    ['contractVersion', input.contractVersion],
    ['evidenceRef', input.evidenceRef],
    ['chatwootDeepLink', input.chatwootDeepLink],
    ['clawithDeepLink', input.clawithDeepLink],
  ] as const

  for (const [field, value] of refFields) {
    if (typeof value === 'string' && value.trim()) {
      const check = isProviderSafe(value)
      if (!check.safe) {
        return {
          ok: false,
          refusal: 'secret_shaped_value',
          detail: `${field} looks like a credential (${check.why}) and was refused`,
        }
      }
    }
  }

  return {
    ok: true,
    value: {
      provisioning_status: status as ProvisioningStatus,
      provider_ref: input.providerRef?.trim() || null,
      inbox_ref: input.inboxRef?.trim() || null,
      agent_ref: input.agentRef?.trim() || null,
      lane2_contract_version: input.contractVersion?.trim() || null,
      lane2_evidence_ref: input.evidenceRef?.trim() || null,
      readiness: input.readiness?.trim() || 'not_ready',
      health: input.health?.trim() || 'unknown',
      chatwoot_deep_link: input.chatwootDeepLink?.trim() || null,
      clawith_deep_link: input.clawithDeepLink?.trim() || null,
      last_verified_at: input.verifiedAt ?? null,
    },
  }
}
