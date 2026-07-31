import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ResolvedQuery } from '../feed'
import {
  createApprovalRequestSource,
  projectApprovalRequest,
  type ApprovalRequestRow,
} from './approval-request'
import { createAuditLogSource, projectAuditLog, type AuditLogRow } from './audit-log'
import {
  createOwnershipSource,
  normaliseState,
  projectOwnershipTransition,
  type OwnershipTransitionRow,
} from './conversation-ownership'
import { SourceForbidden, isSecretShaped, pickSafe, safeFailure } from './shared'
import {
  classifyWorkOutcome,
  createStaffWorkActionSource,
  projectStaffWorkAction,
  type StaffWorkActionRow,
} from './staff-work-action'

const NOW = new Date('2026-07-31T18:00:00Z')
const COMPANY = 'tenant-1'

const query: ResolvedQuery = {
  companyId: COMPANY,
  pageSize: 25,
  cursor: null,
  permittedCompanies: [COMPANY],
}

// ── the rule every adapter shares ───────────────────────────────────────

describe('a query that fails is never an empty day', () => {
  const sources = {
    audit: (list: () => Promise<never>) => createAuditLogSource({ list, now: () => NOW }),
    approval: (list: () => Promise<never>) =>
      createApprovalRequestSource({ list, now: () => NOW }),
    staffWork: (list: () => Promise<never>) =>
      createStaffWorkActionSource({ list, now: () => NOW }),
    ownership: (list: () => Promise<never>) => createOwnershipSource({ list, now: () => NOW }),
  }

  it.each(Object.keys(sources) as (keyof typeof sources)[])(
    '%s: a thrown query is unavailable',
    async (key) => {
      const source = sources[key](async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.1:5432')
      })
      const r = await source.read(query)
      expect(r.status).toBe('unavailable')
      if (r.status !== 'unavailable') return
      // The operator learns it could not be reached, not the database address.
      expect(r.reason).toBe('the source could not be reached')
      expect(r.reason).not.toContain('10.0.0.1')
    },
  )

  it.each(Object.keys(sources) as (keyof typeof sources)[])(
    '%s: a refused read is forbidden, not empty',
    async (key) => {
      const source = sources[key](async () => {
        throw new SourceForbidden()
      })
      expect((await source.read(query)).status).toBe('forbidden')
    },
  )

  it('one malformed row does not take the whole source down', async () => {
    const good = auditRow({ id: 'a1' })
    const source = createAuditLogSource({
      list: async () => [good, null as unknown as AuditLogRow],
      now: () => NOW,
    })
    const r = await source.read(query)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.items).toHaveLength(1)
  })

  it('reports stale when the read is known to be old', async () => {
    const source = createAuditLogSource({
      list: async () => [auditRow({})],
      now: () => NOW,
      staleReason: () => 'serving the last good read',
    })
    const r = await source.read(query)
    expect(r.status).toBe('stale')
  })

  it('marks fixture data as fixture', async () => {
    const source = createAuditLogSource({
      list: async () => [auditRow({})],
      now: () => NOW,
      mode: 'fixture',
    })
    const r = await source.read(query)
    expect(r.status === 'ok' && r.mode).toBe('fixture')
  })
})

// ── AuditLog ───────────────────────────────────────────────────────

function auditRow(over: Partial<AuditLogRow>): AuditLogRow {
  return {
    id: 'aud-1',
    tenant_id: COMPANY,
    actor_id: 'user-7',
    action: 'governed.action',
    entity: 'res.partner',
    entity_id: '42',
    request_id: 'req-1',
    meta: { outcome: 'EXECUTED', actionType: 'note.create', correlationId: 'corr-1' },
    created_at: new Date('2026-07-31T17:50:00Z'),
    ...over,
  }
}

describe('AuditLog projection', () => {
  it.each([
    ['EXECUTED', 'governed.action.completed'],
    ['IDEMPOTENT_REPLAY', 'governed.action.completed'],
    ['READBACK_FAILED', 'governed.action.failed'],
    ['DEPENDENCY_UNAVAILABLE', 'governed.action.failed'],
    ['EXECUTION_FAILED', 'governed.action.failed'],
    ['PERMISSION_DENIED', 'governed.action.failed'],
    ['VALIDATION_FAILED', 'governed.action.failed'],
    ['APPROVAL_REQUIRED', 'approval.requested'],
    ['APPROVAL_REJECTED', 'approval.rejected'],
  ])('%s becomes %s and keeps its own status', (outcome, eventType) => {
    const item = projectAuditLog(auditRow({ meta: { outcome, actionType: 'note.create' } }))
    expect(item?.eventType).toBe(eventType)
    expect(item?.status).toBe(outcome)
  })

  it('never calls a failed readback a completion', () => {
    const item = projectAuditLog(auditRow({ meta: { outcome: 'READBACK_FAILED' } }))
    expect(item?.eventType).toBe('governed.action.failed')
    expect(item?.title).toMatch(/NOT verified/)
  })

  it('an unrecognised action is a plain audit event, not a governed outcome', () => {
    const item = projectAuditLog(auditRow({ action: 'wallet.topup', meta: {} }))
    expect(item?.eventType).toBe('audit.event')
    expect(item?.status).toBe('recorded')
  })

  it('drops a row with no tenant rather than showing it to everyone', () => {
    expect(projectAuditLog(auditRow({ tenant_id: null }))).toBeNull()
  })

  it('does not project raw arguments, tokens or stack traces from meta', () => {
    const item = projectAuditLog(
      auditRow({
        meta: {
          outcome: 'EXECUTED',
          actionType: 'note.create',
          authorisedArguments: { body: 'private customer note' },
          accessToken: 'EAAG1234567890abcdefghijklmnop',
          stack: 'Error: boom\n  at thing (file.ts:1:1)',
        },
      }),
    )
    const serialised = JSON.stringify(item)
    expect(serialised).not.toContain('private customer note')
    expect(serialised).not.toContain('EAAG1234567890')
    expect(serialised).not.toContain('at thing')
  })
})

describe('pickSafe', () => {
  it('copies only the named keys', () => {
    expect(pickSafe({ a: '1', b: '2' }, ['a'])).toEqual({ a: '1' })
  })

  it('drops anything shaped like a credential even when it was asked for', () => {
    expect(pickSafe({ a: 'EAAG1234567890abcdefghijklmnop' }, ['a'])).toEqual({})
    expect(isSecretShaped('ghp_abcdefghijklmnopqrstuvwxyz')).toBe(true)
    expect(isSecretShaped('note.create')).toBe(false)
  })

  it('drops nested objects rather than flattening something unreviewed', () => {
    expect(pickSafe({ a: { nested: true } }, ['a'])).toEqual({})
  })
})

describe('safeFailure', () => {
  it.each([
    ['connect ETIMEDOUT', 'the source did not answer in time'],
    ['connect ECONNREFUSED 127.0.0.1:5432', 'the source could not be reached'],
    ['permission denied for table audit_log', 'the source refused the read'],
    ['something odd', 'the source failed to answer'],
  ])('%s reads as %s', (raw, expected) => {
    expect(safeFailure(new Error(raw))).toBe(expected)
  })
})

// ── ApprovalRequest ────────────────────────────────────────────────

function approvalRow(over: Partial<ApprovalRequestRow>): ApprovalRequestRow {
  return {
    id: 'apr-1',
    tenant_id: COMPANY,
    action: 'voice.route.set',
    target_entity: 'voice_line',
    target_id: 'line-9',
    status: 'pending',
    requested_by: 'user-7',
    decided_by: null,
    decided_at: null,
    consumed_at: null,
    expires_at: new Date('2026-08-01T00:00:00Z'),
    created_at: new Date('2026-07-31T17:00:00Z'),
    ...over,
  }
}

describe('ApprovalRequest projection', () => {
  it.each([
    ['pending', 'approval.requested', 'pending'],
    ['approved', 'approval.approved', 'approved'],
    ['consumed', 'approval.approved', 'consumed'],
    ['denied', 'approval.rejected', 'denied'],
    ['expired', 'approval.rejected', 'expired'],
  ])('%s becomes %s / %s', (status, eventType, expected) => {
    const item = projectApprovalRequest(approvalRow({ status }), NOW)
    expect(item.eventType).toBe(eventType)
    expect(item.status).toBe(expected)
  })

  it('a pending request past its deadline is expired, not still waiting', () => {
    const item = projectApprovalRequest(
      approvalRow({ status: 'pending', expires_at: new Date('2026-07-31T10:00:00Z') }),
      NOW,
    )
    expect(item.status).toBe('expired')
    expect(item.eventType).toBe('approval.rejected')
  })

  it('the event happens when the DECISION happened', () => {
    const item = projectApprovalRequest(
      approvalRow({ status: 'approved', decided_at: new Date('2026-07-31T17:45:00Z') }),
      NOW,
    )
    expect(item.occurredAt).toBe('2026-07-31T17:45:00.000Z')
    expect(item.receivedAt).toBe('2026-07-31T17:00:00.000Z')
  })

  it('never projects the approved parameters or the redemption token', () => {
    const row = approvalRow({}) as ApprovalRequestRow & { payload: unknown; token: string }
    row.payload = { did: '+17671234567', forwardNumber: '+17679876543' }
    row.token = 'secret-redemption-token'

    const serialised = JSON.stringify(projectApprovalRequest(row, NOW))
    expect(serialised).not.toContain('7671234567')
    expect(serialised).not.toContain('7679876543')
    expect(serialised).not.toContain('secret-redemption-token')
  })
})

// ── StaffWorkAction ────────────────────────────────────────────────

function workRow(over: Partial<StaffWorkActionRow>): StaffWorkActionRow {
  return {
    id: 'swa-1',
    tenant_id: COMPANY,
    staff_binding_id: 'bind-1',
    work_ref_model: 'project.task',
    work_ref_id: 2590,
    correlation_id: 'corr-1',
    action: 'done',
    note: 'Replaced the handset',
    source: 'whatsapp',
    applied_at: new Date('2026-07-31T17:51:00Z'),
    odoo_result: null,
    failure_reason: null,
    created_at: new Date('2026-07-31T17:50:00Z'),
    ...over,
  }
}

describe('StaffWorkAction outcomes stay four different things', () => {
  it.each([
    ['applied', { applied_at: new Date(), failure_reason: null }, 'completed_verified'],
    [
      'timeout',
      { applied_at: null, failure_reason: 'odoo timed out after 15s' },
      'dependency_unavailable',
    ],
    [
      'unreachable',
      { applied_at: null, failure_reason: 'connect ECONNREFUSED' },
      'dependency_unavailable',
    ],
    [
      'readback',
      { applied_at: null, failure_reason: 'readback returned nothing' },
      'readback_failed',
    ],
    [
      'refused',
      { applied_at: null, failure_reason: 'odoo rejected the write: field is read-only' },
      'execution_failed',
    ],
    ['nothing yet', { applied_at: null, failure_reason: null }, 'in_progress'],
  ])('%s classifies as %s', (_label, row, expected) => {
    expect(classifyWorkOutcome(row)).toBe(expected)
  })

  it('an unapplied row is never titled as done', () => {
    const item = projectStaffWorkAction(
      workRow({ applied_at: null, failure_reason: 'readback returned nothing' }),
    )
    expect(item.status).toBe('readback_failed')
    expect(item.title).toMatch(/NOT confirmed/)
    expect(item.title).not.toMatch(/^Done/)
  })

  it('a verified row says so', () => {
    const item = projectStaffWorkAction(workRow({}))
    expect(item.status).toBe('completed_verified')
    expect(item.title).toBe('Done and confirmed')
  })

  it('offers an Odoo link only when there is a base URL to build one from', () => {
    expect(projectStaffWorkAction(workRow({})).nativeLinks).toHaveLength(0)
    const linked = projectStaffWorkAction(workRow({}), 'https://odoo.example/')
    expect(linked.nativeLinks[0].href).toBe('https://odoo.example/odoo/project.task/2590')
  })

  it('identifies the actor by binding, never by handset', () => {
    const item = projectStaffWorkAction(workRow({}))
    expect(item.actor.ref).toBe('staff:bind-1')
    expect(JSON.stringify(item)).not.toMatch(/\+?1?767\d{7}/)
  })
})

// ── ownership ─────────────────────────────────────────────────────

function ownershipRow(over: Partial<OwnershipTransitionRow>): OwnershipTransitionRow {
  return {
    id: 'own-1',
    tenant_id: COMPANY,
    conversation_id: 'conv-1',
    episode: 1,
    from_state: 'ai',
    to_state: 'human',
    reason: 'customer asked for a person',
    operation_id: 'op-x',
    operation_kind: 'escalate_to_human',
    actor_ref: 'user:7',
    correlation_id: 'corr-1',
    created_at: new Date('2026-07-31T17:40:00Z'),
    ...over,
  }
}

describe('ownership transitions are reported, never performed', () => {
  it.each([
    ['human', 'ownership.human_takeover', 'human'],
    ['handoff_requested', 'ownership.human_takeover', 'unknown'],
    ['handback_ready', 'ownership.handback', 'human'],
    ['ai_resumed', 'ownership.handback', 'ai'],
    ['ai', 'ownership.handback', 'ai'],
  ])('to_state %s becomes %s with ownership %s', (to, eventType, ownership) => {
    const item = projectOwnershipTransition(ownershipRow({ to_state: to }))
    expect(item.eventType).toBe(eventType)
    expect(item.ownershipState).toBe(ownership)
  })

  it('an unrecognised state is UNKNOWN, never assumed to be the AI', () => {
    const item = projectOwnershipTransition(ownershipRow({ to_state: 'something_new' }))
    expect(normaliseState('something_new')).toBe('unknown')
    expect(item.ownershipState).toBe('unknown')
    expect(item.status).toBe('unknown')
  })

  it('a human reply is a reply, whatever the state says', () => {
    const item = projectOwnershipTransition(
      ownershipRow({ operation_kind: 'dashboard_reply', to_state: 'human' }),
    )
    expect(item.eventType).toBe('ownership.human_reply')
  })

  it('carries the reason, not the message', () => {
    const item = projectOwnershipTransition(ownershipRow({}))
    expect(item.summary).toContain('customer asked for a person')
  })

  it('offers a Chatwoot link only when a base URL is configured', () => {
    expect(projectOwnershipTransition(ownershipRow({})).nativeLinks).toHaveLength(0)
    const linked = projectOwnershipTransition(ownershipRow({}), 'https://chat.example')
    expect(linked.nativeLinks[0].href).toBe('https://chat.example/app/conversations/conv-1')
  })

  it('contains no call that could change who is answering the customer', () => {
    const src = readFileSync(join(__dirname, 'conversation-ownership.ts'), 'utf8')
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/'[^']*'/g, "''")
      .replace(/"[^"]*"/g, '""')
    expect(code).not.toMatch(
      /\b(takeOver|takeover|forceHandback|handback|resumeAi|assignTeam|assign|sendMessage|reply)\s*\(/,
    )
    expect(code).not.toMatch(/\bfetch\s*\(/)
    expect(code).not.toMatch(/\bprisma\./)
  })
})
