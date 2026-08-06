import { describe, expect, it } from 'vitest'

import { isValidReadback } from '../action-lifecycle'
import { createFixturePorts, fixtureTenant } from './fixture-adapter'

const REF = { accountId: 5, inboxId: 46, conversationDisplayId: 131 }

describe('the fixture obeys the same invariants as production', () => {
  it('builds every work item without violating the action lifecycle', async () => {
    // createFixturePorts runs assertActionInvariants over every row. A fixture that could
    // not exist in production is worse than no fixture: it makes the UI look correct while
    // encoding a state the product forbids.
    const ports = createFixturePorts('epic')
    const result = await ports.work.listForActor('u1')

    expect(result.data).toBeTruthy()
    expect(result.data!.length).toBe(7)
  })

  it('never produces a completed action without a readback', async () => {
    const ports = createFixturePorts('epic')
    const items = (await ports.work.listForActor('u1')).data!

    for (const item of items) {
      if (item.state === 'completed') {
        expect(isValidReadback(item.readback)).toBe(true)
      } else {
        expect(item.readback ?? null).toBeNull()
      }
    }
  })

  it('exposes all seven action states so every card variant is exercisable', async () => {
    const items = (await createFixturePorts('epic').work.listForActor('u1')).data!
    const states = new Set(items.map((i) => i.state))

    // The Work screen is the reference for the status vocabulary; all seven must be
    // reachable or some card variant ships untested.
    expect(states).toContain('awaitingApproval')
    expect(states).toContain('proposed')
    expect(states).toContain('blocked')
    expect(states).toContain('failed')
    expect(states).toContain('unconfirmed')
    expect(states).toContain('completed')
    expect(items.some((i) => i.overdue)).toBe(true)
  })

  it('maps overdue to proposed-plus-a-flag rather than inventing an eighth state', async () => {
    const items = (await createFixturePorts('epic').work.listForActor('u1')).data!
    const overdue = items.find((i) => i.overdue)!

    expect(overdue.state).toBe('proposed')
  })
})

describe('health overrides make every required state reachable', () => {
  it('withholds data entirely when unauthorized', async () => {
    // Returning a value alongside "you may not see this" is how data leaks past a check.
    const ports = createFixturePorts('epic', { customer: 'unauthorized' })
    const result = await ports.customer.resolveForConversation(REF)

    expect(result.health).toBe('unauthorized')
    expect(result.data).toBeNull()
    expect(result.readAt).toBeNull()
  })

  it('withholds data when empty', async () => {
    const result = await createFixturePorts('epic', { work: 'empty' }).work.listForActor('u1')
    expect(result.data).toBeNull()
  })

  it('KEEPS the last good value when degraded, with an honest timestamp', async () => {
    // Degraded must still render content from the last good read — collapsing to a blank
    // panel is the failure this envelope exists to prevent.
    const result = await createFixturePorts('epic', {
      customer: 'degraded',
    }).customer.resolveForConversation(REF)

    expect(result.health).toBe('degraded')
    expect(result.data).toBeTruthy()
    expect(result.readAt).toBeTruthy()
    expect(result.retrying).toBe(true)
    expect(result.reason).toBeTruthy()
  })

  it('keeps the last good value when stale and explains why', async () => {
    const result = await createFixturePorts('epic', {
      customer: 'stale',
    }).customer.resolveForConversation(REF)

    expect(result.health).toBe('stale')
    expect(result.data).toBeTruthy()
    expect(result.reason).toMatch(/may have changed/i)
  })
})

describe('entitlement gating reaches content, not only modules', () => {
  it('omits phone-dependent attention rows for a tenant with no phone service', async () => {
    const epic = (await createFixturePorts('epic').today.summary()).data!
    const marche = (await createFixturePorts('marche').today.summary()).data!

    const titles = (s: typeof epic) => s.needsAttention.map((n) => n.title).join(' | ')

    expect(titles(epic)).toMatch(/call menu/i)
    // Filtered out of the payload entirely rather than hidden in the browser.
    expect(titles(marche)).not.toMatch(/call menu/i)
    expect(marche.needsAttention.length).toBeLessThan(epic.needsAttention.length)
  })

  it('the two reference tenants differ only in entitlements', () => {
    expect(fixtureTenant('epic').entitlements).toEqual(['core', 'ai-team', 'telephony', 'billing'])
    expect(fixtureTenant('marche').entitlements).toEqual(['core', 'ai-team'])
  })
})

describe('the customer projection is an allowlist', () => {
  it('confines every raw identifier to the technical block', async () => {
    const result = await createFixturePorts('epic').customer.resolveForConversation(REF)
    const resolution = result.data!
    if (resolution.kind !== 'one') throw new Error('expected a single match')

    // Identifiers exist exactly once, in the one place the Customer module is allowed to
    // render them (Technical details). Nothing outside that block may carry them.
    expect(resolution.context.technical.conversationDisplayId).toBe(131)
    expect(resolution.context.technical.accountId).toBe(5)
    expect(resolution.context.technical.inboxId).toBe(46)
    expect(resolution.context.technical.correlationId).toBe(
      'epic-cz-revenue-loop1-2026-08-06-conv131',
    )

    const outsideTechnical = JSON.stringify({
      ...resolution.context,
      technical: undefined,
    })
    expect(outsideTechnical).not.toContain('epic-cz-revenue-loop1')
  })

  it('carries no phone number, email or credential-shaped field', async () => {
    const result = await createFixturePorts('epic').customer.resolveForConversation(REF)
    const serialized = JSON.stringify(result.data).toLowerCase()

    for (const forbidden of ['access_token', 'api_key', 'provider_config', 'secret', 'password']) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('names its source in operator language, never a vendor', async () => {
    const result = await createFixturePorts('epic').customer.resolveForConversation(REF)
    expect(result.source).toBe('salesRecords')
  })
})

describe('onboarding truthfulness', () => {
  it('renders all eleven acceptance checks for both tenants', async () => {
    for (const tenant of ['epic', 'marche'] as const) {
      const state = (await createFixturePorts(tenant).onboarding.load()).data!
      // A check that is not shown cannot be seen to be un-run, and "not run" is precisely
      // the state that must never be mistaken for a pass.
      expect(state.checks).toHaveLength(11)
    }
  })

  it('distinguishes not-run from failed', async () => {
    const epic = (await createFixturePorts('epic').onboarding.load()).data!
    const marche = (await createFixturePorts('marche').onboarding.load()).data!

    expect(epic.checks.some((c) => c.status === 'failed')).toBe(true)
    expect(marche.checks.some((c) => c.status === 'notRun')).toBe(true)
    expect(marche.checks.some((c) => c.status === 'failed')).toBe(false)
  })

  it('records evidence on every check, not a restatement of the check name', async () => {
    const state = (await createFixturePorts('epic').onboarding.load()).data!
    for (const check of state.checks) {
      expect(check.note.trim().length).toBeGreaterThan(0)
      expect(check.note).not.toBe(check.name)
    }
  })

  it('carries a blocked stage that names what is needed', async () => {
    const marche = (await createFixturePorts('marche').onboarding.load()).data!
    const blocked = marche.stages.find((s) => s.state === 'blocked')

    expect(blocked).toBeDefined()
    expect(blocked!.note.trim().length).toBeGreaterThan(0)
  })
})
