import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LIFECYCLE_PRESENTATION } from '@/lib/customer-workspace/contract'
import { createFakeLedgerStore, type FakeLedgerStore } from '@/lib/operations/fake-ledger-store'

import { DependencyUnavailable, WriteIndeterminate } from './action'
import { runCustomerAction, type CustomerActionRequest } from './customer-actions'
import { buildExecutors, type RecordSystem } from './executors'
import { GOVERNED_ACTION_CATALOGUE } from './executors/catalogue'
import { buildConversationExecutors, type ConversationSystem } from './executors/conversation'

/* ── a cooperative system of record ────────────────────────────────────────*/

type Mode = 'ok' | 'down' | 'refused' | 'silent' | 'wrong'

function recordSystem(mode: Mode = 'ok'): RecordSystem {
  const stored = new Map<string, Record<string, unknown>>()
  let seq = 0

  const write = (fields: Record<string, unknown>) => {
    if (mode === 'down') throw new DependencyUnavailable('odoo', 'connection reset by peer')
    if (mode === 'refused') throw new Error('odoo: access denied for user portal@10.0.0.9')
    const externalId = `ext-${++seq}`
    stored.set(externalId, fields)
    return { externalId }
  }

  const read = async (externalId: string) => {
    if (mode === 'silent') return null
    if (mode === 'wrong') return { unrelated: 'something else entirely' }
    return stored.get(externalId) ?? null
  }

  return {
    createNote: async (i) => write({ body: i.body }),
    readNote: read,
    createTask: async (i) => write({ title: i.title }),
    readTask: read,
    scheduleActivity: async (i) => write({ summary: i.summary }),
    readActivity: read,
    createLead: async (i) => write({ name: i.name }),
    readLead: read,
    updateLead: async (i) => write(i.fields),
    scheduleFollowup: async (i) => write({ note: i.note, user_id: i.ownerRef ? [Number(i.ownerRef), 'Fake User'] : false }),
    readFollowup: read,
    async resolveAssignableUser(assigneeRef) {
      const id = Number(assigneeRef)
      if (!Number.isFinite(id) || id <= 0) return null
      return { id: assigneeRef, name: 'Fake User' }
    },
  }
}

/**
 * The sending lane's counterpart. `ok` stores what was posted and reads it back
 * visible; the other modes mirror `recordSystem` so the shared lifecycle tests
 * exercise both lanes identically.
 */
function conversationSystem(mode: Mode = 'ok'): ConversationSystem {
  const stored = new Map<string, Record<string, unknown>>()
  let seq = 0
  return {
    postCustomerVisibleMessage: async ({ body }) => {
      if (mode === 'down') throw new DependencyUnavailable('chatwoot', 'connection reset by peer')
      if (mode === 'refused') throw new Error('chatwoot: 422 unprocessable')
      const externalId = `msg-${++seq}`
      stored.set(externalId, { id: externalId, content: body, private: false })
      return { externalId }
    },
    readMessage: async ({ externalId }) => {
      if (mode === 'silent') return null
      if (mode === 'wrong') return { id: externalId, content: 'not what was sent', private: false }
      return stored.get(externalId) ?? null
    },
  }
}

const SEND_BODY = 'Hi Patricia,\n\nHere are the details of your quotation S00001:\n\nTotal: USD 273.70'

const PAYLOADS: Readonly<Record<string, Record<string, unknown>>> = {
  'note.create': { body: 'called the customer back' },
  'task.create': { title: 'Chase the router swap' },
  'activity.schedule': { summary: 'Site visit', dueDate: '2026-09-01' },
  'lead.create': { name: 'Second line for the shop' },
  'lead.update': { stage: 'qualified' },
  'followup.schedule': { note: 'Check the line held', dueDate: '2026-09-02' },
  'document.send': {
    conversationId: 15,
    documentId: 1,
    documentKind: 'quotation',
    documentReference: 'S00001',
    body: SEND_BODY,
    // Bound to reviewed text; part of the authorised arguments the ledger hashes.
    previewFingerprint: 'b'.repeat(64),
  },
}

let ledger: FakeLedgerStore

beforeEach(() => {
  ledger = createFakeLedgerStore()
})

const request = (over: Partial<CustomerActionRequest> = {}): CustomerActionRequest => ({
  tenantId: 'tenant-1',
  companyId: 'tenant-1',
  customerId: '42',
  actionType: 'note.create',
  payload: { body: 'called the customer back' },
  actorPrincipalId: 'user-1',
  actorRole: 'manager',
  idempotencyKey: 'idem-1',
  correlationId: 'corr-1',
  ...over,
})

const ports = (mode: Mode = 'ok') => ({
  ledger,
  // BOTH lanes: the record-writing executors and the one sending executor. The
  // catalogue describes all of them, so a runtime that assembled only one lane
  // would report a declared action as unimplemented.
  executors: [
    ...buildExecutors(recordSystem(mode)),
    ...buildConversationExecutors(conversationSystem(mode)),
  ],
  now: () => new Date('2026-08-01T12:00:00Z'),
})

/* ── the duplicate a customer must never receive ───────────────────────────*/

/**
 * The mechanism that stops one customer being sent the same document twice.
 *
 * A POST that times out proves NOTHING: the message may be in the conversation.
 * The adapter reports that as WriteIndeterminate → READBACK_FAILED, and the
 * ledger must then refuse to re-execute on a repeat of the same idempotency key
 * — even though it happily reclaims a failed row for every other failure kind,
 * because those DO prove nothing was written.
 *
 * Until these tests existed the mechanism was asserted only by its own comment.
 */
describe('an unproven send is never re-executed', () => {
  /** Posts successfully, then never confirms — exactly a timed-out POST. */
  function indeterminateOnce(): { system: ConversationSystem; posts: () => number } {
    let posts = 0
    return {
      posts: () => posts,
      system: {
        postCustomerVisibleMessage: async () => {
          posts += 1
          throw new WriteIndeterminate('chatwoot', 'The operation was aborted due to timeout')
        },
        readMessage: async () => null,
      },
    }
  }

  it('refuses the retry, and the executor is NOT called a second time', async () => {
    const { system, posts } = indeterminateOnce()
    const p = {
      ledger,
      executors: buildConversationExecutors(system),
      now: () => new Date('2026-08-01T12:00:00Z'),
    }
    const req = request({
      actionType: 'document.send',
      payload: PAYLOADS['document.send'],
      idempotencyKey: 'dup-guard-1',
    })

    const first = await runCustomerAction(req, p)
    expect(first.lifecycle).toBe('readback_failed')
    expect(posts()).toBe(1)

    const second = await runCustomerAction(req, p)
    expect(second.lifecycle).toBe('readback_failed')
    // THE ASSERTION THAT MATTERS: the customer did not receive it twice.
    expect(posts()).toBe(1)
  })

  it('leaves the row FAILED, not stranded as claimed, so a third attempt behaves', async () => {
    // claimOperation reclaims BEFORE the refusal runs, nulling failure_code. If
    // the restoring write is skipped or throws, the row stays `claimed` and every
    // later attempt reads in_flight forever — for a message that is sitting in
    // the customer's conversation.
    const { system, posts } = indeterminateOnce()
    const p = {
      ledger,
      executors: buildConversationExecutors(system),
      now: () => new Date('2026-08-01T12:00:00Z'),
    }
    const req = request({
      actionType: 'document.send',
      payload: PAYLOADS['document.send'],
      idempotencyKey: 'dup-guard-2',
    })

    await runCustomerAction(req, p)
    await runCustomerAction(req, p)
    const third = await runCustomerAction(req, p)

    expect(third.lifecycle).toBe('readback_failed')
    expect(third.lifecycle).not.toBe('executing')
    expect(posts()).toBe(1)
  })

  it('preserves the ORIGINAL failure detail instead of overwriting it', async () => {
    // The first attempt's detail names what could not be proven. A generic
    // replacement would delete the only diagnostic after one extra click.
    const { system } = indeterminateOnce()
    const p = {
      ledger,
      executors: buildConversationExecutors(system),
      now: () => new Date('2026-08-01T12:00:00Z'),
    }
    const req = request({
      actionType: 'document.send',
      payload: PAYLOADS['document.send'],
      idempotencyKey: 'dup-guard-3',
    })

    await runCustomerAction(req, p)
    await runCustomerAction(req, p)

    const rows = ledger.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('failed')
    expect(rows[0].failureClass).toBe('READBACK_FAILED')
    expect(rows[0].failureDetail).toContain('aborted due to timeout')
  })

  it('CONTROL: a DEPENDENCY_UNAVAILABLE failure still retries — the refusal is specific', async () => {
    // Without this, all three assertions above would pass against a runtime that
    // had been broken to refuse every retry. A dependency that was never reached
    // proves nothing was written, so retrying is safe and expected.
    let posts = 0
    let down = true
    const system: ConversationSystem = {
      postCustomerVisibleMessage: async ({ body }) => {
        posts += 1
        if (down) throw new DependencyUnavailable('chatwoot', 'ECONNREFUSED')
        return { externalId: 'msg-1' }
      },
      readMessage: async () => ({ id: 'msg-1', content: SEND_BODY, private: false }),
    }
    const p = {
      ledger,
      executors: buildConversationExecutors(system),
      now: () => new Date('2026-08-01T12:00:00Z'),
    }
    const req = request({
      actionType: 'document.send',
      payload: PAYLOADS['document.send'],
      idempotencyKey: 'dup-guard-4',
    })

    const first = await runCustomerAction(req, p)
    expect(first.lifecycle).toBe('dependency_unavailable')

    down = false
    const second = await runCustomerAction(req, p)
    expect(second.lifecycle).toBe('completed_verified')
    expect(posts).toBe(2)
  })
})

/* ── all six are actually reachable ────────────────────────────────────────*/

describe('every declared action resolves to an executor and can complete', () => {
  it.each(GOVERNED_ACTION_CATALOGUE.filter((a) => !a.requiresApproval).map((a) => a.actionType))(
    '%s reaches a verified completion',
    async (actionType) => {
      const out = await runCustomerAction(
        request({ actionType, payload: PAYLOADS[actionType], idempotencyKey: `k-${actionType}` }),
        ports(),
      )

      expect(out.lifecycle).toBe('completed_verified')
      expect(out.presentation.success).toBe(true)
      expect(out.readbackProven).toBe(true)
      expect(out.operationId).toMatch(/^op_/)
    },
  )

  it('holds the approval-gated action instead of running it', async () => {
    const out = await runCustomerAction(
      request({ actionType: 'lead.update', payload: PAYLOADS['lead.update'] }),
      ports(),
    )

    expect(out.lifecycle).toBe('approval_required')
    expect(out.presentation.success).toBe(false)
    expect(out.approvalRef).toBeTruthy()
    // Nothing was written, and the sentence must say so.
    expect(out.detail).toContain('Nothing has been written')
  })
})

/* ── refusals that must not leave a trace ──────────────────────────────────*/

describe('an action that can never run does not enter the ledger', () => {
  it('refuses an unknown action type', async () => {
    const out = await runCustomerAction(request({ actionType: 'nonsense.explode' }), ports())

    expect(out.lifecycle).toBe('validation_failed')
    expect(out.operationId).toBeNull()
    expect(ledger.rows()).toHaveLength(0)
  })

  it('refuses note.add, which has no executor behind it', async () => {
    const out = await runCustomerAction(request({ actionType: 'note.add' }), ports())

    expect(out.lifecycle).toBe('validation_failed')
    expect(out.detail).toContain('note.add')
    expect(ledger.rows()).toHaveLength(0)
  })

  it('refuses an action this role may not take, without executing it', async () => {
    const out = await runCustomerAction(
      request({ actionType: 'lead.update', actorRole: 'staff', payload: PAYLOADS['lead.update'] }),
      ports(),
    )

    expect(out.lifecycle).toBe('permission_denied')
    expect(ledger.rows()).toHaveLength(0)
  })

  it('requires an idempotency key rather than inventing one', async () => {
    const out = await runCustomerAction(request({ idempotencyKey: '  ' }), ports())

    expect(out.lifecycle).toBe('validation_failed')
    expect(ledger.rows()).toHaveLength(0)
  })
})

/* ── the executor-shaped gap ───────────────────────────────────────────────*/

describe('a declared action with no implementation says so', () => {
  it('preserves EXECUTOR_UNAVAILABLE rather than reporting a failure or a success', async () => {
    const declaredOnly = buildExecutors(recordSystem()).map((e) =>
      e.actionType === 'note.create'
        ? { ...e, execute: undefined, readback: undefined }
        : e,
    )

    const out = await runCustomerAction(request(), {
      ledger,
      executors: declaredOnly,
      now: () => new Date(),
    })

    expect(out.lifecycle).toBe('executor_unavailable')
    expect(out.presentation.success).toBe(false)
    expect(out.presentation.escalate).toBe(true)
    // Not converted into a generic failure.
    expect(out.lifecycle).not.toBe('execution_failed')
    expect(out.detail).toContain('no implementation')
  })
})

/* ── the distinction the whole mutation is about ───────────────────────────*/

describe('unreachable is not the same as refused', () => {
  it('reports a dependency outage as unreachable and retryable', async () => {
    const out = await runCustomerAction(request(), ports('down'))

    expect(out.lifecycle).toBe('dependency_unavailable')
    expect(out.presentation.retryWrite).toBe('safe')
    expect(out.presentation.tone).toBe('unreachable')
  })

  it('reports a refusal as refused and NOT retryable', async () => {
    const out = await runCustomerAction(request(), ports('refused'))

    expect(out.lifecycle).toBe('execution_failed')
    expect(out.presentation.retryWrite).toBe('unsafe')
    expect(out.presentation.tone).toBe('refused')
  })

  it('does not leak the system of record error text to the caller', async () => {
    const out = await runCustomerAction(request(), ports('refused'))

    expect(out.detail).not.toContain('access denied')
    expect(out.detail).not.toContain('10.0.0.9')
    expect(out.detail).not.toContain('portal@')
    expect(out.detail).toBe(LIFECYCLE_PRESENTATION.execution_failed.sentence)
  })
})

/* ── written, and unprovable ───────────────────────────────────────────────*/

describe('readback_failed is never a success', () => {
  it('is reported when the record cannot be read back at all', async () => {
    const out = await runCustomerAction(request(), ports('silent'))

    expect(out.lifecycle).toBe('readback_failed')
    expect(out.presentation.success).toBe(false)
    expect(out.readbackProven).toBe(false)
    expect(out.presentation.label).toBe('Written but not confirmed')
  })

  it('is reported when the record comes back NOT matching what was asked for', async () => {
    const out = await runCustomerAction(request(), ports('wrong'))

    expect(out.lifecycle).toBe('readback_failed')
    expect(out.presentation.success).toBe(false)
  })

  it('says re-reading may be safe and re-writing is not', async () => {
    const out = await runCustomerAction(request(), ports('silent'))

    expect(out.presentation.retryWrite).toBe('unsafe')
    expect(out.presentation.retryReadback).toBe('safe')
    expect(out.presentation.escalate).toBe(true)
  })

  it('records the operation as failed, so the history does not show a tick either', async () => {
    await runCustomerAction(request(), ports('silent'))

    const [row] = ledger.rows()
    expect(row.state).toBe('failed')
    expect(row.failureClass).toBe('READBACK_FAILED')
    expect(row.envelope?.readback ?? null).toBeNull()
  })
})

/* ── the ledger is the one idempotency mechanism ───────────────────────────*/

describe('replays and conflicts come from the ledger, not from a second check', () => {
  it('replays a completed operation without executing again', async () => {
    const rec = recordSystem()
    const createNote = vi.spyOn(rec, 'createNote')
    const p = { ledger, executors: buildExecutors(rec), now: () => new Date() }

    const first = await runCustomerAction(request(), p)
    const second = await runCustomerAction(request(), p)

    expect(first.lifecycle).toBe('completed_verified')
    expect(second.lifecycle).toBe('idempotent_replay')
    expect(createNote).toHaveBeenCalledTimes(1)
    // A replay is NOT a success in its own right: it inherits an earlier result.
    expect(second.presentation.success).toBe(false)
    expect(second.presentation.showsPriorResult).toBe(true)
  })

  it('refuses the same key with different arguments rather than answering the wrong question', async () => {
    const p = ports()
    await runCustomerAction(request(), p)

    const conflicting = await runCustomerAction(
      request({ payload: { body: 'a completely different note' } }),
      p,
    )

    expect(conflicting.lifecycle).toBe('argument_conflict')
    expect(conflicting.presentation.success).toBe(false)
    expect(conflicting.detail).toContain('was not asked')
  })

  it('reports a claim still in flight as executing, not as done', async () => {
    // A claim that never completes: the executor hangs on this attempt.
    const hanging: RecordSystem = {
      ...recordSystem(),
      createNote: () => new Promise(() => {}),
    }
    void runCustomerAction(request(), { ledger, executors: buildExecutors(hanging), now: () => new Date() })
    await new Promise((r) => setTimeout(r, 0))

    const second = await runCustomerAction(request(), ports())

    expect(second.lifecycle).toBe('executing')
    expect(second.presentation.success).toBe(false)
    expect(second.presentation.terminal).toBe(false)
  })

  it('returns the shared ledger identifier on every outcome that reached it', async () => {
    for (const mode of ['ok', 'down', 'refused', 'silent'] as const) {
      const fresh = createFakeLedgerStore()
      const out = await runCustomerAction(request(), {
        ledger: fresh,
        executors: buildExecutors(recordSystem(mode)),
        now: () => new Date(),
      })
      expect(out.operationId).toMatch(/^op_/)
      expect(out.auditRef).toBeTruthy()
    }
  })

  it('scopes the operation identity to the tenant, so two tenants never share one', async () => {
    const a = await runCustomerAction(request({ tenantId: 'tenant-1', companyId: 'tenant-1' }), ports())
    const b = await runCustomerAction(request({ tenantId: 'tenant-2', companyId: 'tenant-2' }), ports())

    expect(a.operationId).not.toBe(b.operationId)
  })

  it('scopes the operation identity to the customer', async () => {
    const a = await runCustomerAction(request({ customerId: '42' }), ports())
    const b = await runCustomerAction(request({ customerId: '43' }), ports())

    expect(a.operationId).not.toBe(b.operationId)
  })
})

/* ── the ledger itself failing ─────────────────────────────────────────────*/

describe('when the ledger is the thing that is down', () => {
  it('reports unreachable, and does not execute anything', async () => {
    const rec = recordSystem()
    const createNote = vi.spyOn(rec, 'createNote')
    const broken = {
      ...createFakeLedgerStore(),
      find: async () => {
        throw new Error('connect ETIMEDOUT 10.0.0.4:5432')
      },
    }

    const out = await runCustomerAction(request(), {
      ledger: broken,
      executors: buildExecutors(rec),
      now: () => new Date(),
    })

    expect(out.lifecycle).toBe('dependency_unavailable')
    expect(createNote).not.toHaveBeenCalled()
    expect(out.detail).not.toContain('ETIMEDOUT')
  })
})

/* ── validation wording is ours ────────────────────────────────────────────*/

describe('a validation failure names a field, not a system', () => {
  it('passes the validator wording through, because we wrote it', async () => {
    const out = await runCustomerAction(request({ payload: { body: '' } }), ports())

    expect(out.lifecycle).toBe('validation_failed')
    expect(out.detail).toBe('body is required')
  })

  it('records the refusal on the ledger so the attempt is not invisible', async () => {
    await runCustomerAction(request({ payload: { body: '' } }), ports())

    const [row] = ledger.rows()
    expect(row.state).toBe('failed')
    expect(row.failureClass).toBe('VALIDATION_FAILED')
  })
})
