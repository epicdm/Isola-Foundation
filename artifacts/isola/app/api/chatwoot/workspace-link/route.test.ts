import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const H = vi.hoisted(() => ({
  findCustomerByPhoneMock: vi.fn(),
  listMessagesMock: vi.fn(),
  addPrivateNoteMock: vi.fn(),
  resolveOdooConfigForTenantMock: vi.fn(),
}))

vi.mock('@/engines/odoo', () => ({ findCustomerByPhone: H.findCustomerByPhoneMock }))
vi.mock('@/engines/chatwoot', () => ({
  listMessages: H.listMessagesMock,
  addPrivateNote: H.addPrivateNoteMock,
}))
vi.mock('@/lib/engines', () => ({
  getChatwootConfig: (b: { base_url: string; account_id: string; token: string }) => ({
    baseUrl: b.base_url,
    accountId: b.account_id,
    token: 'tok',
  }),
}))
vi.mock('@/lib/engine-bindings', () => ({
  resolveOdooConfigForTenant: H.resolveOdooConfigForTenantMock,
}))

const FIXTURE_WEBHOOK_QUERY_VALUE = 'not-a-real-secret-test-fixture-only'
const URL_ = `http://localhost/api/chatwoot/workspace-link?secret=${FIXTURE_WEBHOOK_QUERY_VALUE}`

function post(body: unknown) {
  return new NextRequest(URL_, { method: 'POST', body: JSON.stringify(body) })
}

describe('POST /api/chatwoot/workspace-link', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.CHATWOOT_WORKSPACE_LINK_WEBHOOK_SECRET = FIXTURE_WEBHOOK_QUERY_VALUE
    process.env.ISOLA_WORKSPACE_LINK_BASE_URL = 'https://isola-lumen.saas00.epic.dm'
    H.listMessagesMock.mockResolvedValue([])
    H.resolveOdooConfigForTenantMock.mockResolvedValue({ url: 'x', apiKey: 'y', db: 'z' })
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('rejects a request with no secret', async () => {
    const { POST } = await import('./route')
    const req = new NextRequest('http://localhost/api/chatwoot/workspace-link', {
      method: 'POST',
      body: JSON.stringify({ event: 'conversation_created' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
    expect(H.findCustomerByPhoneMock).not.toHaveBeenCalled()
  })

  it('rejects a request with the wrong secret', async () => {
    const { POST } = await import('./route')
    const req = new NextRequest('http://localhost/api/chatwoot/workspace-link?secret=wrong', {
      method: 'POST',
      body: JSON.stringify({ event: 'conversation_created' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('fails closed when the secret env var itself is unset', async () => {
    delete process.env.CHATWOOT_WORKSPACE_LINK_WEBHOOK_SECRET
    const { POST } = await import('./route')
    const res = await POST(post({ event: 'conversation_created' }))
    expect(res.status).toBe(401)
  })

  it('ignores an event that is not conversation_created', async () => {
    const { POST } = await import('./route')
    const res = await POST(post({ event: 'message_created', id: 1, inbox_id: 7 }))
    expect(res.status).toBe(200)
    expect(H.findCustomerByPhoneMock).not.toHaveBeenCalled()
  })

  it('ignores a conversation_created event on an inbox that is not one of EPIC\'s own three doors', async () => {
    const { POST } = await import('./route')
    const res = await POST(
      post({ event: 'conversation_created', id: 999, inbox_id: '4', meta: { sender: { phone_number: '+17675550188' } } }),
    )
    expect(res.status).toBe(200)
    expect(H.findCustomerByPhoneMock).not.toHaveBeenCalled()
  })

  it('skips when the conversation has no sender phone', async () => {
    const { POST } = await import('./route')
    const res = await POST(post({ event: 'conversation_created', id: 100, inbox_id: '7', meta: {} }))
    expect(res.status).toBe(200)
    expect(H.findCustomerByPhoneMock).not.toHaveBeenCalled()
  })

  it('skips (idempotently) when a workspace-link note is already posted in this conversation, before ever calling Odoo', async () => {
    H.listMessagesMock.mockResolvedValue([{ content: 'Isola customer workspace: https://x/customer/1' }])
    const { POST } = await import('./route')
    const res = await POST(
      post({ event: 'conversation_created', id: 100, inbox_id: '7', meta: { sender: { phone_number: '+17675550188' } } }),
    )
    expect(res.status).toBe(200)
    expect(H.findCustomerByPhoneMock).not.toHaveBeenCalled()
    expect(H.addPrivateNoteMock).not.toHaveBeenCalled()
  })

  it('skips when no Odoo customer matches the phone', async () => {
    H.findCustomerByPhoneMock.mockResolvedValue(null)
    const { POST } = await import('./route')
    const res = await POST(
      post({ event: 'conversation_created', id: 100, inbox_id: '8', meta: { sender: { phone_number: '+17675550188' } } }),
    )
    expect(res.status).toBe(200)
    expect(H.addPrivateNoteMock).not.toHaveBeenCalled()
  })

  it('skips (and never calls addPrivateNote) when the base URL is not configured', async () => {
    delete process.env.ISOLA_WORKSPACE_LINK_BASE_URL
    H.findCustomerByPhoneMock.mockResolvedValue({ id: 42 })
    const { POST } = await import('./route')
    const res = await POST(
      post({ event: 'conversation_created', id: 100, inbox_id: '12', meta: { sender: { phone_number: '+17675550188' } } }),
    )
    expect(res.status).toBe(200)
    expect(H.addPrivateNoteMock).not.toHaveBeenCalled()
  })

  it('posts exactly one private note carrying the workspace link for a real match, on inbox 7/8/12', async () => {
    H.findCustomerByPhoneMock.mockResolvedValue({ id: 42 })
    const { POST } = await import('./route')
    for (const inboxId of ['7', '8', '12']) {
      H.addPrivateNoteMock.mockClear()
      const res = await POST(
        post({
          event: 'conversation_created',
          id: 100 + Number(inboxId),
          inbox_id: inboxId,
          meta: { sender: { phone_number: '+17675550188' } },
        }),
      )
      expect(res.status).toBe(200)
      expect(H.addPrivateNoteMock).toHaveBeenCalledTimes(1)
      const [, , content] = H.addPrivateNoteMock.mock.calls[0]
      expect(content).toBe('Isola customer workspace: https://isola-lumen.saas00.epic.dm/customer/42')
    }
  })

  it('resolves Odoo through EPIC_OWNER_TENANT_ID, never a caller-supplied or re-derived tenant', async () => {
    H.findCustomerByPhoneMock.mockResolvedValue({ id: 42 })
    const { POST } = await import('./route')
    await POST(
      post({ event: 'conversation_created', id: 100, inbox_id: '7', meta: { sender: { phone_number: '+17675550188' } } }),
    )
    expect(H.resolveOdooConfigForTenantMock).toHaveBeenCalledWith('cmtblqq870000pg44a2ed1hvz')
  })
})
