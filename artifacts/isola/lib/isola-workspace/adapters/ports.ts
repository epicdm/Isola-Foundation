/**
 * Isola Workspace — adapter ports.
 *
 * Every external system is reached through one of these interfaces and never directly. A
 * module imports a PORT, never a client. That is what makes "adding a service = one adapter
 * + one registry entry" true rather than aspirational.
 *
 * WHY PORTS AND NOT DIRECT CALLS
 * ------------------------------
 *  - The design must be buildable and its fourteen states exercisable BEFORE any real
 *    integration exists. A fixture adapter satisfies these interfaces exactly as a live one
 *    will, so every state is reachable today and no state is "we'll see it in production".
 *  - The live Chatwoot read contract is gated: `defect-chatwoot-platformapp-token-harvest-path-2026-07-25`
 *    (P0, Open) must close before ANY new Chatwoot API consumer exists (owner ruling D8).
 *    Ports let the UI be finished and reviewed while that gate is shut.
 *  - Each port's return type is an ALLOWLIST, mirroring the discipline in
 *    `scripts/src/guard-chatwoot-safe-read.ts` and `CHATWOOT-REVENUE-CONTEXT-CONTRACT.md` §3/§5:
 *    scalars only, no raw upstream response, no credential-bearing field, and an unlisted
 *    field is invisible by construction rather than newly dangerous the day upstream adds one.
 *
 * EVERY RESULT CARRIES ITS OWN FRESHNESS AND HEALTH. That is not decoration: the design
 * requires that a degraded or stale read still renders content from the last good value,
 * with an honest timestamp, rather than collapsing to a blank panel. A port that returned
 * bare data could not support that, so `PortResult` is the only shape any port returns.
 */

import type { ActionState, SourceRef } from '../contracts'
import type { GovernedActionInstance } from '../action-lifecycle'

// ── The universal result envelope ───────────────────────────────────────────

export type PortHealth =
  /** Answered normally. */
  | 'ok'
  /** Answered, but the value is older than its freshness budget. */
  | 'stale'
  /** Not answering, or answering too slowly to trust. Content may still be shown. */
  | 'degraded'
  /** We are not permitted to read this. Distinct from "there is nothing". */
  | 'unauthorized'
  /** Answered, and the honest answer is that there is nothing. */
  | 'empty'

export interface PortResult<T> {
  health: PortHealth
  /** Present for ok/stale/degraded (last good value). Null for unauthorized/empty. */
  data: T | null
  /** ISO timestamp of the read this data came from. Required whenever data is present. */
  readAt: string | null
  /**
   * Plain-English source, for a `SourceBadge`. Never a vendor name — an operator must never
   * learn which product answered.
   */
  source: SourceRef
  /** Operator-facing reason for stale/degraded/unauthorized. Never a stack trace or code. */
  reason?: string
  /** Whether the platform is retrying on its own. Drives "retrying automatically" copy. */
  retrying?: boolean
}

// ── Customer ────────────────────────────────────────────────────────────────

export interface CustomerIdentity {
  id: string
  name: string
  initials: string
  /** e.g. "Active customer". */
  statusLabel: string
  industry?: string
  location?: string
  ownerName: string
}

export interface OpportunitySummary {
  /** Opaque to the UI; rendered only inside Technical details. */
  reference: string
  name: string
  /** Preformatted in the tenant's currency, e.g. "EC$4,850". */
  value: string
  valueNote?: string
  stage: string
  likelihood?: string
  expectedClose?: string
  lines: readonly { name: string; detail: string }[]
  href?: string
}

export interface NextAction {
  title: string
  context: string
  dueDate: string
}

export interface CustomerContext {
  customer: CustomerIdentity
  currentNeed: string
  nextAction: NextAction
  alerts: readonly { severity: 'warn' | 'err' | 'block'; text: string }[]
  opportunity: OpportunitySummary | null
  services: readonly { name: string; detail: string; status: string }[]
  recentContact: readonly { title: string; meta: string; emphasis?: 'current' | 'past' }[]
  governedActivity: readonly {
    title: string
    state: ActionState
    readback?: string
    by: string
    at: string
  }[]
  /**
   * Raw identifiers. Rendered ONLY inside the Technical details disclosure, in mono, never
   * on the initial view. Grouped into their own object so "do not surface these" is a
   * single reviewable decision rather than a judgement call per field.
   */
  technical: {
    conversationDisplayId: number
    accountId: number
    inboxId: number
    opportunityReference: string | null
    correlationId: string | null
    lastSync: string | null
  }
}

/**
 * Customer resolution is three-valued. "Many" is a FIRST-CLASS STATE, not an error: the
 * shell renders a disambiguation list and no module may use customer data until one is
 * chosen. Modelling it as an error would produce either a wrong customer or a blank panel.
 */
export type CustomerResolution =
  | { kind: 'one'; context: CustomerContext }
  | { kind: 'none' }
  | {
      kind: 'many'
      candidates: readonly { id: string; name: string; disambiguation: string }[]
    }

export interface CustomerPort {
  resolveForConversation(ref: {
    accountId: number
    inboxId: number
    conversationDisplayId: number
  }): Promise<PortResult<CustomerResolution>>
}

// ── Work and approvals ──────────────────────────────────────────────────────

export interface WorkPort {
  listForCustomer(customerId: string): Promise<PortResult<readonly GovernedActionInstance[]>>
  listForActor(actorId: string): Promise<PortResult<readonly GovernedActionInstance[]>>
}

// ── AI team ─────────────────────────────────────────────────────────────────

export interface AiEmployee {
  name: string
  initials: string
  /** Plain English: "Front desk · WhatsApp, after hours". */
  role: string
  availability: 'available' | 'onDuty' | 'approvalOnly' | 'paused'
  /** Required when paused — an operator must know why. */
  limitation?: string
  knowledge?: readonly string[]
}

export interface InternalSuggestion {
  /** The drafted wording. NEVER sent by producing it. */
  text: string
  provenance: readonly string[]
  confidence: 'high' | 'medium' | 'low'
  /** Always true. Present as data so the badge cannot be forgotten in markup. */
  notSentToCustomer: true
}

export interface AiTeamPort {
  listEmployees(): Promise<PortResult<readonly AiEmployee[]>>
  /**
   * Read-only consultation. Atlas may summarise, draft, investigate, suggest and PREPARE an
   * action for approval. It may not execute and it may not send — there is deliberately no
   * `send` on this port, so no caller can reach one.
   */
  consult(prompt: string): Promise<PortResult<InternalSuggestion>>
}

// ── Today ───────────────────────────────────────────────────────────────────

export interface AttentionItem {
  severity: 'err' | 'warn' | 'block'
  title: string
  body: string
  meta: string
  actionLabel: string
  primary?: boolean
  requiresEntitlement?: string
}

export interface TodaySummary {
  date: string
  time: string
  decisionMetrics: readonly { value: string; family: 'err' | 'warn' | 'neutral'; text: string }[]
  activityLine: string
  needsAttention: readonly AttentionItem[]
  /** Manager-only sections. Absent for an operator — omitted server-side, not hidden in CSS. */
  team?: {
    workload: readonly { name: string; detail: string }[]
    serviceProblems: readonly { title: string; detail: string }[]
  }
}

export interface TodayPort {
  summary(): Promise<PortResult<TodaySummary>>
}

// ── Onboarding ──────────────────────────────────────────────────────────────

export type OnboardingStageState =
  | 'notStarted'
  | 'setup'
  | 'proved'
  | 'accepted'
  | 'blocked'
  | 'failed'

export interface OnboardingStage {
  id: string
  name: string
  note: string
  state: OnboardingStageState
  responsible?: string
}

export type VerificationStatus = 'passed' | 'failed' | 'notRun' | 'running'

export interface VerificationCheck {
  id: string
  name: string
  /** The EVIDENCE, not a restatement. "Test reminder created on a sales record". */
  note: string
  status: VerificationStatus
}

export interface OnboardingState {
  stages: readonly OnboardingStage[]
  checks: readonly VerificationCheck[]
  provedCount: number
  stageCount: number
}

export interface OnboardingPort {
  load(): Promise<PortResult<OnboardingState>>
}

// ── The bundle handed to the shell ──────────────────────────────────────────

export interface WorkspacePorts {
  customer: CustomerPort
  work: WorkPort
  aiTeam: AiTeamPort
  today: TodayPort
  onboarding: OnboardingPort
}
