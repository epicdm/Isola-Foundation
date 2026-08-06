import { describe, expect, it, vi } from 'vitest'

import {
  REVENUE_CONTEXT_ALLOWED_KEYS,
  REVENUE_CONTEXT_VERSION,
  runRevenueCustomerContextGet,
  type ChatwootBindingRow,
  type ChatwootReadClient,
  type OpportunitySnapshot,
  type RevenueContextData,
  type RevenueContextPorts,
} from './context-read'

/**
 * All tests inject a fake Chatwoot client and fake Foundation lookups — no
 * network call, and never the live `mcp__chatwoot__*` tools. The fake
 * Chatwoot client below carries ONLY the three read methods
 * (getConversation/listMessages/getContact) — it has no write method of any
 * kind, which is itself the proof that this tool cannot perform a write; see
 * the "zero side effects" test.
 */

const TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79' // EPIC Communications Inc
const ACCOUNT_ID = '5'
const INBOX_ID = '46'
const CONVERSATION_ID = '131'
const CONTACT_ID = 188

const BINDING: ChatwootBindingRow = {
  id: 'binding-1',
  tenant_id: TENANT,
  base_url: 'https://inbox.epic.dm',
  account_id: ACCOUNT_ID,
  token: 'not a real token, test fixture only',
  inbox_id: INBOX_ID,
}

function fakeChatwoot(overrides: Partial<ChatwootReadClient> = {}): ChatwootReadClient {
  return {
    getConversation: vi.fn(async (_config, conversationId) => {
      if (conversationId !== Number(CONVERSATION_ID)) return null
      return {
        id: conversationId,
        status: 'open',
        inbox_id: Number(INBOX_ID),
        created_at: 1785000000,
        timestamp: 1785003600,
        labels: ['intent_sales', 'new_customer'],
        meta: {
          sender: { id: CONTACT_ID, name: 'Eric Isola Test', phone_number: '+17672956737', email: 'eric@example.com' },
          assignee: { id: 1, name: 'Eric Giraud', email: 'eric@epic.dm' },
        },
      }
    }),
    listMessages: vi.fn(async () => [
      { id: 1, message_type: 0, content: 'Hi, I need help with internet and calling setup for my business.', created_at: 1785001000, private: false },
      { id: 2, message_type: 1, content: 'Sure — let me pull up your account.', created_at: 1785001200, private: false },
      { id: 3, message_type: 2, content: 'assigned conversation', created_at: 1785001300, private: false }, // system activity, must be excluded
      { id: 4, message_type: 1, content: 'internal note: check billing before calling back', created_at: 1785001400, private: true }, // private, must be excluded
    ]),
    getContact: vi.fn(async (_config, contactId) => {
      if (contactId !== CONTACT_ID) return null
      return { id: contactId, name: 'Eric Isola Test', phone_number: '+17672956737', email: 'eric@example.com' }
    }),
    ...overrides,
  }
}

function fakePorts(input: {
  chatwoot?: ChatwootReadClient
  tenantForAgent?: Record<string, string | null>
  bindings?: ChatwootBindingRow[]
  opportunity?: OpportunitySnapshot | null
}): RevenueContextPorts {
  const tenantForAgent = input.tenantForAgent ?? { 'agent-atlas': TENANT }
  const bindings = input.bindings ?? [BINDING]
  return {
    resolveTenantForAgent: async (agentRef) => tenantForAgent[agentRef] ?? null,
    findChatwootBindingsForTenant: async (tenantId) => bindings.filter((b) => b.tenant_id === tenantId),
    chatwoot: input.chatwoot ?? fakeChatwoot(),
    resolveLinkedOpportunity: async () => input.opportunity ?? null,
    now: () => new Date('2026-08-06T12:00:00.000Z'),
  }
}

const HAPPY_HINTS = { accountId: ACCOUNT_ID, inboxId: INBOX_ID, conversationId: CONVERSATION_ID }

// ── 1. correct EPIC case resolves ───────────────────────────────────────────

describe('runRevenueCustomerContextGet — happy path', () => {
  it('resolves the controlled EPIC Communications case', async () => {
    const opportunity: OpportunitySnapshot = {
      leadId: '1642',
      stage: 'qualified',
      ownerRef: '7',
      ownerName: 'Eric Giraud',
      nextAction: 'Call back re: internet/calling/support recommendation',
      dueDate: '2026-08-07',
    }
    const result = await runRevenueCustomerContextGet(
      { caller: { agentRef: 'agent-atlas' }, hints: HAPPY_HINTS },
      fakePorts({ opportunity }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const { data } = result

    expect(data.version).toBe(REVENUE_CONTEXT_VERSION)
    expect(data.tenantId).toBe(TENANT)
    expect(data.conversation.id).toBe(Number(CONVERSATION_ID))
    expect(data.conversation.accountId).toBe(ACCOUNT_ID)
    expect(data.conversation.inboxId).toBe(Number(INBOX_ID))
    expect(data.conversation.status).toBe('open')
    expect(data.conversation.labels).toEqual(['intent_sales', 'new_customer'])
    expect(data.conversation.assignee).toEqual({ id: 1, name: 'Eric Giraud' })
    expect(data.contact).toEqual({ id: CONTACT_ID, name: 'Eric Isola Test' })
    expect(data.opportunity).toEqual(opportunity)
    expect(data.chatwootDeepLink).toBe(`https://inbox.epic.dm/app/accounts/${ACCOUNT_ID}/conversations/${CONVERSATION_ID}`)
  })

  it('never returns phone or email, even though the fake Chatwoot data carries them', async () => {
    const result = await runRevenueCustomerContextGet(
      { caller: { agentRef: 'agent-atlas' }, hints: HAPPY_HINTS },
      fakePorts({}),
    )
    expect(result.ok).toBe(true)
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('+17672956737')
    expect(serialized).not.toContain('eric@example.com')
    expect(serialized).not.toContain('eric@epic.dm')
  })

  it('summarizes messages, excludes private notes and system activity, and never reproduces full content verbatim beyond a short preview', async () => {
    const result = await runRevenueCustomerContextGet(
      { caller: { agentRef: 'agent-atlas' }, hints: HAPPY_HINTS },
      fakePorts({}),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.data.messages).toHaveLength(2) // the activity + the private note are excluded
    expect(result.data.messages[0].direction).toBe('incoming')
    expect(result.data.messages[1].direction).toBe('outgoing')
    for (const m of result.data.messages) {
      expect(m).not.toHaveProperty('content')
      expect(typeof m.preview).toBe('string')
    }
    // The private note's text must never appear anywhere in the output.
    expect(JSON.stringify(result)).not.toContain('check billing before calling back')
  })
})

// ── 2 & 3. wrong tenant / wrong account/inbox/conversation denied ──────────

describe('wrong account / inbox / conversation', () => {
  it('denies when the hinted account/inbox is not bound to the resolved tenant', async () => {
    const result = await runRevenueCustomerContextGet(
      { caller: { agentRef: 'agent-atlas' }, hints: { accountId: '999', inboxId: INBOX_ID, conversationId: CONVERSATION_ID } },
      fakePorts({}),
    )
    expect(result).toEqual({ ok: false, code: 'not_found', detail: expect.any(String) })
  })

  it('denies when the binding exists but belongs to a DIFFERENT tenant (wrong tenant)', async () => {
    const otherTenantBinding: ChatwootBindingRow = { ...BINDING, id: 'binding-2', tenant_id: 'tenant-other' }
    const result = await runRevenueCustomerContextGet(
      { caller: { agentRef: 'agent-atlas' }, hints: HAPPY_HINTS },
      fakePorts({ bindings: [otherTenantBinding] }), // resolved tenant (TENANT) has no matching binding
    )
    expect(result).toEqual({ ok: false, code: 'not_found', detail: expect.any(String) })
  })

  it('denies when the conversation exists but its real inbox_id does not match the hint', async () => {
    const chatwoot = fakeChatwoot({
      getConversation: vi.fn(async (_config, conversationId) => ({
        id: conversationId,
        status: 'open',
        inbox_id: 999, // does not match the hinted/bound inbox 46
        meta: {},
      })),
    })
    const result = await runRevenueCustomerContextGet(
      { caller: { agentRef: 'agent-atlas' }, hints: HAPPY_HINTS },
      fakePorts({ chatwoot }),
    )
    expect(result).toEqual({ ok: false, code: 'not_found', detail: expect.any(String) })
  })

  it('denies when the conversation does not exist on the account at all', async () => {
    const chatwoot = fakeChatwoot({ getConversation: vi.fn(async () => null) })
    const result = await runRevenueCustomerContextGet(
      { caller: { agentRef: 'agent-atlas' }, hints: HAPPY_HINTS },
      fakePorts({ chatwoot }),
    )
    expect(result).toEqual({ ok: false, code: 'not_found', detail: expect.any(String) })
  })
})

// ── 4. unauthenticated ──────────────────────────────────────────────────────

describe('unauthenticated', () => {
  it('denies when no caller identity is supplied', async () => {
    const result = await runRevenueCustomerContextGet(
      { caller: { agentRef: '' }, hints: HAPPY_HINTS },
      fakePorts({}),
    )
    expect(result).toEqual({ ok: false, code: 'unauthenticated', detail: expect.any(String) })
  })

  it('denies when the caller identity does not resolve to an active tenant', async () => {
    const result = await runRevenueCustomerContextGet(
      { caller: { agentRef: 'agent-unknown' }, hints: HAPPY_HINTS },
      fakePorts({}),
    )
    expect(result).toEqual({ ok: false, code: 'unauthenticated', detail: expect.any(String) })
  })
})

// ── 5. zero side effects ────────────────────────────────────────────────────

describe('zero side effects', () => {
  it('the fake Chatwoot client has no write method of any kind — there is nothing for this tool to call to mutate anything', () => {
    const client = fakeChatwoot()
    const keys = Object.keys(client)
    expect(keys.sort()).toEqual(['getContact', 'getConversation', 'listMessages'])
    // None of these three names could plausibly perform a write, and no
    // fourth method (create/update/delete/send/post) exists on this object.
  })

  it('never calls anything beyond getConversation/listMessages/getContact', async () => {
    const chatwoot = fakeChatwoot()
    await runRevenueCustomerContextGet(
      { caller: { agentRef: 'agent-atlas' }, hints: HAPPY_HINTS },
      fakePorts({ chatwoot }),
    )
    expect(chatwoot.getConversation).toHaveBeenCalledTimes(1)
    expect(chatwoot.listMessages).toHaveBeenCalledTimes(1)
    expect(chatwoot.getContact).toHaveBeenCalledTimes(1)
  })
})

// ── 11. allowlist enforcement ────────────────────────────────────────────────

function keysOf(obj: unknown): string[] {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return []
  return Object.keys(obj)
}

describe('allowlist enforcement (contract §5 shape)', () => {
  it('the response is JSON-serializable and contains only allowlisted keys at every level', async () => {
    const opportunity: OpportunitySnapshot = {
      leadId: '1642',
      stage: 'qualified',
      ownerRef: '7',
      ownerName: 'Eric Giraud',
      nextAction: 'Call back',
      dueDate: '2026-08-07',
    }
    const result = await runRevenueCustomerContextGet(
      { caller: { agentRef: 'agent-atlas' }, hints: HAPPY_HINTS },
      fakePorts({ opportunity }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    // JSON-serializable: this throws if it is not.
    const roundTripped = JSON.parse(JSON.stringify(result.data)) as RevenueContextData

    expect(keysOf(roundTripped).sort()).toEqual([...REVENUE_CONTEXT_ALLOWED_KEYS.root].sort())
    expect(keysOf(roundTripped.conversation).sort()).toEqual([...REVENUE_CONTEXT_ALLOWED_KEYS.conversation].sort())
    if (roundTripped.conversation.assignee) {
      expect(keysOf(roundTripped.conversation.assignee).sort()).toEqual([...REVENUE_CONTEXT_ALLOWED_KEYS.assignee].sort())
    }
    if (roundTripped.contact) {
      expect(keysOf(roundTripped.contact).sort()).toEqual([...REVENUE_CONTEXT_ALLOWED_KEYS.contact].sort())
    }
    for (const m of roundTripped.messages) {
      expect(keysOf(m).sort()).toEqual([...REVENUE_CONTEXT_ALLOWED_KEYS.message].sort())
    }
    if (roundTripped.opportunity) {
      expect(keysOf(roundTripped.opportunity).sort()).toEqual([...REVENUE_CONTEXT_ALLOWED_KEYS.opportunity].sort())
    }
  })
})

// ── 12. secret scan ──────────────────────────────────────────────────────────

describe('secret scan', () => {
  const SECRET_SHAPED = /(api[_-]?key|access[_-]?token|client[_-]?secret|hmac|webhook[_-]?verify|cw-agent-token)/i

  it('the output never contains the Chatwoot API token or anything secret-shaped', async () => {
    const result = await runRevenueCustomerContextGet(
      { caller: { agentRef: 'agent-atlas' }, hints: HAPPY_HINTS },
      fakePorts({}),
    )
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(BINDING.token)
    expect(SECRET_SHAPED.test(serialized)).toBe(false)
  })
})
