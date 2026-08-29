import { describe, expect, it, vi } from 'vitest'

import { runGovernedAction, type ActionPorts, type ActionProposal } from '../action'

import { buildConversationExecutors, type ConversationSystem } from './conversation'

const BODY = 'Hi Patricia,\n\nHere are the details of your quotation S00001:\n\nTotal: USD 273.70'

function validPayload(over: Record<string, unknown> = {}) {
  return {
    conversationId: 15,
    documentId: 1,
    documentKind: 'quotation',
    documentReference: 'S00001',
    body: BODY,
    // The reviewed-text binding travels in the payload so the ledger hashes it.
    previewFingerprint: 'a'.repeat(64),
    ...over,
  }
}

function executor(conv: ConversationSystem) {
  return buildConversationExecutors(conv)[0]
}

/** A conversation system that posts fine and reads back whatever it is told to. */
function systemReturning(row: Record<string, unknown> | null): ConversationSystem {
  return {
    postCustomerVisibleMessage: vi.fn(async () => ({ externalId: '1001' })),
    readMessage: vi.fn(async () => row),
  }
}

const NEVER: ConversationSystem = {
  postCustomerVisibleMessage: vi.fn(async () => {
    throw new Error('must not be called')
  }),
  readMessage: vi.fn(async () => {
    throw new Error('must not be called')
  }),
}

describe('document.send — validation', () => {
  const e = executor(NEVER)

  it('accepts a well-formed payload', () => {
    expect(e.validate(validPayload())).toEqual({ ok: true })
  })

  it.each([
    ['conversationId', { conversationId: undefined }],
    ['documentId', { documentId: undefined }],
    ['documentKind', { documentKind: undefined }],
    ['documentReference', { documentReference: '  ' }],
    ['body', { body: '' }],
    // A send that is not bound to text a human reviewed is refused by the
    // executor as well as by the route. Three enforcement points, one rule.
    ['previewFingerprint', { previewFingerprint: undefined }],
    ['previewFingerprint (blank)', { previewFingerprint: '   ' }],
  ])('refuses a payload missing %s', (_field, over) => {
    expect(e.validate(validPayload(over)).ok).toBe(false)
  })

  it('refuses a kind that is not sendable, even a real Odoo one', () => {
    expect(e.validate(validPayload({ documentKind: 'order' })).ok).toBe(false)
  })

  it('refuses a non-positive conversation id', () => {
    expect(e.validate(validPayload({ conversationId: 0 })).ok).toBe(false)
    expect(e.validate(validPayload({ conversationId: -3 })).ok).toBe(false)
  })

  it('refuses a body beyond the platform limit rather than letting the network do it', () => {
    expect(e.validate(validPayload({ body: 'x'.repeat(4001) })).ok).toBe(false)
    expect(e.validate(validPayload({ body: 'x'.repeat(4000) })).ok).toBe(true)
  })

  it('does not reach the conversation system while validating', () => {
    e.validate(validPayload())
    expect(NEVER.postCustomerVisibleMessage).not.toHaveBeenCalled()
    expect(NEVER.readMessage).not.toHaveBeenCalled()
  })
})

describe('document.send — readback is the only proof', () => {
  const proposal = {
    payload: validPayload(),
  } as unknown as ActionProposal

  it('accepts a readback whose content matches and which is NOT private', async () => {
    const e = executor(systemReturning({ id: 1001, content: BODY, private: false }))
    await expect(e.readback!('1001', proposal)).resolves.toMatchObject({ id: 1001 })
  })

  it('REFUSES a readback that is private — a note is not a reply to the customer', async () => {
    const e = executor(systemReturning({ id: 1001, content: BODY, private: true }))
    await expect(e.readback!('1001', proposal)).resolves.toBeNull()
  })

  it('REFUSES a readback whose content differs from what was authorised', async () => {
    const e = executor(systemReturning({ id: 1001, content: 'something else', private: false }))
    await expect(e.readback!('1001', proposal)).resolves.toBeNull()
  })

  it('REFUSES when the message is simply not there', async () => {
    const e = executor(systemReturning(null))
    await expect(e.readback!('1001', proposal)).resolves.toBeNull()
  })

  it('treats a MISSING private flag as unproven rather than assuming visible', async () => {
    const e = executor(systemReturning({ id: 1001, content: BODY }))
    await expect(e.readback!('1001', proposal)).resolves.toBeNull()
  })
})

/* ── the whole lifecycle, so the outcome mapping is proven end to end ───────*/

function ports(executors: readonly ReturnType<typeof executor>[]): ActionPorts {
  return {
    executors,
    approvalRequired: () => false,
    findPriorResult: async () => null,
    recordApprovalRequest: async () => 'appr:test',
    writeAudit: async () => 'audit:test',
  }
}

const baseProposal: ActionProposal = {
  actionType: 'document.send',
  actorPrincipalId: 'user-1',
  actorRole: 'staff',
  companyId: 'tenant-1',
  objectType: 'customer',
  objectId: '6',
  payload: validPayload(),
  idempotencyKey: 'key-1',
  correlationId: 'corr-1',
}

describe('document.send — governed outcomes', () => {
  it('reports EXECUTED only when the readback proved a visible message', async () => {
    const e = executor(systemReturning({ id: 1001, content: BODY, private: false }))
    const res = await runGovernedAction(baseProposal, ports([e]))
    expect(res.outcome).toBe('EXECUTED')
    expect(res.readback).not.toBeNull()
  })

  it('reports READBACK_FAILED — never success — when the send landed as private', async () => {
    const e = executor(systemReturning({ id: 1001, content: BODY, private: true }))
    const res = await runGovernedAction(baseProposal, ports([e]))
    expect(res.outcome).toBe('READBACK_FAILED')
    expect(res.readback).toBeNull()
  })

  it('refuses a role the executor does not allow, before anything is posted', async () => {
    const conv = systemReturning({ id: 1001, content: BODY, private: false })
    const res = await runGovernedAction(
      { ...baseProposal, actorRole: 'service_account' },
      ports([executor(conv)]),
    )
    expect(res.outcome).toBe('PERMISSION_DENIED')
    expect(conv.postCustomerVisibleMessage).not.toHaveBeenCalled()
  })
})
