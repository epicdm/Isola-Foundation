import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildLane2Result } from '../channels/channel-binding'
import { ingestLane2Event, type IngestPorts, type Lane2Event } from '../events/ingest'

/**
 * The contract pack is EXECUTABLE. Fixtures are not validated against a copy of
 * the schema — they are run through the same functions production runs, so the
 * pack cannot drift away from the code it documents.
 */

const PACK = resolve(__dirname, '../../contracts/lane2/v1')
const FIXTURES = join(PACK, 'fixtures')

const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const names = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))

const ports: IngestPorts = {
  sourceIsTrusted: (s) => s === 'lane2',
  seen: async () => false,
  project: async () => {},
  now: () => new Date('2026-07-31T12:00:00Z'),
}

describe('Lane-2 contract pack — the pack exists and is complete', () => {
  it.each([
    'events.ingest.schema.json',
    'provisioning.channel.request.schema.json',
    'provisioning.channel.result.schema.json',
    'health.schema.json',
    'error.schema.json',
    'README.md',
  ])('ships %s', (file) => {
    expect(readFileSync(join(PACK, file), 'utf8').length).toBeGreaterThan(0)
  })

  it('every schema is valid JSON with an $id and a description', () => {
    for (const f of readdirSync(PACK).filter((x) => x.endsWith('.schema.json'))) {
      const schema = JSON.parse(readFileSync(join(PACK, f), 'utf8'))
      expect(schema.$id, f).toContain('/contracts/lane2/v1/')
      expect(String(schema.description ?? '').length, f).toBeGreaterThan(20)
    }
  })

  it('ships both valid and invalid fixtures', () => {
    expect(names.some((n) => n.includes('.valid.'))).toBe(true)
    expect(names.some((n) => n.includes('.invalid.'))).toBe(true)
  })
})

describe('Lane-2 contract pack — valid event fixtures are ACCEPTED by the real validator', () => {
  const valid = names.filter((n) => n.startsWith('event.valid.'))

  it('has valid event fixtures to run', () => {
    expect(valid.length).toBeGreaterThan(0)
  })

  it.each(valid)('%s is accepted', async (name) => {
    const r = await ingestLane2Event(load(name) as Lane2Event, ports)
    expect(r.accepted, JSON.stringify(r)).toBe(true)
  })
})

describe('Lane-2 contract pack — invalid event fixtures are REFUSED for the stated reason', () => {
  const invalid = names.filter((n) => n.startsWith('event.invalid.'))

  it('has invalid event fixtures to run', () => {
    expect(invalid.length).toBeGreaterThan(0)
  })

  it.each(invalid)('%s is refused', async (name) => {
    const fixture = load(name)
    const expected = fixture._expectedRejection
    expect(expected, `${name} must declare _expectedRejection`).toBeTruthy()
    const r = await ingestLane2Event(fixture as Lane2Event, ports)
    expect(r.accepted).toBe(false)
    if (!r.accepted) expect(r.rejection).toBe(expected)
  })
})

describe('Lane-2 contract pack — provisioning result fixtures', () => {
  it('a valid result is recorded', () => {
    const f = load('provisioning.result.valid.json')
    const r = buildLane2Result({
      existingClassification: 'internal_private',
      status: f.status,
      providerRef: f.providerRef,
      inboxRef: f.inboxRef,
      agentRef: f.agentRef,
      contractVersion: f.contractVersion,
      readiness: f.readiness,
      health: f.health,
      chatwootDeepLink: f.chatwootDeepLink,
      echoedClassification: f.echoedClassification,
    })
    expect(r.ok).toBe(true)
  })

  it.each(names.filter((n) => n.startsWith('provisioning.result.invalid.')))(
    '%s is refused for the stated reason',
    (name) => {
      const f = load(name)
      const r = buildLane2Result({
        existingClassification: f._existingClassification,
        status: f.status,
        providerRef: f.providerRef ?? null,
        contractVersion: f.contractVersion,
        echoedClassification: f.echoedClassification ?? null,
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.refusal).toBe(f._expectedRejection)
    },
  )
})

describe('Lane-2 contract pack — the boundary is stated, not implied', () => {
  it('publishes NO schema for sending messages or running agent turns', () => {
    const files = readdirSync(PACK).join(' ')
    expect(files).not.toMatch(/messaging\.send/)
    expect(files).not.toMatch(/agent\.turn/)
    expect(files).not.toMatch(/agentbot/i)
  })

  it('the README says who runs the message', () => {
    const readme = readFileSync(join(PACK, 'README.md'), 'utf8')
    expect(readme).toMatch(/Lane 2 runs the message and the agent turn/)
  })
})
