import { describe, expect, it } from 'vitest'

import {
  assertKnownEntitlements,
  deriveEntitlements,
  fixtureEntitlements,
  KNOWN_ENTITLEMENTS,
  type TenantEntitlementFacts,
} from './entitlements'
import {
  holdsAll,
  KNOWN_PERMISSIONS,
  PERMISSIONS_BY_ROLE,
  permissionsForRole,
  toWorkspaceRole,
} from './permissions'
import { ALL_MODULE_DESCRIPTORS } from './modules'

function facts(over: Partial<TenantEntitlementFacts> = {}): TenantEntitlementFacts {
  return {
    status: 'active',
    plan: 'growth',
    voiceProvisioningState: 'completed',
    hasProvisionedDid: true,
    hasWallet: true,
    hasClawithBinding: true,
    activeAgentCount: 2,
    ...over,
  }
}

describe('entitlement derivation is deny-by-default', () => {
  it('grants nothing at all to a suspended tenant', () => {
    // Not even `core`. Suspension is a commercial stop; the workspace degrades to an
    // explained empty state rather than working normally for a stopped business.
    expect(deriveEntitlements(facts({ status: 'suspended' }))).toEqual([])
  })

  it('always grants core to an active tenant', () => {
    expect(deriveEntitlements(facts({ hasWallet: false, hasClawithBinding: false }))).toContain(
      'core',
    )
  })

  it('grants telephony only when provisioning completed AND a real number exists', () => {
    expect(deriveEntitlements(facts())).toContain('telephony')

    // A state that reads 'completed' from an earlier partial run is not enough.
    expect(deriveEntitlements(facts({ hasProvisionedDid: false }))).not.toContain('telephony')
    expect(deriveEntitlements(facts({ voiceProvisioningState: 'pending' }))).not.toContain(
      'telephony',
    )
  })

  it('grants ai-team only when bound to the runtime AND at least one live agent exists', () => {
    expect(deriveEntitlements(facts())).toContain('ai-team')
    expect(deriveEntitlements(facts({ activeAgentCount: 0 }))).not.toContain('ai-team')
    expect(deriveEntitlements(facts({ hasClawithBinding: false }))).not.toContain('ai-team')
  })

  it('never infers billing from a plan name', () => {
    expect(deriveEntitlements(facts({ plan: 'pro', hasWallet: false }))).not.toContain('billing')
    expect(deriveEntitlements(facts({ plan: 'starter', hasWallet: true }))).toContain('billing')
  })

  it('rejects an unknown entitlement rather than letting a typo hide a module forever', () => {
    expect(() => assertKnownEntitlements(['telephony'])).not.toThrow()
    expect(() => assertKnownEntitlements(['telephony ', 'billling'])).toThrow(/Unknown entitlement/)
  })

  it('validates fixture entitlements through the same gate', () => {
    expect(fixtureEntitlements(['core', 'ai-team'])).toEqual(['core', 'ai-team'])
    expect(() => fixtureEntitlements(['core', 'nonsense'])).toThrow()
  })
})

describe('permission mapping', () => {
  it('maps Foundation access levels onto the operator-facing roles', () => {
    expect(toWorkspaceRole('owner')).toBe('admin')
    expect(toWorkspaceRole('manager')).toBe('manager')
  })

  it('gives a denied actor NO role — not a reduced one', () => {
    // `denied` is a person with no business in this tenant's workspace, which the shell
    // renders as a shell-level unauthorized rather than an empty module list.
    expect(toWorkspaceRole('denied')).toBeNull()
    expect(permissionsForRole(toWorkspaceRole('denied'))).toEqual([])
  })

  it('withholds money, team view, routing and setup from an operator', () => {
    const operator = PERMISSIONS_BY_ROLE.operator
    expect(operator).not.toContain('billing.read')
    expect(operator).not.toContain('billing.approve-credit')
    expect(operator).not.toContain('today.read.team')
    expect(operator).not.toContain('phone.update-routing')
    expect(operator).not.toContain('onboarding.manage')
  })

  it('still gives an operator their own work and the customer in front of them', () => {
    // The narrowest tier must not be a useless tier.
    expect(PERMISSIONS_BY_ROLE.operator).toEqual(
      expect.arrayContaining(['customer.read', 'work.read', 'today.read', 'ai.consult']),
    )
  })

  it('reserves onboarding for admin', () => {
    expect(PERMISSIONS_BY_ROLE.admin).toContain('onboarding.manage')
    expect(PERMISSIONS_BY_ROLE.manager).not.toContain('onboarding.manage')
  })

  it('holdsAll requires every permission, not any', () => {
    expect(holdsAll(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(holdsAll(['a'], ['a', 'b'])).toBe(false)
    expect(holdsAll([], [])).toBe(true)
  })
})

describe('the registry and the vocabulary agree', () => {
  it('every entitlement a shipped module declares is a known entitlement', () => {
    for (const m of ALL_MODULE_DESCRIPTORS) {
      expect(() => assertKnownEntitlements(m.entitlements)).not.toThrow()
    }
  })

  it('every permission a shipped module declares is a known permission', () => {
    for (const m of ALL_MODULE_DESCRIPTORS) {
      for (const p of m.permissions) {
        expect(KNOWN_PERMISSIONS as readonly string[]).toContain(p)
      }
    }
  })

  it('every known entitlement is actually reachable from real tenant facts', () => {
    // Guards against declaring an entitlement no derivation can ever grant, which would
    // make its modules permanently invisible.
    const everything = deriveEntitlements(facts())
    for (const e of KNOWN_ENTITLEMENTS) {
      expect(everything).toContain(e)
    }
  })

  it('a manager can reach every non-admin module the fully-entitled tenant has', () => {
    const managerPerms = permissionsForRole('manager')
    const reachable = ALL_MODULE_DESCRIPTORS.filter((m) => holdsAll(managerPerms, m.permissions))
    expect(reachable.map((m) => m.id).sort()).toEqual(
      ['ai-team', 'billing', 'customer', 'phone', 'today', 'work'].sort(),
    )
  })

  it('an operator is denied exactly billing, and nothing else', () => {
    const operatorPerms = permissionsForRole('operator')
    const denied = ALL_MODULE_DESCRIPTORS.filter((m) => !holdsAll(operatorPerms, m.permissions))
    expect(denied.map((m) => m.id)).toEqual(['billing'])
  })
})
