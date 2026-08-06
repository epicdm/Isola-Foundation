import { describe, expect, it } from 'vitest'

import {
  assertValidDescriptor,
  ModuleRegistrationError,
  PINNED_MODULE_IDS,
  type ModuleDescriptor,
  type WorkspaceContext,
} from './contracts'
import { defaultRegistry } from './modules'
import {
  annotateAuthorization,
  buildNavigationLayout,
  ModuleRegistry,
  resolveNavigation,
  selectEntitledModules,
} from './registry'

// ── Helpers ─────────────────────────────────────────────────────────────────

function descriptor(over: Partial<ModuleDescriptor> = {}): ModuleDescriptor {
  return {
    id: 'test-module',
    version: '1.0.0',
    label: 'Test',
    purpose: 'A module used only by tests.',
    icon: 'user',
    contexts: ['conversation-panel'],
    entitlements: [],
    permissions: [],
    bindings: [{ kind: 'tenant', required: true }],
    priority: 999,
    pinned: false,
    governedActions: [],
    ...over,
  }
}

function context(over: Partial<WorkspaceContext> = {}): WorkspaceContext {
  return {
    tenant: { id: 'epic', name: 'EPIC Communications' },
    actor: { id: 'u1', name: 'Eric Giraud', role: 'manager' },
    context: 'conversation-panel',
    conversation: { accountId: 5, inboxId: 46, conversationDisplayId: 131 },
    customerMatches: 1,
    entitlements: ['core', 'ai-team', 'telephony', 'billing'],
    permissions: [
      'customer.read',
      'work.read',
      'ai.consult',
      'today.read',
      'phone.read',
      'billing.read',
    ],
    ...over,
  }
}

// ── Registration ────────────────────────────────────────────────────────────

describe('module registration', () => {
  it('accepts a well-formed descriptor', () => {
    expect(() => new ModuleRegistry().register(descriptor())).not.toThrow()
  })

  it('rejects a label too long for a pinned tab', () => {
    expect(() => assertValidDescriptor(descriptor({ label: 'Extraordinarily Long' }))).toThrow(
      ModuleRegistrationError,
    )
  })

  it('rejects a non-reference module that tries to pin itself into the tab bar', () => {
    // This is the mechanism that stops navigation growing when a service is added.
    expect(() =>
      assertValidDescriptor(descriptor({ id: 'insurance', pinned: true })),
    ).toThrow(/only customer, work, ai-team, today may be pinned/)
  })

  it('rejects a governed action with no consequence', () => {
    expect(() =>
      assertValidDescriptor(
        descriptor({
          governedActions: [
            {
              id: 'x.do',
              label: 'Do it',
              consequence: '',
              requiresApproval: true,
              owningSystem: 'salesRecords',
              readback: 'read back',
              reversible: false,
            },
          ],
        }),
      ),
    ).toThrow(/no consequence/)
  })

  it('rejects a governed action with no readback', () => {
    expect(() =>
      assertValidDescriptor(
        descriptor({
          governedActions: [
            {
              id: 'x.do',
              label: 'Do it',
              consequence: 'Something changes.',
              requiresApproval: true,
              owningSystem: 'salesRecords',
              readback: '',
              reversible: false,
            },
          ],
        }),
      ),
    ).toThrow(/no readback/)
  })

  it('rejects a duplicate registration', () => {
    const r = new ModuleRegistry().register(descriptor())
    expect(() => r.register(descriptor())).toThrow(/already registered/)
  })

  it('every shipped module satisfies the contract', () => {
    expect(() => defaultRegistry()).not.toThrow()
    expect(defaultRegistry().size).toBe(6)
  })
})

// ── Stage 1: entitlement ────────────────────────────────────────────────────

describe('entitlement filtering (server-side)', () => {
  it('REMOVES a module the tenant is not entitled to', () => {
    const result = selectEntitledModules(defaultRegistry().all(), {
      entitlements: ['core'],
      context: 'conversation-panel',
    })
    const ids = result.map((m) => m.id)

    // Absent entitlement => the module does not exist for this tenant. Not listed, not
    // discoverable. Which products a business has not bought is that business's information.
    expect(ids).not.toContain('phone')
    expect(ids).not.toContain('billing')
    expect(ids).not.toContain('ai-team')
    expect(ids).toContain('customer')
  })

  it('includes a module once its entitlement is granted', () => {
    const ids = selectEntitledModules(defaultRegistry().all(), {
      entitlements: ['core', 'telephony'],
      context: 'conversation-panel',
    }).map((m) => m.id)

    expect(ids).toContain('phone')
    expect(ids).not.toContain('billing')
  })

  it('filters by context — a workspace-only surface excludes panel-only modules', () => {
    const ids = selectEntitledModules(defaultRegistry().all(), {
      entitlements: ['core', 'ai-team', 'telephony', 'billing'],
      context: 'workspace',
    }).map((m) => m.id)

    expect(ids).toEqual(['work', 'today'])
    expect(ids).not.toContain('customer')
  })

  it('treats a module naming an absent feature flag as unentitled', () => {
    const flagged = descriptor({ id: 'beta-thing', featureFlag: 'beta' })
    const r = new ModuleRegistry().register(flagged)

    expect(
      selectEntitledModules(r.all(), { entitlements: [], context: 'conversation-panel' }),
    ).toHaveLength(0)

    expect(
      selectEntitledModules(r.all(), {
        entitlements: [],
        context: 'conversation-panel',
        enabledFeatureFlags: ['beta'],
      }),
    ).toHaveLength(1)
  })
})

// ── Stage 2: permission ─────────────────────────────────────────────────────

describe('permission filtering (render-time)', () => {
  it('KEEPS an entitled module the actor may not use, and marks it unauthorized', () => {
    // The operator must learn that Billing exists and is for managers, so they can escalate
    // instead of being stuck. Dropping it here would be the bug.
    const entitled = selectEntitledModules(defaultRegistry().all(), {
      entitlements: ['core', 'billing'],
      context: 'conversation-panel',
    })
    const available = annotateAuthorization(entitled, ['customer.read', 'work.read', 'today.read'])
    const billing = available.find((m) => m.descriptor.id === 'billing')

    expect(billing).toBeDefined()
    expect(billing!.authorized).toBe(false)
    expect(billing!.missingPermissions).toEqual(['billing.read'])
  })

  it('marks a module authorized when every declared permission is held', () => {
    const entitled = selectEntitledModules(defaultRegistry().all(), {
      entitlements: ['core', 'billing'],
      context: 'conversation-panel',
    })
    const available = annotateAuthorization(entitled, ['customer.read', 'work.read', 'today.read', 'billing.read'])

    expect(available.find((m) => m.descriptor.id === 'billing')!.authorized).toBe(true)
  })

  it('entitlement-absent and permission-denied are DIFFERENT outcomes', () => {
    // The single most important distinction in the authorization model.
    const notEntitled = selectEntitledModules(defaultRegistry().all(), {
      entitlements: ['core'],
      context: 'conversation-panel',
    })
    expect(notEntitled.some((m) => m.id === 'billing')).toBe(false)

    const entitledNotPermitted = annotateAuthorization(
      selectEntitledModules(defaultRegistry().all(), {
        entitlements: ['core', 'billing'],
        context: 'conversation-panel',
      }),
      ['customer.read'],
    )
    expect(entitledNotPermitted.some((m) => m.descriptor.id === 'billing')).toBe(true)
  })
})

// ── Navigation ──────────────────────────────────────────────────────────────

describe('navigation layout', () => {
  it('never grows the top-level navigation when a service is added', () => {
    const withoutServices = resolveNavigation(defaultRegistry(), context({ entitlements: ['core'] }))
    const withServices = resolveNavigation(defaultRegistry(), context())

    const pinnedIds = (n: typeof withServices) => n.pinned.map((m) => m.descriptor.id)

    // Adding telephony + billing + ai-team changes ONLY the overflow sheet.
    expect(withServices.overflowCount).toBeGreaterThan(withoutServices.overflowCount)
    expect(pinnedIds(withServices).every((id) => (PINNED_MODULE_IDS as readonly string[]).includes(id))).toBe(true)
    expect(pinnedIds(withoutServices).every((id) => (PINNED_MODULE_IDS as readonly string[]).includes(id))).toBe(true)
  })

  it('puts every non-pinned module behind More, never in a tab', () => {
    const nav = resolveNavigation(defaultRegistry(), context())
    expect(nav.overflow.map((m) => m.descriptor.id).sort()).toEqual(['billing', 'phone'])
    expect(nav.pinned.map((m) => m.descriptor.id)).toEqual(['customer', 'work', 'ai-team', 'today'])
  })

  it('hides the More badge when there is nothing behind it', () => {
    const nav = resolveNavigation(defaultRegistry(), context({ entitlements: ['core'] }))
    expect(nav.overflowCount).toBe(0)
  })

  it('never renders more than four pinned tabs', () => {
    const nav = resolveNavigation(defaultRegistry(), context())
    expect(nav.pinned.length).toBeLessThanOrEqual(4)
  })

  it('refuses to honour a requested module the tenant is not entitled to', () => {
    // A URL naming an unentitled module must not reveal that the module exists.
    const nav = resolveNavigation(
      defaultRegistry(),
      context({ entitlements: ['core'] }),
      'billing',
    )
    expect(nav.activeModuleId).toBe('customer')
  })

  it('honours a requested module the tenant IS entitled to', () => {
    const nav = resolveNavigation(defaultRegistry(), context(), 'phone')
    expect(nav.activeModuleId).toBe('phone')
  })

  it('still selects an unauthorized module so its explanation can render', () => {
    // Permission denial must produce a rendered `unauthorized` body, not a silent redirect.
    const nav = resolveNavigation(
      defaultRegistry(),
      context({ permissions: ['customer.read', 'work.read', 'today.read'] }),
      'billing',
    )
    expect(nav.activeModuleId).toBe('billing')
    expect(nav.all.find((m) => m.descriptor.id === 'billing')!.authorized).toBe(false)
  })

  it('hides a conversation-bound module in the panel when no conversation is in scope', () => {
    const nav = resolveNavigation(defaultRegistry(), context({ conversation: null }))
    expect(nav.all.map((m) => m.descriptor.id)).not.toContain('customer')
  })

  it('keeps the same module available in the full workspace without a conversation', () => {
    const nav = resolveNavigation(
      defaultRegistry(),
      context({ conversation: null, context: 'workspace' }),
    )
    expect(nav.all.map((m) => m.descriptor.id)).toContain('work')
  })

  it('throws rather than silently rendering a fifth pinned tab', () => {
    const five = [...PINNED_MODULE_IDS, 'customer'].map((id, i) =>
      annotateAuthorization([descriptor({ id: `${id}-${i}`, pinned: false })], [])[0],
    )
    // Force the pinned flag past the descriptor guard to prove the layout guard also holds.
    const forced = five.map((m) => ({
      ...m,
      descriptor: { ...m.descriptor, id: PINNED_MODULE_IDS[0] },
    }))
    expect(() => buildNavigationLayout([...forced, ...forced])).toThrow(/pinned tabs/)
  })
})

// ── Failure isolation ───────────────────────────────────────────────────────

describe('module failure isolation', () => {
  it('a module that fails registration does not prevent the others from registering', () => {
    const r = new ModuleRegistry()
    r.register(descriptor({ id: 'good-one' }))
    expect(() => r.register(descriptor({ id: 'Bad Id!' }))).toThrow()
    r.register(descriptor({ id: 'good-two' }))

    expect(r.all().map((m) => m.id)).toEqual(['good-one', 'good-two'])
  })
})
