/**
 * The send route's first tests.
 *
 * An independent review of PR #114 found this route had NO test at all: the
 * tenant boundaries, the preview↔send composer parity, the fingerprint gate and
 * the empty-token refusal were asserted nowhere — and three of the six blocking
 * findings lived in this one file. The executor and the composer were both well
 * covered in isolation, which is exactly the shape CLAUDE.md §2.20 warns about:
 * testing the PIECES is not testing the PATH.
 *
 * The centrepiece is `misdelivery`: two bindings on one tenant, a conversation
 * belonging to the first, and a caller naming the second. Every check the route
 * used to run passed on that input and the message went to the wrong customer.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getSessionFromCookieMock,
  getMembershipRoleMock,
  resolveOdooConfigMock,
  readCustomer360Mock,
  bindingFindFirstMock,
  bindingFindManyMock,
  conversationFindFirstMock,
  runCustomerActionMock,
  createSystemMock,
} = vi.hoisted(() => ({
  getSessionFromCookieMock: vi.fn(),
  getMembershipRoleMock: vi.fn(),
  resolveOdooConfigMock: vi.fn(),
  readCustomer360Mock: vi.fn(),
  bindingFindFirstMock: vi.fn(),
  bindingFindManyMock: vi.fn(),
  conversationFindFirstMock: vi.fn(),
  runCustomerActionMock: vi.fn(),
  createSystemMock: vi.fn(),
}))

vi.mock('@/lib/session', () => ({ getSessionFromCookie: getSessionFromCookieMock }))
vi.mock('@/lib/permissions', () => ({ getMembershipRole: getMembershipRoleMock }))
vi.mock('@/lib/engine-bindings', () => ({ resolveOdooConfigForTenant: resolveOdooConfigMock }))
vi.mock('@/lib/customer-360/odoo-projection', () => ({ readCustomer360: readCustomer360Mock }))
vi.mock('@/lib/operations/ledger', () => ({ prismaLedgerStore: {} }))
vi.mock('@/lib/governed/customer-actions', () => ({ runCustomerAction: runCustomerActionMock }))
vi.mock('./chatwoot-conversation-system', () => ({
  createChatwootConversationSystem: createSystemMock,
}))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    chatwootBinding: { findFirst: bindingFindFirstMock, findMany: bindingFindManyMock },
    conversation: { findFirst: conversationFindFirstMock },
  },
}))

import { POST } from './route'

const TENANT = 'tenant-c360'

const session = {
  identityId: 'identity-1',
  effectiveTenantId: TENANT,
  isAdmin: false,
  isOwner: true,
  user: { id: 'user-1', tenant_id: TENANT },
}

/** Door A — the one conversation 15 actually belongs behind. */
const DOOR_A = {
  base_url: 'https://inbox.example.com',
  account_id: '1',
  inbox_id: '11',
  token: 'tok-a',
}
/** Door B — same tenant, different customer's inbox. */
const DOOR_B = {
  base_url: 'https://inbox.example.com',
  account_id: '2',
  inbox_id: '22',
  token: 'tok-b',
}

const POSTED_INVOICE = {
  id: 9,
  reference: 'INV/2026/00009',
  kind: 'invoice' as const,
  state: 'posted',
  paymentState: 'not_paid',
  total: 100,
  residual: 100,
  currency: 'USD',
  date: '2026-08-27',
  odooLink: null,
}

const snapshot = {
  customer: { id: 163, name: 'Patricia Armour' },
  documents: [POSTED_INVOICE],
}

const hintFor = (door: typeof DOOR_A) => ({
  accountIdHint: Number(door.account_id),
  inboxIdHint: Number(door.inbox_id),
  conversationDisplayIdHint: 15,
})

const request = (body: unknown) =>
  new Request('http://localhost/api/isola-360/actions/send-document', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'sid=x' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest

/** Conversation 15, carrying whichever door-identifying columns are given. */
function conversationOn(over: Record<string, unknown> = {}) {
  conversationFindFirstMock.mockResolvedValue({
    customer_phone: '+17672951770',
    chatwoot_binding_id: null,
    chatwoot_inbox_id: DOOR_A.inbox_id,
    messages: [{ content: 'what do I owe?' }],
    ...over,
  })
}

beforeEach(() => {
  for (const m of [
    getSessionFromCookieMock,
    getMembershipRoleMock,
    resolveOdooConfigMock,
    readCustomer360Mock,
    bindingFindFirstMock,
    bindingFindManyMock,
    conversationFindFirstMock,
    runCustomerActionMock,
    createSystemMock,
  ]) {
    m.mockReset()
  }
  getSessionFromCookieMock.mockResolvedValue(session)
  getMembershipRoleMock.mockResolvedValue('owner')
  resolveOdooConfigMock.mockResolvedValue({ url: 'https://erp.example.com' })
  readCustomer360Mock.mockResolvedValue(snapshot)
  conversationOn()
  // Door resolution falls back to inbox_id, which is what live rows carry.
  bindingFindManyMock.mockResolvedValue([DOOR_A])
  createSystemMock.mockReturnValue({})
  // The SHAPE runCustomerAction actually returns — success and the wording live
  // under `presentation`, which the route reads. An invented flatter shape made
  // the route throw on `outcome.presentation.success`, and a fake that does not
  // mirror the real contract tests the fake.
  runCustomerActionMock.mockResolvedValue({
    version: 'customer-action@1',
    actionType: 'document.send',
    correlationId: 'corr-1',
    operationId: 'op-1',
    auditRef: 'op-1',
    lifecycle: 'completed_verified',
    detail: 'ok',
    readbackProven: true,
    presentation: {
      success: true,
      label: 'Done and confirmed',
      marker: '✓',
      tone: 'ok',
      terminal: true,
      retryWrite: 'not_applicable',
      retryReadback: 'not_applicable',
    },
  })
})

/* ── F19: the door must be the CONVERSATION'S door ───────────────────────── */

describe('the message goes to the conversation it says it is going to', () => {
  it('MISDELIVERY: refuses when the caller names a different door than the conversation', async () => {
    // The defect, exactly. Conversation 15 lives behind door A. The caller names
    // door B — also this tenant's, so every tenant check passes — and the
    // document really does belong to conversation 15's customer. Before the fix
    // the message was delivered to door B, i.e. into a DIFFERENT customer's
    // conversation, and nothing in the request looked wrong.
    const res = await POST(
      request({
        hint: hintFor(DOOR_B),
        documentId: 9,
        documentKind: 'invoice',
        idempotencyKey: 'k1',
        previewFingerprint: 'irrelevant — refusal happens first',
      }),
    )
    const body = await res.json()

    expect(body.success).toBe(false)
    expect(body.lifecycle).toBe('validation_failed')
    expect(body.detail).toContain('different Chatwoot inbox')
    expect(runCustomerActionMock).not.toHaveBeenCalled()
  })

  it('POSITIVE CONTROL: the SAME request against the conversation’s own door sends', async () => {
    // Without this, the refusal above would pass equally against a route that
    // had been broken to refuse everything.
    const preview = await POST(
      request({ hint: hintFor(DOOR_A), documentId: 9, documentKind: 'invoice', preview: true }),
    )
    const { fingerprint } = await preview.json()

    const res = await POST(
      request({
        hint: hintFor(DOOR_A),
        documentId: 9,
        documentKind: 'invoice',
        idempotencyKey: 'k2',
        previewFingerprint: fingerprint,
      }),
    )
    const body = await res.json()

    expect(body.success).toBe(true)
    expect(runCustomerActionMock).toHaveBeenCalledTimes(1)
  })

  it('never resolves the door from the caller’s account/inbox', async () => {
    // Runs BOTH resolution paths, because the earlier version of this test used
    // only the default fixture — where chatwoot_binding_id is null — so
    // bindingFindFirstMock was never called, the loop body never executed, and
    // the test asserted precisely nothing while passing.
    conversationOn({ chatwoot_binding_id: 'bind-a' })
    bindingFindFirstMock.mockResolvedValue(DOOR_A)
    await POST(
      request({
        hint: hintFor(DOOR_A),
        documentId: 9,
        documentKind: 'invoice',
        idempotencyKey: 'k3a',
        previewFingerprint: 'x',
      }),
    )

    conversationOn()
    await POST(
      request({
        hint: hintFor(DOOR_A),
        documentId: 9,
        documentKind: 'invoice',
        idempotencyKey: 'k3b',
        previewFingerprint: 'x',
      }),
    )

    // Control: the loops below are only meaningful if a lookup actually happened.
    expect(bindingFindFirstMock.mock.calls.length).toBeGreaterThan(0)
    expect(bindingFindManyMock.mock.calls.length).toBeGreaterThan(0)

    // The old route called findFirst({ account_id, inbox_id }) straight from the
    // hint. Any such lookup, on either path, is the defect returning.
    for (const call of bindingFindFirstMock.mock.calls) {
      expect(call[0]?.where?.account_id).toBeUndefined()
      expect(call[0]?.where?.inbox_id).toBeUndefined()
    }
    for (const call of bindingFindManyMock.mock.calls) {
      // The inbox fallback keys on the CONVERSATION's inbox, never the hint's.
      expect(call[0]?.where?.account_id).toBeUndefined()
      expect(call[0]?.where?.inbox_id).toBe(DOOR_A.inbox_id)
    }
  })

  it('prefers chatwoot_binding_id over the inbox fallback when the row has one', async () => {
    conversationOn({ chatwoot_binding_id: 'bind-a' })
    bindingFindFirstMock.mockResolvedValue(DOOR_A)

    await POST(
      request({
        hint: hintFor(DOOR_A),
        documentId: 9,
        documentKind: 'invoice',
        idempotencyKey: 'k4',
        previewFingerprint: 'x',
      }),
    )

    expect(bindingFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'bind-a', tenant_id: TENANT } }),
    )
    expect(bindingFindManyMock).not.toHaveBeenCalled()
  })

  it('refuses when the conversation carries NEITHER door column', async () => {
    conversationOn({ chatwoot_binding_id: null, chatwoot_inbox_id: null })

    const res = await POST(
      request({
        hint: hintFor(DOOR_A),
        documentId: 9,
        documentKind: 'invoice',
        idempotencyKey: 'k5',
        previewFingerprint: 'x',
      }),
    )
    const body = await res.json()

    expect(body.success).toBe(false)
    expect(body.detail).toContain('not linked to a Chatwoot connection')
    expect(runCustomerActionMock).not.toHaveBeenCalled()
  })

  it('refuses when the inbox fallback is AMBIGUOUS rather than picking one', async () => {
    bindingFindManyMock.mockResolvedValue([DOOR_A, { ...DOOR_A, account_id: '3' }])

    const res = await POST(
      request({
        hint: hintFor(DOOR_A),
        documentId: 9,
        documentKind: 'invoice',
        idempotencyKey: 'k6',
        previewFingerprint: 'x',
      }),
    )
    const body = await res.json()

    expect(body.success).toBe(false)
    expect(body.detail).toContain('more than one connection')
    expect(runCustomerActionMock).not.toHaveBeenCalled()
  })
})

/* ── F6: the confirmation must be bound to reviewed text ─────────────────── */

describe('a send must be bound to text a human reviewed', () => {
  it('REFUSES when previewFingerprint is omitted entirely', async () => {
    // The guard used to be `if (fingerprint && mismatch)`, so omitting the field
    // skipped it. A preview is not required either, so a caller could execute a
    // send with no human having seen any version of the text.
    const res = await POST(
      request({ hint: hintFor(DOOR_A), documentId: 9, documentKind: 'invoice', idempotencyKey: 'k7' }),
    )
    const body = await res.json()

    expect(body.success).toBe(false)
    expect(body.lifecycle).toBe('validation_failed')
    expect(runCustomerActionMock).not.toHaveBeenCalled()
  })

  it('REFUSES when the document changed since it was reviewed', async () => {
    const res = await POST(
      request({
        hint: hintFor(DOOR_A),
        documentId: 9,
        documentKind: 'invoice',
        idempotencyKey: 'k8',
        previewFingerprint: 'a stale fingerprint',
      }),
    )
    const body = await res.json()

    expect(body.lifecycle).toBe('argument_conflict')
    expect(runCustomerActionMock).not.toHaveBeenCalled()
  })

  it('a PREVIEW needs no fingerprint, writes nothing, and returns one to confirm with', async () => {
    const res = await POST(
      request({ hint: hintFor(DOOR_A), documentId: 9, documentKind: 'invoice', preview: true }),
    )
    const body = await res.json()

    expect(body.preview).toBe(true)
    expect(typeof body.fingerprint).toBe('string')
    expect(body.body).toContain('INV/2026/00009')
    expect(runCustomerActionMock).not.toHaveBeenCalled()
  })

  it('preview and send compose the SAME text — the panel is never the author', async () => {
    const preview = await POST(
      request({ hint: hintFor(DOOR_A), documentId: 9, documentKind: 'invoice', preview: true }),
    )
    const { fingerprint } = await preview.json()

    await POST(
      request({
        hint: hintFor(DOOR_A),
        documentId: 9,
        documentKind: 'invoice',
        idempotencyKey: 'k9',
        previewFingerprint: fingerprint,
        body: 'A CLIENT-SUPPLIED BODY THAT MUST BE IGNORED',
      }),
    )

    const payload = runCustomerActionMock.mock.calls[0][0].payload
    expect(payload.body).not.toContain('CLIENT-SUPPLIED')
    expect(payload.body).toContain('INV/2026/00009')
    expect(payload.previewFingerprint).toBe(fingerprint)
  })
})

/* ── F20 at the route: a draft invoice is refused server-side ────────────── */

describe('only a posted invoice reaches a customer', () => {
  it('REFUSES a draft invoice even when the caller asks for it directly', async () => {
    // The refusal must come from the POSTED-ONLY guard, not incidentally from the
    // fingerprint check. An earlier version of this test passed a junk
    // fingerprint, so deleting the guard entirely still produced success:false —
    // via argument_conflict — and the test could not tell the two apart.
    // A draft cannot be previewed either, so the fingerprint is taken from the
    // POSTED document first, then the document is swapped to draft.
    const preview = await POST(
      request({ hint: hintFor(DOOR_A), documentId: 9, documentKind: 'invoice', preview: true }),
    )
    const { fingerprint } = await preview.json()

    readCustomer360Mock.mockResolvedValue({
      ...snapshot,
      documents: [{ ...POSTED_INVOICE, state: 'draft', reference: '/' }],
    })

    const res = await POST(
      request({
        hint: hintFor(DOOR_A),
        documentId: 9,
        documentKind: 'invoice',
        idempotencyKey: 'k10',
        previewFingerprint: fingerprint,
      }),
    )
    const body = await res.json()

    expect(body.success).toBe(false)
    expect(body.lifecycle).toBe('validation_failed')
    expect(body.lifecycle).not.toBe('argument_conflict')
    expect(runCustomerActionMock).not.toHaveBeenCalled()
  })

  it('PREVIEW of a draft invoice is refused too — it never composes at all', async () => {
    readCustomer360Mock.mockResolvedValue({
      ...snapshot,
      documents: [{ ...POSTED_INVOICE, state: 'draft', reference: '/' }],
    })

    const res = await POST(
      request({ hint: hintFor(DOOR_A), documentId: 9, documentKind: 'invoice', preview: true }),
    )
    const body = await res.json()

    expect(body.preview).toBeUndefined()
    expect(body.success).toBe(false)
  })
})

/* ── the boundaries that were already right, now actually asserted ───────── */

describe('boundaries', () => {
  it('401s with no session, before any lookup', async () => {
    getSessionFromCookieMock.mockResolvedValue(null)
    const res = await POST(request({ hint: hintFor(DOOR_A) }))
    expect(res.status).toBe(401)
    expect(conversationFindFirstMock).not.toHaveBeenCalled()
  })

  it('refuses a document that is not on THIS conversation’s customer', async () => {
    const res = await POST(
      request({
        hint: hintFor(DOOR_A),
        documentId: 4242,
        documentKind: 'invoice',
        idempotencyKey: 'k11',
        previewFingerprint: 'x',
      }),
    )
    const body = await res.json()
    expect(body.detail).toContain('not available on this customer')
    expect(runCustomerActionMock).not.toHaveBeenCalled()
  })

  it('refuses when the resolved door has no send credential', async () => {
    bindingFindManyMock.mockResolvedValue([{ ...DOOR_A, token: '' }])

    const preview = await POST(
      request({ hint: hintFor(DOOR_A), documentId: 9, documentKind: 'invoice', preview: true }),
    )
    const { fingerprint } = await preview.json()

    const res = await POST(
      request({
        hint: hintFor(DOOR_A),
        documentId: 9,
        documentKind: 'invoice',
        idempotencyKey: 'k12',
        previewFingerprint: fingerprint,
      }),
    )
    const body = await res.json()

    expect(body.success).toBe(false)
    expect(body.detail).toContain('no Chatwoot send credential')
    expect(createSystemMock).not.toHaveBeenCalled()
  })
})
