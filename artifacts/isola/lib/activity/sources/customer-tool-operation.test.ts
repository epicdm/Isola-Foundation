/**
 * customer_tool_operation -- the sixth activity source, tested at its own
 * seam.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM sources.test.ts
 * -----------------------------------------------------
 * `sources.test.ts` is the shared file for AuditLog, ApprovalRequest,
 * StaffWorkAction and conversation-ownership -- adapters thin enough that one
 * file covers all four without strain. `customer-tool-operation.ts` names this
 * exact filename in its own header comment ("customer-tool-operation.test.ts
 * asserts the two agree on a spread of inputs"), and `lane2-events.ts` already
 * has its own `lane2-events.test.ts` for the same reason: an adapter with this
 * much of its own logic -- a authoritative-by-construction id rule, a lifecycle
 * total over fourteen states, a shared-ledger identity -- earns its own file
 * rather than diluting the shared one.
 *
 * WHAT THIS FILE IS NOT RE-PROVING
 * ---------------------------------
 * `registry.test.ts` already proves: the registry has six sources, this one is
 * tenant-scoped on `claimed_at`/`operation_id`, it is excluded from a query that
 * asks only for other sources, and it issues no query for a cursor at another
 * source's instant. `feed-controller.test.ts`, `route.test.ts` and
 * `recent-work-view.test.tsx` already prove the whole system now expects six
 * sources, not five. None of that is repeated here.
 *
 * What IS this adapter's own responsibility, and therefore what this file
 * covers: the id rule, the lifecycle mapping, the shared-ledger reference, and
 * what a row is and is not allowed to say.
 */

import { describe, expect, it } from 'vitest'

import { LIFECYCLE_PRESENTATION } from '@/lib/customer-workspace/contract'
import { LEDGER_VERSION, type OperationEnvelope } from '@/lib/operations/ledger'

import type { ResolvedQuery } from '../feed'
import {
  CUSTOMER_TOOL_OPERATION_PREFIX,
  CUSTOMER_TOOL_OPERATION_SOURCE,
  createCustomerToolOperationSource,
  customerIdFromEnvelope,
  projectCustomerToolOperation,
  type CustomerToolOperationDeps,
  type CustomerToolOperationRow,
} from './customer-tool-operation'
import { SourceForbidden } from './shared'
import { STAFF_WORK_SOURCE } from './staff-work-action'

const NOW = new Date('2026-08-01T12:00:00Z')
const TENANT = 'tenant-1'
const OTHER_TENANT = 'tenant-2'

function envelope(over: Partial<OperationEnvelope> = {}): OperationEnvelope {
  return {
    version: LEDGER_VERSION,
    callerClass: 'foundation_staff',
    companyId: TENANT,
    actionType: 'customer.note.create',
    objectType: 'customer',
    objectId: '42',
    actorRef: 'staff:agent-7',
    auditRef: null,
    readback: null,
    result: null,
    ...over,
  }
}

function row(over: Partial<CustomerToolOperationRow> = {}): CustomerToolOperationRow {
  return {
    id: 'row-1',
    tenant_id: TENANT,
    operation_id: 'op_abc123',
    tool_name: 'foundation_staff:customer.note.create',
    request_hash: 'hash-1',
    conversation_id: '',
    correlation_id: 'corr-1',
    agent_session_id: 'staff:agent-7',
    // The real schema names the completed state "succeeded", not "completed" --
    // see ledger.ts's DB_STATE map. fromDbState() reads either, but the fixture
    // should look like the row Prisma would actually hand back.
    state: 'succeeded',
    result_model: null,
    result_id: null,
    result: envelope(),
    claimed_at: new Date('2026-08-01T11:00:00Z'),
    completed_at: new Date('2026-08-01T11:00:05Z'),
    failure_code: null,
    failure_detail: null,
    ...over,
  }
}

const query: ResolvedQuery = {
  companyId: TENANT,
  pageSize: 25,
  cursor: null,
  permittedCompanies: [TENANT],
}

const deps = (
  rows: CustomerToolOperationRow[] | (() => Promise<never>),
): CustomerToolOperationDeps => ({
  list: typeof rows === 'function' ? rows : async () => rows,
  now: () => NOW,
})

// ── identity ─────────────────────────────────────────────────────────────

describe('identity: registered as its own source, never as a second StaffWorkAction', () => {
  it('the canonical name is customer_tool_operation', () => {
    expect(CUSTOMER_TOOL_OPERATION_SOURCE).toBe('customer_tool_operation')
  })

  it('REGRESSION: the prefix is customerop, distinct from staff_work_action\'s "staffwork"', () => {
    expect(CUSTOMER_TOOL_OPERATION_PREFIX).toBe('customerop')
    expect(CUSTOMER_TOOL_OPERATION_PREFIX).not.toBe('staffwork')
    expect(CUSTOMER_TOOL_OPERATION_SOURCE).not.toBe(STAFF_WORK_SOURCE)
  })
})

// ── customerIdFromEnvelope: authoritative by construction ──────────────────

describe('customerIdFromEnvelope: proven by the envelope, never inferred', () => {
  it('returns the id from a proven customer envelope', () => {
    expect(customerIdFromEnvelope(envelope({ objectType: 'customer', objectId: '42' }))).toBe('42')
  })

  it('returns null for any object type that is not "customer"', () => {
    expect(customerIdFromEnvelope(envelope({ objectType: 'lead', objectId: '42' }))).toBeNull()
    expect(
      customerIdFromEnvelope(envelope({ objectType: 'conversation', objectId: '42' })),
    ).toBeNull()
    expect(customerIdFromEnvelope(envelope({ objectType: '', objectId: '42' }))).toBeNull()
  })

  it('returns null for an absent envelope, e.g. a row written before it existed', () => {
    expect(customerIdFromEnvelope(null)).toBeNull()
  })

  it.each([
    ['', 'empty'],
    ['0', 'zero -- Odoo partner ids start at 1'],
    ['abc', 'non-numeric'],
    ['12a', 'trailing letters'],
    ['-5', 'negative'],
    ['00042', 'a leading zero'],
    ['1'.repeat(19), 'longer than a real partner id can be'],
  ])('REGRESSION: malformed id %j (%s) never becomes a customerId', (objectId) => {
    expect(customerIdFromEnvelope(envelope({ objectType: 'customer', objectId }))).toBeNull()
  })

  it('a non-string objectId (a row shaped by something other than this code) is also null, not thrown', () => {
    const malformed = envelope({ objectType: 'customer', objectId: 42 as unknown as string })
    expect(customerIdFromEnvelope(malformed)).toBeNull()
  })

  it('trims surrounding whitespace before checking the shape', () => {
    expect(customerIdFromEnvelope(envelope({ objectType: 'customer', objectId: ' 42 ' }))).toBe(
      '42',
    )
  })
})

// ── lifecycle: EVENT_FOR is total, and this proves what it is total OVER ───

describe('lifecycle is preserved exactly -- LIFECYCLE_PRESENTATION decides the words, this file only proves they arrive', () => {
  it('a claimed row is executing, not a guess at done or failed', () => {
    const item = projectCustomerToolOperation(
      row({ state: 'claimed', completed_at: null, failure_code: null, failure_detail: null }),
    )
    expect(item?.status).toBe('executing')
    expect(item?.eventType).toBe('governed.action.started')
    expect(item?.title).toBe(LIFECYCLE_PRESENTATION.executing.label)
  })

  it.each([
    ['VALIDATION_FAILED', 'validation_failed', 'governed.action.failed', 'Nothing was written'],
    [
      'PERMISSION_DENIED',
      'permission_denied',
      'governed.action.failed',
      'Nothing was sent and nothing was written',
    ],
    ['APPROVAL_REQUIRED', 'approval_required', 'approval.requested', 'Nothing has been written'],
    ['APPROVAL_REJECTED', 'approval_rejected', 'approval.rejected', 'Nothing was written'],
    [
      'DEPENDENCY_UNAVAILABLE',
      'dependency_unavailable',
      'governed.action.failed',
      'Nothing was written',
    ],
    ['EXECUTION_FAILED', 'execution_failed', 'governed.action.failed', 'Nothing was written'],
    [
      'EXECUTOR_UNAVAILABLE',
      'executor_unavailable',
      'governed.action.failed',
      'nothing was performed',
    ],
    ['READBACK_FAILED', 'readback_failed', 'governed.readback', 'not confirmed'],
  ] as const)(
    'a failed row with failure_code %s becomes lifecycle %s (%s), and the sentence says "%s"',
    (code, lifecycle, eventType, sentenceFragment) => {
      const item = projectCustomerToolOperation(
        row({
          state: 'failed',
          completed_at: new Date('2026-08-01T11:00:05Z'),
          failure_code: code,
          failure_detail: 'a driver detail that must never reach the screen',
        }),
      )
      expect(item?.status).toBe(lifecycle)
      expect(item?.eventType).toBe(eventType)
      expect(item?.title).toBe(LIFECYCLE_PRESENTATION[lifecycle].label)
      expect(item?.summary.toLowerCase()).toContain(sentenceFragment.toLowerCase())
    },
  )

  it('an unrecognised failure_code lands on execution_failed rather than a default success', () => {
    const item = projectCustomerToolOperation(row({ state: 'failed', failure_code: 'SOMETHING_NEW' }))
    expect(item?.status).toBe('execution_failed')
  })
})

describe('a completed row is success ONLY when the envelope proves it -- the rule this source exists to carry forward', () => {
  it('REGRESSION: a null readback is readback_failed, never completed_verified', () => {
    const item = projectCustomerToolOperation(row({ state: 'succeeded', result: envelope({ readback: null }) }))
    expect(item?.status).toBe('readback_failed')
    expect(item?.status).not.toBe('completed_verified')
    expect(item?.eventType).toBe('governed.readback')
    expect(item?.title).toBe('Written but not confirmed')
    expect(LIFECYCLE_PRESENTATION.readback_failed.success).toBe(false)
  })

  it('a present readback is completed_verified', () => {
    const item = projectCustomerToolOperation(
      row({ state: 'succeeded', result: envelope({ readback: { id: 42, confirmed: true } }) }),
    )
    expect(item?.status).toBe('completed_verified')
    expect(item?.eventType).toBe('governed.action.completed')
    expect(item?.title).toBe('Done and confirmed')
    expect(LIFECYCLE_PRESENTATION.completed_verified.success).toBe(true)
  })
})

// ── the shared ledger, not a second one ─────────────────────────────────────

describe('the shared ledger is reused, not re-derived', () => {
  it('the activity id is customerop:<operation_id>', () => {
    const item = projectCustomerToolOperation(row({ operation_id: 'op_deadbeef' }))
    expect(item?.activityId).toBe('customerop:op_deadbeef')
  })

  it('provenance.upstreamRef is the same operationId Customer 360\'s recentActions section reads', () => {
    const item = projectCustomerToolOperation(row({ operation_id: 'op_deadbeef' }))
    expect(item?.provenance.upstreamRef).toBe('op_deadbeef')
    expect(item?.provenance.source).toBe(CUSTOMER_TOOL_OPERATION_SOURCE)
    expect(item?.provenance.trust).toBe('authoritative')
  })

  it('the same row always derives the same activity id -- a stable reference, not a fresh one per read', () => {
    const r = row({ operation_id: 'op_stable' })
    expect(projectCustomerToolOperation(r)?.activityId).toBe(
      projectCustomerToolOperation(r)?.activityId,
    )
  })

  it('two distinct operations never collide on activityId', () => {
    const a = projectCustomerToolOperation(row({ operation_id: 'op_a' }))
    const b = projectCustomerToolOperation(row({ operation_id: 'op_b' }))
    expect(a?.activityId).not.toBe(b?.activityId)
  })
})

// ── the tenant on the ROW scopes the item, never anything inside the envelope ─

describe('scope comes from the ledger row, not from inside the envelope', () => {
  it('companyId is the row\'s tenant_id, even if the envelope disagrees', () => {
    const item = projectCustomerToolOperation(
      row({ tenant_id: TENANT, result: envelope({ companyId: OTHER_TENANT }) }),
    )
    expect(item?.companyId).toBe(TENANT)
  })
})

// ── what a row is allowed to say ────────────────────────────────────────────

describe('what a row is allowed to say', () => {
  it('never carries the envelope readback payload', () => {
    const item = projectCustomerToolOperation(
      row({
        state: 'succeeded',
        result: envelope({
          readback: { creditCardNumber: '4111 1111 1111 1111', note: 'do not print this' },
        }),
      }),
    )
    const serialised = JSON.stringify(item)
    expect(serialised).not.toContain('4111')
    expect(serialised).not.toContain('do not print this')
  })

  it('never carries the envelope result payload', () => {
    const item = projectCustomerToolOperation(
      row({ result: envelope({ result: { apiKey: 'sk-abcdef0123456789abcdef' } }) }),
    )
    expect(JSON.stringify(item)).not.toContain('sk-abcdef0123456789abcdef')
  })

  it('never carries failure_detail driver text', () => {
    const item = projectCustomerToolOperation(
      row({
        state: 'failed',
        failure_code: 'EXECUTION_FAILED',
        failure_detail: 'ORA-00001: unique constraint (SYS.PK) violated at host 10.0.0.5',
      }),
    )
    const serialised = JSON.stringify(item)
    expect(serialised).not.toContain('ORA-00001')
    expect(serialised).not.toContain('10.0.0.5')
  })

  it('customerLabel is always null -- never a name looked up from anywhere', () => {
    expect(projectCustomerToolOperation(row())?.customerLabel).toBeNull()
  })

  it('offers no native link -- the authoritative record lives in the customer workspace, not here', () => {
    expect(projectCustomerToolOperation(row())?.nativeLinks).toEqual([])
  })
})

// ── customerId end-to-end, never fabricated from row text ──────────────────

describe('customerId on the item is exactly what customerIdFromEnvelope decided, never guessed from the row', () => {
  it('a proven customer envelope produces the customerId', () => {
    const item = projectCustomerToolOperation(row({ result: envelope({ objectType: 'customer', objectId: '1' }) }))
    expect(item?.customerId).toBe('1')
  })

  it('an unrelated objectType produces no customerId, however customer-shaped the surrounding text looks', () => {
    const item = projectCustomerToolOperation(
      row({
        tool_name: 'note about customer 1 (Maria, +1-767-555-0100)',
        result: envelope({ objectType: 'lead', objectId: '1' }),
      }),
    )
    expect(item?.customerId).toBeNull()
  })

  it('a legacy row with no envelope produces no customerId', () => {
    const item = projectCustomerToolOperation(row({ result: { legacy: true } }))
    expect(item?.customerId).toBeNull()
  })
})

// ── actor, action type and related object: documented fallback order ───────

describe('actor and action type fall through in the documented order', () => {
  it('prefers the envelope actorRef over the row column', () => {
    const item = projectCustomerToolOperation(
      row({ agent_session_id: 'staff:ignored', result: envelope({ actorRef: 'staff:real' }) }),
    )
    expect(item?.actor.ref).toBe('staff:real')
  })

  it('falls back to agent_session_id for a legacy row with no envelope', () => {
    const item = projectCustomerToolOperation(
      row({ agent_session_id: 'staff:agent-9', result: { legacy: true } }),
    )
    expect(item?.actor.ref).toBe('staff:agent-9')
  })

  it('falls back to "system" when neither the envelope nor the row names an actor', () => {
    const item = projectCustomerToolOperation(row({ agent_session_id: null, result: { legacy: true } }))
    expect(item?.actor.ref).toBe('system')
    expect(item?.actor.kind).toBe('system')
  })

  it('the action type prefers the envelope actionType over tool_name', () => {
    const item = projectCustomerToolOperation(
      row({ tool_name: 'ignored', result: envelope({ actionType: 'customer.note.create' }) }),
    )
    expect(item?.summary).toContain('Action: customer.note.create')
  })

  it('falls back to tool_name for a legacy row with no envelope', () => {
    const item = projectCustomerToolOperation(
      row({ tool_name: 'foundation_staff:legacy.tool', result: { legacy: true } }),
    )
    expect(item?.summary).toContain('Action: foundation_staff:legacy.tool')
  })
})

describe('the related object mirrors the envelope, never the row alone', () => {
  it('carries the envelope objectType and objectId, whatever they are', () => {
    const item = projectCustomerToolOperation(row({ result: envelope({ objectType: 'lead', objectId: '99' }) }))
    expect(item?.relatedObjectType).toBe('lead')
    expect(item?.relatedObjectId).toBe('99')
  })

  it('is null for a legacy row with no envelope', () => {
    const item = projectCustomerToolOperation(row({ result: { legacy: true } }))
    expect(item?.relatedObjectType).toBeNull()
    expect(item?.relatedObjectId).toBeNull()
  })
})

// ── source state: the two shared rules, applied to this adapter ────────────

describe('source state follows the two rules every database-backed adapter shares', () => {
  it('a list() that throws is unavailable, never an empty operation history', async () => {
    const source = createCustomerToolOperationSource(
      deps(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.9:5432')
      }),
    )
    const r = await source.read(query)
    expect(r.status).toBe('unavailable')
  })

  it('SourceForbidden is forbidden, not unavailable and not an empty list', async () => {
    const source = createCustomerToolOperationSource(
      deps(async () => {
        throw new SourceForbidden('governed operations are not available to this session')
      }),
    )
    const r = await source.read(query)
    expect(r.status).toBe('forbidden')
  })

  it('no matching rows is ok/empty, not unavailable', async () => {
    const r = await createCustomerToolOperationSource(deps([])).read(query)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.items).toHaveLength(0)
  })

  it('reports stale when told the read is old', async () => {
    const source = createCustomerToolOperationSource({
      ...deps([row()]),
      staleReason: () => 'last good read',
    })
    expect((await source.read(query)).status).toBe('stale')
  })

  it('marks fixture rows as fixture', async () => {
    const source = createCustomerToolOperationSource({ ...deps([row()]), mode: 'fixture' })
    const r = await source.read(query)
    expect(r.status === 'ok' && r.mode).toBe('fixture')
  })

  it('a real row round-trips end to end through the source, not just through the projector', async () => {
    const r = await createCustomerToolOperationSource(
      deps([row({ operation_id: 'op_roundtrip', result: envelope({ objectType: 'customer', objectId: '7' }) })]),
    ).read(query)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.items).toHaveLength(1)
    expect(r.items[0].activityId).toBe('customerop:op_roundtrip')
    expect(r.items[0].customerId).toBe('7')
    expect(r.items[0].sourceSystem).toBe(CUSTOMER_TOOL_OPERATION_SOURCE)
  })
})
