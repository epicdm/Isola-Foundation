import { describe, expect, it, vi } from 'vitest'

import {
  REVENUE_CONTEXT_ALLOWED_KEYS,
  runRevenueCustomerContextGet,
  type ChatwootBindingRow,
  type ChatwootReadClient,
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
 *
 * Fixture values below match the redacted LIVE fixture captured 2026-08-06
 * for account 5 / inbox 46 / conversation 131 in
 * docs/isola/CHATWOOT-REVENUE-CONTEXT-CONTRACT.md §7: team=escalations,
 * priority=high, assignee=Eric Giraud, labels=["human-takeover"],
 * handoff_state=null, correlation_id=null (both null is correct per that
 * doc — Lane 3's correlation id currently lives in private-note text, not a
 * Chatwoot custom attribute; an honest gap on that lane's side).
 */

const TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79' // EPIC Communications Inc
const ACCOUNT_ID = '5'
const INBOX_ID = '46'
const CONVERSATION_ID = '131'
const DISPLAY_ID = 130
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
        display_id: DISPLAY_ID,
        status: 'open',
        priority: 'high',
        inbox_id: Number(INBOX_ID),
        labels: ['human-takeover'],
        custom_attributes: {}, // handoff_state / correlation_id both absent -> null, per the real fixture
        meta: {
          sender: { id: CONTACT_ID, name: 'Eric Isola Test', phone_number: '+17672956737', email: 'eric@example.com' },
          assignee: { id: 1, name: 'Eric Giraud', email: 'eric@epic.dm' },
          team: { id: 7, name: 'escalations' },
        },
      }
    }),
    listMessages: vi.fn(async () => [
      {
        id: 1,
        message_type: 0,
        sender_type: 'Contact',
        content: 'Hi, I need help with internet and calling setup for my business.',
        created_at: 1785001000,
        private: false,
      },
      {
        id: 2,
        message_type: 1,
        sender_type: 'User',
        sender: { name: 'Eric Giraud' },
        content: 'Sure — let me pull up your account and call you back.',
        created_at: 1785001200,
        private: false,
      },
      {
        id: 3,
        message_type: 2,
        sender_type: 'User',
        content: 'assigned conversation',
        created_at: 1785001300,
        private: false,
      }, // system activity — never counts as a human response
      {
        id: 4,
        message_type: 1,
        sender_type: 'AgentBot',
        sender: { name: 'Isola AI' },
        content: 'Automated acknowledgement',
        created_at: 1785001250,
        private: false,
      }, // bot-authored — never counts as a human response
      {
        id: 5,
        message_type: 1,
        sender_type: 'User',
        sender: { name: 'Eric Giraud' },
        content: 'internal note: check billing before calling back',
        created_at: 1785001400,
        private: true,
      }, // private — excluded entirely
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
}): RevenueContextPorts {
  const tenantForAgent = input.tenantForAgent ?? { 'agent-atlas': TENANT }
  const bindings = input.bindings ?? [BINDING]
  return {
    resolveTenantForAgent: async (agentRef) => tenantForAgent[agentRef] ?? null,
    findChatwootBindingsForTenant: async (tenantId) => bindings.filter((b) => b.tenant_id === tenantId),
    chatwoot: input.chatwoot ?? fakeChatwoot(),
    now: () => new Date('2026-08-06T12:00:00.000Z'),
  }
}

const HAPPY_HINTS = { accountId: ACCOUNT_ID, inboxId: INBOX_ID, conversationId: CONVERSATION_ID }

// ── 1. correct EPIC case resolves, against the REAL contract shape ─────────

describe('runRevenueCustomerContextGet — happy path (real contract shape)', () => {
  it('resolves the controlled EPIC Communications case with the exact §5 shape', async () => {
    const result = await runRevenueCustomerContextGet(
      { caller: { agentRef: 'agent-atlas' }, hints: HAPPY_HINTS },
      fakePorts({}),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const { data } = result

    expect(data.conversation.id).toBe(Number(CONVERSATION_ID))
    expect(data.conversation.display_id).toBe(DISPLAY_ID)
    expect(data.conversation.status).toBe('open')
    expect(data.conversation.priority).toBe('high')
    expect(data.conversation.labels).toEqual(['human-takeover'])
    expect(data.conversation.team).toEqual({ name: 'escalations' })
    expect(data.conversation.assignee).toEqual({ name: 'Eric Giraud' })
    expect(data.conversation.handoff_state).toBeNull()
    expect(data.conversation.correlation_id).toBeNull()
    expect(data.conversation.deep_link).toBe(`https://inbox.epic.dm/app/accounts/${ACCOUNT_ID}/conversations/${CONVERSATION_ID}`)

    expect(data.contact).toEqual({ name: 'Eric Isola Test' })

    expect(data.latest_enquiry).toEqual({
      summary: 'Hi, I need help with internet and calling setup for my business.',
      at: new Date(1785001000 * 1000).toISOString(),
    })

    expect(data.latest_human_response).toEqual({
      responded: true,
      by: 'Eric Giraud',
      at: new Date(1785001200 * 1000).toISOString(),
    })
  })

  it('never returns account_id, inbox_id, phone, email, message content, or any id field the contract marks INTERNAL_ONLY', async () => {
    const result = await runRevenueCustomerContextGet(
      { caller: { agentRef: 'agent-atlas' }, hints: HAPPY_HINTS },
      fakePorts({}),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    expect(result.data).not.toHaveProperty('version')
    expect(result.data).not.toHaveProperty('tenantId')
    expect(result.data.conversation).not.toHaveProperty('accountId')
    expect(result.data.conversation).not.toHaveProperty('inboxId')
    expect(result.data.conversation.assignee).not.toHaveProperty('id')
    expect(result.data.contact).not.toHaveProperty('id')
    expect(result.data).not.toHaveProperty('messages')
    expect(result.data).not.toHaveProperty('opportunity')

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('+17672956737')
    expect(serialized).not.toContain('eric@example.com')
    expect(serialized).not.toContain('eric@epic.dm')
    expect(serialized).not.toContain(String(CONTACT_ID))
    // the private note's and the human response's own CONTENT must never appear
    expect(serialized).not.toContain('check billing before calling back')
    expect(serialized).not.toContain('Sure — let me pull up your account and call you back.')
  })

  it('excludes bot-authored and system-activity messages from latest_human_response', async () => {
    // The fixture's most recent outgoing message chronologically is the
    // AgentBot one (id 4, 1785001250) — it must be skipped in favor of the
    // human one (id 2, 1785001200) that precedes it, and the private human
    // message (id 5, 1785001400, latest of all) must also be skipped.
    const result = await runRevenueCustomerContextGet(
      { caller: { agentRef: 'agent-atlas' }, hints: HAPPY_HINTS },
      fakePorts({}),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.data.latest_human_response.responded).toBe(true)
    expect(result.data.latest_human_response.by).toBe('Eric Giraud')
    expect(result.data.latest_human_response.at).toBe(new Date(1785001200 * 1000).toISOString())
  })

  it('reports responded:false with by/at both null when no human has replied yet', async () => {
    const chatwoot = fakeChatwoot({
      listMessages: vi.fn(async () => [
        { id: 1, message_type: 0, sender_type: 'Contact', content: 'Hello?', created_at: 1785001000, private: false },
      ]),
    })
    const result = await runRevenueCustomerContextGet(
      { caller: { agentRef: 'agent-atlas' }, hints: HAPPY_HINTS },
      fakePorts({ chatwoot }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.data.latest_human_response).toEqual({ responded: false, by: null, at: null })
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

// ── 11. allowlist enforcement — the REAL §5 shape, nothing else ────────────

function keysOf(obj: unknown): string[] {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return []
  return Object.keys(obj)
}

describe('allowlist enforcement (contract §5 shape — verbatim)', () => {
  it('the response is JSON-serializable and contains only allowlisted keys at every level, and no more', async () => {
    const result = await runRevenueCustomerContextGet(
      { caller: { agentRef: 'agent-atlas' }, hints: HAPPY_HINTS },
      fakePorts({}),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    // JSON-serializable: this throws if it is not.
    const roundTripped = JSON.parse(JSON.stringify(result.data)) as RevenueContextData

    expect(keysOf(roundTripped).sort()).toEqual([...REVENUE_CONTEXT_ALLOWED_KEYS.root].sort())
    expect(keysOf(roundTripped.conversation).sort()).toEqual([...REVENUE_CONTEXT_ALLOWED_KEYS.conversation].sort())
    if (roundTripped.conversation.team) {
      expect(keysOf(roundTripped.conversation.team).sort()).toEqual([...REVENUE_CONTEXT_ALLOWED_KEYS.team].sort())
    }
    if (roundTripped.conversation.assignee) {
      expect(keysOf(roundTripped.conversation.assignee).sort()).toEqual([...REVENUE_CONTEXT_ALLOWED_KEYS.assignee].sort())
    }
    if (roundTripped.contact) {
      expect(keysOf(roundTripped.contact).sort()).toEqual([...REVENUE_CONTEXT_ALLOWED_KEYS.contact].sort())
    }
    if (roundTripped.latest_enquiry) {
      expect(keysOf(roundTripped.latest_enquiry).sort()).toEqual([...REVENUE_CONTEXT_ALLOWED_KEYS.latest_enquiry].sort())
    }
    expect(keysOf(roundTripped.latest_human_response).sort()).toEqual(
      [...REVENUE_CONTEXT_ALLOWED_KEYS.latest_human_response].sort(),
    )
  })

  it('has exactly 4 root keys and no messages/opportunity/version/tenantId field', async () => {
    const result = await runRevenueCustomerContextGet(
      { caller: { agentRef: 'agent-atlas' }, hints: HAPPY_HINTS },
      fakePorts({}),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(Object.keys(result.data).sort()).toEqual(['contact', 'conversation', 'latest_enquiry', 'latest_human_response'])
  })
})

// ── 12. secret scan ──────────────────────────────────────────────────────────

describe('secret scan', () => {
  const SECRET_SHAPED = /(api[_-]?key|access[_-]?token|client[_-]?secret|hmac|webhook[_-]?verify)/i

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
