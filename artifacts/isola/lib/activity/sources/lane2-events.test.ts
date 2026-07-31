import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ProjectedActivity } from '@/lib/events/ingest'

import type { ResolvedQuery } from '../feed'
import {
  createLane2Source,
  normaliseHealth,
  nullLane2Store,
  projectLane2Activity,
  type Lane2ProjectionStore,
} from './lane2-events'

const NOW = new Date('2026-07-31T18:00:00Z')
const COMPANY = 'tenant-1'
const OTHER = 'tenant-2'

const query: ResolvedQuery = {
  companyId: COMPANY,
  pageSize: 25,
  cursor: null,
  permittedCompanies: [COMPANY],
}

function event(over: Partial<ProjectedActivity> = {}): ProjectedActivity {
  return {
    eventId: 'evt-1',
    companyId: COMPANY,
    type: 'message.inbound.customer',
    source: 'whatsapp',
    actorClass: 'customer',
    occurredAt: new Date('2026-07-31T17:50:00Z'),
    receivedAt: new Date('2026-07-31T17:50:03Z'),
    channelBindingId: 'cb-1',
    agentRef: null,
    conversationRef: 'conv-9',
    relatedObjects: {},
    correlationId: 'corr-1',
    payload: {},
    ...over,
  }
}

const store = (rows: ProjectedActivity[] | (() => Promise<never>)): Lane2ProjectionStore => ({
  read: typeof rows === 'function' ? rows : async () => rows,
})

const source = (rows: Parameters<typeof store>[0], links = {}) =>
  createLane2Source({ store: store(rows), now: () => NOW, ...links })

describe('event families ingestion actually persists', () => {
  it.each([
    ['message.inbound.customer', 'customer.message', null],
    ['agent.response', 'clawith.activity', null],
    ['conversation.created', 'clawith.activity', null],
    ['ownership.human_takeover', 'ownership.human_takeover', 'human'],
    ['ownership.human_reply', 'ownership.human_reply', 'human'],
    ['message.internal.user', 'ownership.human_reply', 'human'],
    ['ownership.handback', 'ownership.handback', 'ai'],
    ['ownership.ai', 'ownership.handback', 'ai'],
    ['channel.health', 'channel.health', null],
    ['agent.health', 'agent.health', null],
    ['delivery.failure', 'channel.health', null],
  ] as const)('%s becomes %s', (type, family, ownership) => {
    const item = projectLane2Activity(event({ type }))
    expect(item?.eventType).toBe(family)
    expect(item?.ownershipState).toBe(ownership)
  })

  it('drops a persisted type this feed has no family for, rather than inventing one', () => {
    expect(projectLane2Activity(event({ type: 'provisioning.channel.result' }))).toBeNull()
    expect(projectLane2Activity(event({ type: 'delivery.success' }))).toBeNull()
  })

  it('is reported, not authoritative, so a system of record wins a duplicate', () => {
    expect(projectLane2Activity(event())?.provenance.trust).toBe('reported')
  })
})

describe('health is never optimistic', () => {
  it.each([
    ['healthy', 'healthy'],
    ['ok', 'healthy'],
    ['degraded', 'degraded'],
    ['failed', 'unavailable'],
    ['down', 'unavailable'],
    ['stale', 'stale'],
    ['not_configured', 'not_configured'],
    ['something-new', 'unknown'],
    ['', 'unknown'],
    [undefined, 'unknown'],
  ])('%s reads as %s', (raw, expected) => {
    expect(normaliseHealth(raw)).toBe(expected)
  })

  it('an unrecognised channel status is UNKNOWN on the row, never healthy', () => {
    const item = projectLane2Activity(
      event({ type: 'channel.health', payload: { status: 'weird-new-value' } }),
    )
    expect(item?.status).toBe('unknown')
    expect(item?.status).not.toBe('healthy')
  })
})

describe('what a row is allowed to say', () => {
  it('never carries the message body', async () => {
    const r = await source([
      event({ payload: { body: 'my card number is 4111 1111 1111 1111', text: 'secret' } }),
    ]).read(query)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    const serialised = JSON.stringify(r.items)
    expect(serialised).not.toContain('4111')
    expect(serialised).not.toContain('secret')
  })

  it('never carries agent reasoning or a system prompt', () => {
    const item = projectLane2Activity(
      event({
        type: 'agent.response',
        payload: {
          reasoning: 'the customer is probably lying about the outage',
          systemPrompt: 'You are Atlas...',
        },
      }),
    )
    const serialised = JSON.stringify(item)
    expect(serialised).not.toContain('probably lying')
    expect(serialised).not.toContain('You are Atlas')
  })

  it('carries a health detail, because that is what an operator needs', () => {
    const item = projectLane2Activity(
      event({ type: 'channel.health', payload: { status: 'degraded', detail: 'send latency 8s' } }),
    )
    expect(item?.summary).toContain('send latency 8s')
  })
})

describe('links are built, never guessed', () => {
  it('offers no link when no base URL is configured', () => {
    expect(projectLane2Activity(event())?.nativeLinks).toHaveLength(0)
  })

  it('offers a Chatwoot link from an authoritative conversation reference', () => {
    const item = projectLane2Activity(event(), { chatwootBaseUrl: 'https://chat.example' })
    expect(item?.nativeLinks[0]).toMatchObject({
      system: 'chatwoot',
      href: 'https://chat.example/app/conversations/conv-9',
    })
  })

  it('offers no Chatwoot link when the projection has no conversation reference', () => {
    const item = projectLane2Activity(event({ conversationRef: null }), {
      chatwootBaseUrl: 'https://chat.example',
    })
    expect(item?.nativeLinks).toHaveLength(0)
  })

  it('offers a Clawith link only from an agent reference', () => {
    const withAgent = projectLane2Activity(event({ agentRef: 'agent-7', conversationRef: null }), {
      clawithBaseUrl: 'https://agents.example',
    })
    expect(withAgent?.nativeLinks[0].href).toBe('https://agents.example/agents/agent-7')
  })
})

describe('scope, dedupe and ordering', () => {
  it('drops another company at the SOURCE, not later in the feed', async () => {
    const r = await source([
      event({ eventId: 'mine' }),
      event({ eventId: 'theirs', companyId: OTHER }),
    ]).read(query)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.items.map((i) => i.activityId)).toEqual(['lane2:mine'])
  })

  it('the same event delivered twice becomes one row', async () => {
    const r = await source([event({ eventId: 'same' }), event({ eventId: 'same' })]).read(query)
    expect(r.status === 'ok' && r.items).toHaveLength(1)
  })

  it('two messages in one conversation stay two rows', async () => {
    const r = await source([
      event({ eventId: 'm1', conversationRef: 'conv-9' }),
      event({ eventId: 'm2', conversationRef: 'conv-9' }),
    ]).read(query)
    expect(r.status === 'ok' && r.items).toHaveLength(2)
  })

  it('shared correlation does NOT collapse different events', async () => {
    const r = await source([
      event({ eventId: 'a', correlationId: 'corr-x' }),
      event({ eventId: 'b', correlationId: 'corr-x' }),
    ]).read(query)
    expect(r.status === 'ok' && r.items).toHaveLength(2)
  })

  it('a late arrival keeps its historical occurred time', () => {
    const item = projectLane2Activity(
      event({
        occurredAt: new Date('2026-07-31T09:00:00Z'),
        receivedAt: new Date('2026-07-31T17:59:00Z'),
      }),
    )
    expect(item?.occurredAt).toBe('2026-07-31T09:00:00.000Z')
    expect(item?.receivedAt).toBe('2026-07-31T17:59:00.000Z')
  })

  it('survives missing optional references', () => {
    const item = projectLane2Activity(
      event({ agentRef: null, conversationRef: null, correlationId: null, relatedObjects: {} }),
    )
    expect(item).not.toBeNull()
    expect(item?.relatedObjectId).toBeNull()
  })
})

describe('source state', () => {
  it('a store that throws is unavailable, never an empty Lane-2 history', async () => {
    const r = await source(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:5432')
    }).read(query)
    expect(r.status).toBe('unavailable')
  })

  it('the store that exists today says WHY there is nothing, rather than saying nothing', async () => {
    const r = await createLane2Source({ store: nullLane2Store, now: () => NOW }).read(query)
    expect(r.status).toBe('unavailable')
    if (r.status !== 'unavailable') return
    expect(r.reason.length).toBeGreaterThan(0)
  })

  it('no matching rows is available_empty, not unavailable', async () => {
    const r = await source([]).read(query)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.items).toHaveLength(0)
  })

  it('reports stale when told the read is old', async () => {
    const s = createLane2Source({
      store: store([event()]),
      now: () => NOW,
      staleReason: () => 'last good read',
    })
    expect((await s.read(query)).status).toBe('stale')
  })

  it('marks fixture rows as fixture', async () => {
    const s = createLane2Source({ store: store([event()]), now: () => NOW, mode: 'fixture' })
    const r = await s.read(query)
    expect(r.status === 'ok' && r.mode).toBe('fixture')
  })
})

describe('the boundary', () => {
  const src = readFileSync(join(__dirname, 'lane2-events.ts'), 'utf8')
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const code = noComments.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')

  it('imports no provider client and names no provider host', () => {
    expect(noComments).not.toMatch(/graph\.facebook\.com|api\.twilio|agents\.epic\.dm/i)
    expect(noComments).not.toMatch(/from\s+['"][^'"]*(chatwoot|clawith|meta|whatsapp)[^'"]*['"]/i)
    expect(noComments).not.toMatch(/process\.env/)
  })

  it('performs no send, takeover or handback', () => {
    expect(code).not.toMatch(/\bfetch\s*\(/)
    expect(code).not.toMatch(
      /\b(sendMessage|sendReply|deliver|takeOver|takeover|forceHandback|handback|resumeAi|assign)\s*\(/,
    )
    expect(code).not.toMatch(/\bprisma\./)
  })

  it('exposes no function that could act on a conversation', async () => {
    const mod = await import('./lane2-events')
    const actionShaped = Object.keys(mod).filter((k) =>
      /^(send|reply|takeover|handback|resume|assign|close)/i.test(k),
    )
    expect(actionShaped).toEqual([])
  })
})
