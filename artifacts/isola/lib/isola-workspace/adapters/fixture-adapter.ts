/**
 * Isola Workspace — the fixture adapter.
 *
 * Implements every port in `ports.ts` from `../fixtures/sample-data.json`. This is what
 * makes the whole design buildable and its states exercisable before a single real
 * integration exists.
 *
 * WHY A FIXTURE ADAPTER IS NOT A SHORTCUT
 * ---------------------------------------
 * The live read path is GATED, not merely unbuilt: owner ruling D8 requires
 * `defect-chatwoot-platformapp-token-harvest-path-2026-07-25` (P0, Open) to close before ANY
 * new Chatwoot API consumer exists. Building the UI against fixtures is therefore the only
 * lawful way to make progress, and it is also the better way: the fourteen required states —
 * degraded, stale, unconfirmed, multiple-matches, unauthorized — are all reachable on demand
 * here, whereas against a healthy live system most of them are unreachable and would ship
 * untested.
 *
 * `sample-data.json` is INVENTED. It contains no real credential, token, phone number or
 * customer data, and must stay that way.
 *
 * SWAPPING IN THE REAL ADAPTER changes this file and nothing else. Every consumer depends on
 * the port interfaces.
 */

import type { ActionState, SourceRef } from '../contracts'
import {
  assertActionInvariants,
  type GovernedActionInstance,
  type Readback,
} from '../action-lifecycle'
import type {
  AiEmployee,
  AiTeamPort,
  CustomerPort,
  CustomerResolution,
  InternalSuggestion,
  OnboardingPort,
  OnboardingStage,
  OnboardingState,
  PortHealth,
  PortResult,
  TodayPort,
  TodaySummary,
  VerificationCheck,
  WorkPort,
  WorkspacePorts,
} from './ports'
import sampleData from '../fixtures/sample-data.json'

// ── Fixture tenants ─────────────────────────────────────────────────────────

export type FixtureTenantId = 'epic' | 'marche'

/**
 * The two reference tenants. `epic` holds every entitlement; `marche` holds messaging and AI
 * only. Switching between them is the proof case: only module availability and module
 * CONTENT change. Navigation and layout are identical.
 */
export function fixtureTenant(id: FixtureTenantId) {
  const t = sampleData.tenants.find((x) => x.id === id)
  if (!t) throw new Error(`Unknown fixture tenant "${id}"`)
  return t
}

// ── Health simulation ───────────────────────────────────────────────────────

/**
 * Every port takes an optional health override so a caller can drive any state on demand.
 *
 * This exists so the state gallery and the tests can reach `degraded`, `stale`,
 * `unauthorized` and `empty` deterministically. Without it those states would only be
 * reachable by breaking a real dependency, which is exactly why they usually ship untested.
 */
export interface FixtureHealthOverrides {
  customer?: PortHealth
  work?: PortHealth
  aiTeam?: PortHealth
  today?: PortHealth
  onboarding?: PortHealth
}

const READ_AT = '2026-08-06T09:14:00-04:00'

function envelope<T>(
  data: T,
  source: SourceRef,
  health: PortHealth = 'ok',
  reason?: string,
): PortResult<T> {
  // unauthorized and empty carry NO data. Returning a value alongside either would let a
  // careless consumer render content it was told it may not have — the failure mode this
  // envelope exists to prevent.
  const withholds = health === 'unauthorized' || health === 'empty'
  return {
    health,
    data: withholds ? null : data,
    readAt: withholds ? null : READ_AT,
    source,
    reason,
    retrying: health === 'degraded' ? true : undefined,
  }
}

// ── Action mapping ──────────────────────────────────────────────────────────

/**
 * Map the fixture's presentation vocabulary onto the seven canonical action states.
 *
 * The fixture (written from the design's ActionCard VARIANT list) uses `overdue` and `done`.
 * Neither is a state:
 *   - `overdue` is a `proposed` action whose due date has passed — lateness is a fact about
 *     the clock, not about what happened to the request.
 *   - `done` is `completed`, which additionally REQUIRES a readback to exist at all.
 * Doing this mapping here, once, keeps the canonical state machine honest rather than
 * widening it to accommodate a fixture's shorthand.
 */
function toActionState(fixtureState: string): { state: ActionState; overdue: boolean } {
  switch (fixtureState) {
    case 'overdue':
      return { state: 'proposed', overdue: true }
    case 'todo':
      return { state: 'proposed', overdue: false }
    case 'done':
      return { state: 'completed', overdue: false }
    default:
      return { state: fixtureState as ActionState, overdue: false }
  }
}

function toReadback(statement: string | undefined, system: SourceRef): Readback | null {
  if (!statement) return null
  return { system, statement, readAt: READ_AT }
}

type FixtureWorkItem = (typeof sampleData.work)[number] & Record<string, unknown>

function toGovernedAction(raw: FixtureWorkItem): GovernedActionInstance {
  const { state, overdue } = toActionState(String(raw.state))
  const requestedBy = (raw.requestedBy ?? { name: 'Atlas', kind: 'ai', role: 'AI assistant' }) as {
    name: string
    kind: 'ai' | 'human'
  }

  const action: GovernedActionInstance = {
    id: String(raw.id),
    title: String(raw.title),
    subtitle: raw.summary ? String(raw.summary) : undefined,
    state,
    overdue,
    requestedBy: { name: requestedBy.name, kind: requestedBy.kind },
    consequence: String(
      raw.consequence ??
        // Every governed action must state its consequence — the invariant refuses to build
        // one without it. A fixture row missing the field gets an explicit, honest default
        // rather than an empty string that would silently pass.
        'Nothing is sent to the customer.',
    ),
    explanation: raw.explanation ? String(raw.explanation) : undefined,
    customerImpact: raw.customerImpact ? String(raw.customerImpact) : undefined,
    dueLabel: raw.dueLabel ? String(raw.dueLabel) : undefined,
    readback:
      state === 'completed'
        ? toReadback(String(raw.readback ?? raw.onApproveReadback ?? ''), 'salesRecords')
        : null,
  }

  // Validate the fixture against the same invariants a live action must satisfy. A fixture
  // that could not exist in production is worse than no fixture: it makes the UI look
  // correct while encoding a state the product forbids.
  assertActionInvariants(action)
  return action
}

// ── Ports ───────────────────────────────────────────────────────────────────

export function createFixturePorts(
  tenantId: FixtureTenantId = 'epic',
  overrides: FixtureHealthOverrides = {},
): WorkspacePorts {
  const tenant = fixtureTenant(tenantId)
  const entitlements = new Set(tenant.entitlements)

  const customer: CustomerPort = {
    async resolveForConversation(ref) {
      const c = sampleData.customer
      const conv = sampleData.conversation

      const resolution: CustomerResolution = {
        kind: 'one',
        context: {
          customer: {
            id: 'joss-boutique',
            name: c.name,
            initials: c.initials,
            statusLabel: c.status,
            industry: c.industry,
            location: c.location,
            ownerName: c.owner,
          },
          currentNeed: c.currentNeed,
          nextAction: {
            title: c.nextAction.title,
            context: c.nextAction.context,
            dueDate: c.nextAction.dueDate,
          },
          alerts: c.alerts.map((a) => ({
            severity: a.severity as 'warn' | 'err' | 'block',
            text: a.text,
          })),
          opportunity: {
            reference: String(c.opportunity.id),
            name: c.opportunity.name,
            value: c.opportunity.value,
            valueNote: c.opportunity.valueNote,
            stage: c.opportunity.stage,
            likelihood: c.opportunity.likelihood,
            expectedClose: c.opportunity.expectedClose,
            lines: c.opportunity.lines.map((l) => ({
              name: String((l as Record<string, unknown>).name ?? ''),
              detail: String((l as Record<string, unknown>).detail ?? ''),
            })),
          },
          services: c.services.map((s) => ({
            name: s.name,
            detail: s.detail,
            status: s.status,
          })),
          recentContact: c.recentContact.map((r) => ({
            title: r.title,
            meta: r.meta,
            emphasis: (r as Record<string, unknown>).emphasis as 'current' | 'past' | undefined,
          })),
          governedActivity: c.governedActivity.map((g) => ({
            title: g.title,
            state: toActionState(String(g.state)).state,
            readback: (g as Record<string, unknown>).readback as string | undefined,
            by: g.by,
            at: READ_AT,
          })),
          technical: {
            // These are the ONLY identifiers the UI ever sees, and the Customer module
            // renders them exclusively inside Technical details.
            conversationDisplayId: conv.conversationId,
            accountId: conv.accountId,
            inboxId: conv.inboxId,
            opportunityReference: String(c.opportunity.id),
            correlationId: conv.correlation,
            lastSync: conv.lastSync,
          },
        },
      }

      return envelope(
        resolution,
        'salesRecords',
        overrides.customer ?? 'ok',
        overrides.customer === 'stale'
          ? 'The sales system has not answered since then, so the opportunity value and next action may have changed.'
          : overrides.customer === 'degraded'
            ? 'The sales system is answering slowly.'
            : overrides.customer === 'unauthorized'
              ? 'Your role does not include this customer’s commercial detail.'
              : undefined,
      )
    },
  }

  const workItems = sampleData.work.map((w) => toGovernedAction(w as FixtureWorkItem))

  const work: WorkPort = {
    async listForCustomer() {
      return envelope(workItems, 'salesRecords', overrides.work ?? 'ok')
    },
    async listForActor() {
      return envelope(workItems, 'salesRecords', overrides.work ?? 'ok')
    },
  }

  const aiTeam: AiTeamPort = {
    async listEmployees() {
      const employees: AiEmployee[] = sampleData.aiTeam.map((a) => ({
        name: a.name,
        initials: a.initials,
        role: a.role,
        availability: toAvailability(a.availability),
        limitation: (a as Record<string, unknown>).limitation as string | undefined,
        knowledge: a.knowledge,
      }))
      return envelope(employees, 'conversation', overrides.aiTeam ?? 'ok')
    },
    async consult() {
      const s = sampleData.atlasSuggestion
      const suggestion: InternalSuggestion = {
        text: s.text,
        provenance: s.provenance,
        confidence: s.confidence as 'high' | 'medium' | 'low',
        notSentToCustomer: true,
      }
      return envelope(suggestion, 'conversation', overrides.aiTeam ?? 'ok')
    },
  }

  const today: TodayPort = {
    async summary() {
      const t = sampleData.today
      // Entitlement gating applied to CONTENT, not just to modules: an attention row about
      // the phone service must not appear for a tenant with no phone service. Filtering here
      // (server-side in the real adapter) keeps it out of the payload entirely rather than
      // hiding it in the browser.
      const needsAttention = t.needsAttention
        .filter((n) => {
          const req = (n as Record<string, unknown>).requiresEntitlement as string | undefined
          return !req || entitlements.has(req)
        })
        .map((n) => {
          const row = n as Record<string, unknown>
          return {
            severity: n.severity as 'err' | 'warn' | 'block',
            title: n.title,
            body: n.body,
            // Not every fixture row carries `meta`. Coerce to '' rather than widening
            // AttentionItem.meta to optional: the design requires every attention row to
            // name its owner and age, so an absent value is a fixture gap to notice, not a
            // shape the type should start permitting.
            meta: String(row.meta ?? ''),
            actionLabel: n.action,
            primary: Boolean(row.primary),
          }
        })

      const summary: TodaySummary = {
        date: t.date,
        time: t.time,
        decisionMetrics: t.decisionMetrics.map((m) => ({
          value: m.value,
          family: m.family as 'err' | 'warn' | 'neutral',
          text: m.text,
        })),
        activityLine: t.activityLine,
        needsAttention,
      }
      return envelope(summary, 'salesRecords', overrides.today ?? 'ok')
    },
  }

  const onboarding: OnboardingPort = {
    async load() {
      const o = sampleData.onboarding
      const rows = (tenantId === 'epic' ? o.epic : o.marche) as {
        stage: string
        state: string
        note: string
        responsible?: string
      }[]

      const stages: OnboardingStage[] = rows.map((r, i) => ({
        id: `stage-${i}`,
        name: r.stage,
        note: r.note,
        state: r.state as OnboardingStage['state'],
        responsible: r.responsible,
      }))

      // All eleven acceptance checks always render. The design forbids shortening the list:
      // a check that is not shown cannot be seen to be un-run, and "not run" is precisely
      // the state that must never be mistaken for a pass.
      const passedCount = tenantId === 'epic' ? 10 : 1
      const checks: VerificationCheck[] = o.acceptanceChecks.map((c, i) => ({
        id: `check-${i}`,
        name: c.name,
        note: c.evidence,
        status: statusForCheck(i, passedCount, tenantId),
      }))

      const state: OnboardingState = {
        stages,
        checks,
        provedCount: tenant.onboarding.proved,
        stageCount: tenant.onboarding.of,
      }
      return envelope(state, 'conversation', overrides.onboarding ?? 'ok')
    },
  }

  return { customer, work, aiTeam, today, onboarding }
}

/**
 * EPIC has one FAILED check (the design's retry story). Marché Créole has one passed and
 * ten NOT RUN — deliberately distinct from failed, because "we never tried" and "we tried
 * and it broke" call for different actions from an administrator.
 */
function statusForCheck(
  index: number,
  passedCount: number,
  tenantId: FixtureTenantId,
): VerificationCheck['status'] {
  if (index < passedCount) return 'passed'
  if (tenantId === 'epic') return 'failed'
  return 'notRun'
}

function toAvailability(raw: string): AiEmployee['availability'] {
  const v = raw.toLowerCase()
  if (v.includes('paused')) return 'paused'
  if (v.includes('approval')) return 'approvalOnly'
  if (v.includes('duty')) return 'onDuty'
  return 'available'
}
