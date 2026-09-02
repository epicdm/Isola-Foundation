import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  buildChannelRequest,
  buildLane2Result,
  isProviderSafe,
  CHANNEL_CLASSIFICATIONS,
} from './channel-binding'

const REQ = {
  tenantId: 't-1',
  purpose: 'customer front desk',
  requestedType: 'whatsapp',
  classification: 'customer_facing',
  requestedBy: 'user-1',
}

describe('channel request — Foundation records intent, nothing else', () => {
  it('records the request and defaults approval_required to TRUE', () => {
    const r = buildChannelRequest(REQ)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.approval_required).toBe(true)
    expect(r.value.provisioning_status).toBe('requested')
    expect(r.value.readiness).toBe('not_ready')
    expect(r.value.health).toBe('unknown')
  })

  it('requires an explicit classification - it is never inferred', () => {
    const r = buildChannelRequest({ ...REQ, classification: '' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.refusal).toBe('unknown_classification')
    expect(CHANNEL_CLASSIFICATIONS).toContain('internal_private')
  })

  it('refuses an unknown channel type', () => {
    const r = buildChannelRequest({ ...REQ, requestedType: 'carrier_pigeon' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal).toBe('unknown_type')
  })

  it('refuses a credential smuggled in as an agent reference', () => {
    const r = buildChannelRequest({
      ...REQ,
      clawithAgentRef: 'EAAG' + 'x'.repeat(40),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal).toBe('secret_shaped_value')
  })
})

describe('Lane 2 result — recorded, never trusted with classification', () => {
  const base = { existingClassification: 'internal_private', status: 'ready' }

  it('records provider-safe references, links and health', () => {
    const r = buildLane2Result({
      ...base,
      providerRef: 'pn_01H8',
      inboxRef: 'inbox_46',
      chatwootDeepLink: 'https://inbox.epic.dm/app/accounts/1/conversations/9',
      health: 'healthy',
      readiness: 'ready',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.provider_ref).toBe('pn_01H8')
    expect(r.value.inbox_ref).toBe('inbox_46')
    expect(r.value.health).toBe('healthy')
  })

  it('REFUSES to let Lane 2 reclassify an internal channel as customer-facing', () => {
    const r = buildLane2Result({ ...base, echoedClassification: 'customer_facing' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal).toBe('classification_immutable')
  })

  it('accepts a matching echoed classification', () => {
    const r = buildLane2Result({ ...base, echoedClassification: 'internal_private' })
    expect(r.ok).toBe(true)
  })

  it('refuses an unknown provisioning status rather than storing it', () => {
    const r = buildLane2Result({ ...base, status: 'probably_fine' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal).toBe('unknown_status')
  })

  it.each([
    ['meta token', 'EAAG' + 'y'.repeat(40)],
    ['github token', 'ghp_' + 'z'.repeat(36)],
    ['openai key', 'sk-' + 'a'.repeat(32)],
    ['bearer header', 'Bearer abc.def.ghi'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'],
    ['self-labelled secret', 'x-isola-secret=hunter2'],
  ])('refuses a %s in provider_ref', (_label, value) => {
    const r = buildLane2Result({ ...base, providerRef: value })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal).toBe('secret_shaped_value')
  })

  it('refuses anything too long to be an identifier', () => {
    expect(isProviderSafe('a'.repeat(201)).safe).toBe(false)
    expect(isProviderSafe('a'.repeat(199)).safe).toBe(true)
  })
})

describe('BOUNDARY — this module must never talk to a provider', () => {
  it('contains no network call and no provider hostname', () => {
    const src = readFileSync(join(__dirname, 'channel-binding.ts'), 'utf8')
    // Strip the doc comments, which legitimately mention the providers by name.
    const code = src.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/\bfetch\s*\(/)
    expect(code).not.toMatch(/graph\.facebook\.com/)
    expect(code).not.toMatch(/agents\.epic\.dm/)
    expect(code).not.toMatch(/https?:\/\//)
  })
})
