import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import {
  EVENT_INGEST_VERSION,
  ingestLane2Event,
  projectActivityFeed,
  projectChannelHealth,
  projectOwnership,
  type IngestPorts,
  type IngestResult,
  type Lane2Event,
  type ProjectedActivity,
} from './ingest'

const NOW = new Date('2026-07-31T12:00:00Z')

const EVENT: Lane2Event = {
  eventId: 'e-1',
  version: EVENT_INGEST_VERSION,
  sourceSystem: 'lane2',
  eventType: 'message.inbound.customer',
  occurredAt: '2026-07-31T11:59:00Z',
  companyId: 'co-1',
  channelBindingId: 'cb-1',
  conversationRef: 'conv-1',
  actorClass: 'customer',
  payload: { preview: 'my line is down' },
  dedupeKey: 'wamid-1',
}

function ports(over: Partial<IngestPorts> = {}): IngestPorts {
  return {
    sourceIsTrusted: (s) => s === 'lane2',
    seen: async () => false,
    project: async () => {},
    now: () => NOW,
    ...over,
  }
}

describe('event ingestion — accepts what Lane 2 reports', () => {
  it('projects a valid event', async () => {
    const projected: ProjectedActivity[] = []
    const r = await ingestLane2Event(EVENT, ports({ project: async (a) => void projected.push(a) }))
    expect(r).toEqual({ accepted: true, eventId: 'e-1', projected: true })
    expect(projected[0]?.conversationRef).toBe('conv-1')
    expect(projected[0]?.receivedAt).toEqual(NOW)
  })

  it('projects a duplicate exactly once', async () => {
    const project = vi.fn(async () => {})
    const r = await ingestLane2Event(EVENT, ports({ seen: async () => true, project }))
    expect(r).toEqual({
      accepted: true,
      eventId: 'e-1',
      projected: false,
      reason: 'duplicate',
    })
    expect(project).not.toHaveBeenCalled()
  })

  it('carries the dedupe key into the projection so the store can persist it', async () => {
    const projected: ProjectedActivity[] = []
    await ingestLane2Event(EVENT, ports({ project: async (a) => void projected.push(a) }))
    // `projected_activity.dedupe_key` is NOT NULL and half of a unique key.
    expect(projected[0]?.dedupeKey).toBe('wamid-1')
  })
})

describe('event ingestion — rejections', () => {
  it('rejects an untrusted source before reading anything else', async () => {
    const seen = vi.fn(async () => false)
    const r = await ingestLane2Event({ ...EVENT, sourceSystem: 'anyone' }, ports({ seen }))
    expect(r.accepted).toBe(false)
    if (!r.accepted) expect(r.rejection).toBe('unauthenticated_source')
    expect(seen).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown_version', { version: 'lane2.events.ingest@99' }],
    ['unknown_event_type', { eventType: 'message.telepathy' }],
    ['unknown_actor_class', { actorClass: 'wizard' }],
    ['missing_company', { companyId: '' }],
    ['missing_dedupe_key', { dedupeKey: '' }],
    ['missing_event_id', { eventId: '' }],
    ['bad_timestamp', { occurredAt: 'yesterday-ish' }],
  ])('rejects with %s', async (rejection, patch) => {
    const r = await ingestLane2Event({ ...EVENT, ...(patch as object) }, ports())
    expect(r.accepted).toBe(false)
    if (!r.accepted) expect(r.rejection).toBe(rejection)
  })

  it('refuses a credential hidden deep in the payload, WHOLE', async () => {
    const r = await ingestLane2Event(
      { ...EVENT, payload: { meta: { auth: { token: 'EAAG' + 'x'.repeat(40) } } } },
      ports(),
    )
    expect(r.accepted).toBe(false)
    if (!r.accepted) {
      expect(r.rejection).toBe('payload_contains_credential')
      // The refusal must not echo the matched value back.
      expect(r.detail).not.toMatch(/EAAG/)
    }
  })
})

describe('the receipt is never issued ahead of the projection', () => {
  it('produces NO accepted receipt when the projection fails', async () => {
    // `ports.project` is awaited before the receipt is built. If the store
    // cannot write, the caller must not walk away holding a receipt that says
    // the event was projected.
    let receipt: IngestResult | null = null
    let thrown: unknown = null
    try {
      receipt = await ingestLane2Event(
        EVENT,
        ports({
          project: async () => {
            throw new Error('connect ECONNREFUSED 10.0.0.1:5432')
          },
        }),
      )
    } catch (err) {
      thrown = err
    }

    expect(receipt).toBeNull()
    expect(thrown).toBeInstanceOf(Error)
  })

  it('refuses a credential-shaped payload BEFORE anything is projected', async () => {
    const project = vi.fn(async () => {})
    const r = await ingestLane2Event(
      { ...EVENT, payload: { authorization: `Bearer ${'x'.repeat(30)}` } },
      ports({ project }),
    )
    expect(r.accepted).toBe(false)
    if (!r.accepted) expect(r.rejection).toBe('payload_contains_credential')
    // Not "stored and then scrubbed" — never written at all.
    expect(project).not.toHaveBeenCalled()
  })

  it('an unsupported event type never reaches the projection', async () => {
    const project = vi.fn(async () => {})
    const r = await ingestLane2Event(
      { ...EVENT, eventType: 'message.telepathy' },
      ports({ project }),
    )
    expect(r.accepted).toBe(false)
    if (!r.accepted) expect(r.rejection).toBe('unknown_event_type')
    expect(project).not.toHaveBeenCalled()
  })
})

describe('read model — ownership folds by OCCURRENCE, not arrival', () => {
  const base = {
    companyId: 'co-1',
    source: 'lane2',
    actorClass: 'system' as const,
    receivedAt: NOW,
    channelBindingId: 'cb-1',
    agentRef: null,
    conversationRef: 'conv-1',
    relatedObjects: {},
    correlationId: null,
    payload: {},
  }
  const ev = (id: string, type: ProjectedActivity['type'], iso: string): ProjectedActivity => ({
    ...base,
    eventId: id,
    type,
    occurredAt: new Date(iso),
  })

  it('unknown when nothing has moved ownership', () => {
    expect(projectOwnership([]).owner).toBe('unknown')
  })

  it('a late-arriving OLDER takeover does not overwrite a newer handback', () => {
    const events = [
      ev('e-handback', 'ownership.handback', '2026-07-31T11:00:00Z'),
      ev('e-takeover', 'ownership.human_takeover', '2026-07-31T10:00:00Z'),
    ]
    const state = projectOwnership(events)
    expect(state.owner).toBe('ai')
    expect(state.lastEventId).toBe('e-handback')
  })

  it('a human reply takes ownership', () => {
    const state = projectOwnership([
      ev('a', 'ownership.ai', '2026-07-31T10:00:00Z'),
      ev('b', 'ownership.human_reply', '2026-07-31T10:05:00Z'),
    ])
    expect(state.owner).toBe('human')
  })

  it('channel health reports the latest verification', () => {
    const h = projectChannelHealth(
      [
        { ...ev('h1', 'channel.health', '2026-07-31T09:00:00Z'), payload: { status: 'failed' } },
        {
          ...ev('h2', 'channel.health', '2026-07-31T10:00:00Z'),
          payload: { status: 'healthy', detail: 'ok' },
        },
      ],
      'cb-1',
    )
    expect(h.status).toBe('healthy')
    expect(h.detail).toBe('ok')
    expect(h.lastVerifiedAt).toEqual(new Date('2026-07-31T10:00:00Z'))
  })

  it('an unrecognised health status reads as unknown, not healthy', () => {
    const h = projectChannelHealth(
      [{ ...ev('h', 'channel.health', '2026-07-31T10:00:00Z'), payload: { status: 'fine-ish' } }],
      'cb-1',
    )
    expect(h.status).toBe('unknown')
  })

  it('the feed is newest-first and scoped to one company', () => {
    const feed = projectActivityFeed(
      [
        ev('old', 'agent.response', '2026-07-31T09:00:00Z'),
        ev('new', 'agent.response', '2026-07-31T11:00:00Z'),
        { ...ev('other', 'agent.response', '2026-07-31T12:00:00Z'), companyId: 'co-2' },
      ],
      'co-1',
    )
    expect(feed.map((f) => f.eventId)).toEqual(['new', 'old'])
  })
})

describe('BOUNDARY — ingestion is a one-way door', () => {
  it('contains no send, retry or ownership COMMAND', () => {
    const src = readFileSync(join(__dirname, 'ingest.ts'), 'utf8')
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      // Strip string literals too. `ownership.human_takeover` is an event NAME —
      // a fact Lane 2 reports. The thing that must not exist is a CALL that
      // performs a takeover. Matching bare words would confuse data with verbs.
      .replace(/'[^']*'/g, "''")
      .replace(/"[^"]*"/g, '""')

    const forbiddenCalls =
      /\b(fetch|sendMessage|sendReply|retryDelivery|takeOver|forceHandback|resumeAi|replyTo)\s*\(/
    expect(code).not.toMatch(forbiddenCalls)
    expect(code).not.toMatch(/\bawait\s+(?:this\.)?send/i)
  })

  it('exposes no function that could act on a conversation', async () => {
    const mod = await import('./ingest')
    const actionShaped = Object.keys(mod).filter((k) =>
      /^(send|retry|reply|takeover|handback|resume|close|assign)/i.test(k),
    )
    expect(actionShaped).toEqual([])
  })
})
