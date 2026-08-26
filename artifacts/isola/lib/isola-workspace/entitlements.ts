/**
 * Isola Workspace — entitlement resolution.
 *
 * WHY THIS FILE HAD TO BE WRITTEN RATHER THAN REUSED
 * --------------------------------------------------
 * This repository has NO entitlement system and NO feature-flag system. Verified by
 * inspection 2026-08-06: there is no `Entitlement`, `Permission`, `Plan`, `Feature` or
 * `FeatureFlag` Prisma model; `Tenant.plan` (starter|growth|pro) is descriptive only and
 * nothing gates on it; `lib/plans.ts` holds display strings and prices with no enforcement.
 *
 * So an entitlement had to come from somewhere. There were three options:
 *
 *   (a) invent an `Entitlement` table — a schema change, which this increment is explicitly
 *       not authorized to make, and which would be guesswork about a commercial model the
 *       owner has not ratified;
 *   (b) gate on `Tenant.plan` alone — cheap, but a lie: a tenant on the `pro` plan whose
 *       phone service was never provisioned would be shown a Phone module full of empty
 *       states, which the design forbids ("connected is not the same as working");
 *   (c) DERIVE entitlement from observable, already-authoritative tenant state.
 *
 * This file does (c). An entitlement is granted when the tenant demonstrably HAS the thing:
 * telephony when a DID is actually provisioned, billing when a wallet actually exists. That
 * is honest, needs no migration, and degrades correctly — a half-provisioned tenant is not
 * entitled, which is the truthful answer.
 *
 * WHEN A REAL ENTITLEMENT MODEL LANDS, replace `deriveEntitlements` and delete nothing else.
 * Every consumer depends on the returned string set, not on how it was derived. That is the
 * point of isolating it here.
 *
 * This module is PURE — no Prisma import, no I/O — so it is testable under this app's
 * vitest `node` environment. The DB-touching read (`readTenantEntitlementFacts`, following
 * the repository's established pure-predicate + thin-entry-point pattern — see
 * `scripts/src/guard-not-prod-db.ts`) has not been written yet; this file is currently
 * exercised only through `fixtureEntitlements`, below, from the fixture preview route. Do not
 * cite an `entitlements.server.ts` file as existing until it does.
 */

import type { Entitlement } from './contracts'

// ── The entitlement vocabulary ──────────────────────────────────────────────

/**
 * Every entitlement Isola Workspace knows about. A module may only declare one of these;
 * `assertKnownEntitlements` enforces it so a typo becomes a registration failure rather
 * than a module that silently never appears for anyone.
 */
export const KNOWN_ENTITLEMENTS = [
  /** Always granted to an active tenant. Customer, Work and Today depend on it. */
  'core',
  /** The tenant has an AI workforce configured. */
  'ai-team',
  /** The tenant actually has provisioned voice service. */
  'telephony',
  /** The tenant actually has a money surface. */
  'billing',
] as const

export type KnownEntitlement = (typeof KNOWN_ENTITLEMENTS)[number]

export function assertKnownEntitlements(entitlements: readonly Entitlement[]): void {
  for (const e of entitlements) {
    if (!(KNOWN_ENTITLEMENTS as readonly string[]).includes(e)) {
      throw new Error(
        `Unknown entitlement "${e}". Add it to KNOWN_ENTITLEMENTS and to deriveEntitlements, ` +
          `or a module declaring it will be invisible to every tenant forever.`,
      )
    }
  }
}

// ── The observable facts entitlement is derived from ────────────────────────

/**
 * Deliberately narrow. Every field is something Foundation already holds and already
 * treats as authoritative. Nothing here is supplied by a browser.
 */
export interface TenantEntitlementFacts {
  /** `Tenant.status`. A suspended tenant is entitled to nothing. */
  status: string
  /** `Tenant.plan`. Descriptive today; retained so a future plan gate has a seam. */
  plan: string
  /** `Tenant.voice_provisioning_state` — 'completed' is the only state that counts. */
  voiceProvisioningState: string
  /** `Tenant.magnus_did_number` — a real, routable number, not an intention. */
  hasProvisionedDid: boolean
  /** A `Wallet` row exists for this tenant's identity. */
  hasWallet: boolean
  /** `Tenant.clawith_tenant_id` is set — the tenant is bound to the AI runtime. */
  hasClawithBinding: boolean
  /** At least one active `Agent` row. A binding with no agent is not an AI team. */
  activeAgentCount: number
}

// ── Derivation ──────────────────────────────────────────────────────────────

/**
 * Derive the entitlement set. DENY BY DEFAULT: every entitlement must be positively earned.
 *
 * A suspended tenant returns an EMPTY set — not even `core`. That is deliberate. Suspension
 * is a commercial stop, and the workspace should degrade to "no modules", which the shell
 * renders as an explained empty state, rather than showing a working Customer panel to a
 * business whose account is stopped.
 */
export function deriveEntitlements(facts: TenantEntitlementFacts): KnownEntitlement[] {
  if (facts.status !== 'active') return []

  const granted: KnownEntitlement[] = ['core']

  // AI team: bound to the runtime AND at least one live agent. Either alone is a
  // half-configured state that would render an empty module.
  if (facts.hasClawithBinding && facts.activeAgentCount > 0) {
    granted.push('ai-team')
  }

  // Telephony: provisioning actually completed AND a real DID exists. `voice_provisioning_state`
  // alone is insufficient — it can read 'completed' from an earlier partial run.
  if (facts.voiceProvisioningState === 'completed' && facts.hasProvisionedDid) {
    granted.push('telephony')
  }

  // Billing: a wallet exists. Money surfaces are never inferred from a plan name.
  if (facts.hasWallet) {
    granted.push('billing')
  }

  return granted
}

/**
 * The fixture-mode equivalent: an explicit entitlement list, validated.
 *
 * Used by the design scaffold and by tests so a tenant's entitlements can be stated
 * directly rather than reverse-engineered from synthetic facts. This IS reachable from a
 * request path today — the fixture preview route (`app/isola-workspace/preview/page.tsx`)
 * calls it directly — but that route is fixture-only, session-gated, and role-authorized
 * (`lib/isola-workspace/preview-authorization.ts`), and there is no other caller. When a real
 * `entitlements.server.ts` lands, it must derive entitlements from `deriveEntitlements`
 * (above) for any real tenant; this function must never be reachable from a non-fixture path.
 */
export function fixtureEntitlements(list: readonly string[]): KnownEntitlement[] {
  assertKnownEntitlements(list)
  return list as KnownEntitlement[]
}
