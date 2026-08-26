/**
 * revenue-context-read@1 — `isola_revenue_customer_context_get`.
 *
 * A read-only Foundation function exposed as an MCP tool to a Clawith AI
 * agent ("Atlas"). It resolves the controlled Chatwoot conversation/customer
 * context and returns exactly the allowlisted shape defined by
 * `docs/isola/CHATWOOT-REVENUE-CONTEXT-CONTRACT.md` (§3 field classification,
 * §5 output shape) — never a raw Chatwoot response, and never a shape this
 * file invented on its own.
 *
 * REVISION NOTE (2026-08-06, second pass)
 * ------------------------------------------
 * The first pass of this file was built without sight of the real contract
 * doc — it lives untracked in the shared main checkout, which this isolated
 * worktree's git history cannot see — and invented its own output shape
 * (`messages: []`, `opportunity`, top-level `version`/`tenantId`, an
 * `assignee.id`/`contact.id`). That shape has been REPLACED, not merged, with
 * the authoritative one below, once the real doc's text was relayed:
 *   - No `messages` array. Only `latest_enquiry` (one summarized inbound
 *     message) and `latest_human_response` (existence/sender/timestamp of the
 *     most recent HUMAN-authored reply, never its content — content is
 *     `INTERNAL_ONLY` per §3: "operationally sensitive").
 *   - `team` and `priority` were missing entirely and are now present.
 *   - `custom_attributes.correlation_id` / `handoff_state` were missing and
 *     are now present (both `null` for every real conversation today per the
 *     doc's own live fixture note — Lane 3's correlation id currently lives
 *     in private-note text, not a Chatwoot custom attribute; an honest gap on
 *     that lane's side, not surfaced here as anything but `null`).
 *   - `account_id`/`inbox_id`/top-level `version`/`tenantId`/`assignee.id`/
 *     `contact.id` are all `INTERNAL_ONLY` per §3 and have been removed from
 *     the returned data — they still drive this function's OWN logic and
 *     audit trail, they are simply never serialized to the caller.
 *   - Odoo opportunity state (owner/next-action/due-date) is NOT part of
 *     this tool's output. The real contract's §5 shape is stated as "the
 *     ENTIRE allowlist, nothing else" and has no such field — if a later
 *     milestone needs opportunity context surfaced to an agent, that is a
 *     separate tool or a separate, deliberately-added field, not something
 *     folded back into this one to preserve a design this file no longer
 *     uses.
 *
 * THE TRUST BOUNDARY — browser/agent-supplied context is an untrusted hint
 * ---------------------------------------------------------------------
 * `hints.accountId` / `hints.inboxId` / `hints.conversationId` are taken from
 * whatever called this tool. None of them is trusted as an authorization
 * decision. The ONLY thing this function trusts is the caller's own resolved
 * identity (`caller.agentRef`, resolved server-side to a Foundation tenant
 * via `resolveTenantForAgent`) — matching the pattern already proven in
 * app/api/agent-tools/invoke/route.ts ("Resolve the agent -> its REAL,
 * trusted tenant. Never trust the caller-supplied tenant_id past this
 * point.") and in lib/chatwoot-conversation-link.ts (a binding's `tenant_id`
 * is checked against the caller's tenant before a link is ever built, never
 * assumed from the request).
 *
 * The hints are then INDEPENDENTLY VERIFIED against that resolved tenant's
 * own ChatwootBinding row, and the conversation is INDEPENDENTLY RE-READ from
 * Chatwoot (never merely echoed) to confirm its `inbox_id` actually matches
 * the hinted inbox. A mismatch anywhere in that chain is a deny, not a
 * best-effort filter — see runRevenueCustomerContextGet's early returns.
 *
 * WHAT THIS NEVER DOES
 * ---------------------
 * - Never calls the live Chatwoot MCP server or any other network client —
 *   only the injected `ChatwootReadClient` port (engines/chatwoot.ts's
 *   `getConversationRaw`/`listMessagesRaw`/`getContactRaw` in production, a
 *   fake with NO write methods in every test in this file's sibling test).
 * - Never reads `inboxes`, `webhooks` or `agent_bots` — the three endpoints
 *   scripts/src/guard-chatwoot-safe-read.ts exists because of. This tool has
 *   no business reason to and does not.
 * - Never returns phone/email, full message history, human-response
 *   CONTENT, `sender.additional_attributes`, or a raw Chatwoot response.
 *   Every returned field is named in `REVENUE_CONTEXT_ALLOWED_KEYS` below and
 *   nowhere else — see `assertAllowlistSafe`, mirroring
 *   scripts/src/guard-chatwoot-safe-read.ts's allowlist-only discipline
 *   (never a denylist: an unlisted field is invisible by construction, not
 *   newly dangerous the day Chatwoot adds one).
 */

import type { ChatwootConfig } from '@/engines/chatwoot'
import { getConversationRaw, listMessagesRaw, getContactRaw } from '@/engines/chatwoot'
import { prisma } from '@/lib/prisma'

export const REVENUE_CONTEXT_VERSION = 'revenue-context-read@1' as const

/**
 * Read a SMALL number of recent messages internally (per the contract doc:
 * "read with a small limit (2-5) internally") to find the two facts this
 * tool actually surfaces — the latest inbound enquiry and the latest human
 * response. Never exposed as a caller-facing knob, and never returned as an
 * array — see the file header's "no messages array" note.
 */
const INTERNAL_MESSAGE_FETCH_LIMIT = 5

// ── Ports ──────────────────────────────────────────────────────────────────

export interface ChatwootReadClient {
  getConversation(config: ChatwootConfig, conversationId: number): Promise<Record<string, unknown> | null>
  listMessages(
    config: ChatwootConfig,
    conversationId: number,
    limit: number,
  ): Promise<Record<string, unknown>[]>
  getContact(config: ChatwootConfig, contactId: number): Promise<Record<string, unknown> | null>
}

/** The real client. Talks to Chatwoot through engines/chatwoot.ts only. */
export const defaultChatwootReadClient: ChatwootReadClient = {
  getConversation: getConversationRaw,
  listMessages: listMessagesRaw,
  getContact: getContactRaw,
}

export interface ChatwootBindingRow {
  id: string
  tenant_id: string
  base_url: string
  account_id: string
  token: string
  inbox_id: string | null
}

export interface RevenueContextPorts {
  /** Resolves the CALLER's identity to a Foundation tenant. Never the reverse. */
  resolveTenantForAgent(agentRef: string): Promise<string | null>
  /** All ChatwootBinding rows Foundation holds for this tenant. */
  findChatwootBindingsForTenant(tenantId: string): Promise<ChatwootBindingRow[]>
  chatwoot: ChatwootReadClient
  now(): Date
}

async function defaultResolveTenantForAgent(agentRef: string): Promise<string | null> {
  const agent = await prisma.agent.findUnique({ where: { id: agentRef } })
  return agent?.is_active ? agent.tenant_id : null
}

async function defaultFindChatwootBindingsForTenant(tenantId: string): Promise<ChatwootBindingRow[]> {
  return prisma.chatwootBinding.findMany({
    where: { tenant_id: tenantId },
    select: { id: true, tenant_id: true, base_url: true, account_id: true, token: true, inbox_id: true },
  })
}

export const DEFAULT_REVENUE_CONTEXT_PORTS: RevenueContextPorts = {
  resolveTenantForAgent: defaultResolveTenantForAgent,
  findChatwootBindingsForTenant: defaultFindChatwootBindingsForTenant,
  chatwoot: defaultChatwootReadClient,
  now: () => new Date(),
}

// ── Request / result ────────────────────────────────────────────────────────

export interface RevenueContextRequest {
  /** Resolved server-side by `resolveTenantForAgent`. Never a bare tenant id. */
  caller: { agentRef: string }
  /** UNTRUSTED HINTS — re-verified against the resolved tenant before any Chatwoot call. */
  hints: {
    accountId: string
    inboxId: string
    conversationId: string
  }
}

export type RevenueContextDenyCode = 'unauthenticated' | 'not_found'

/**
 * The ENTIRE output shape — docs/isola/CHATWOOT-REVENUE-CONTEXT-CONTRACT.md
 * §5, verbatim. Nothing here that is not in that shape; nothing in that
 * shape that is not here.
 */
export interface RevenueContextData {
  conversation: {
    id: number
    display_id: number | null
    status: string
    priority: string
    labels: string[]
    team: { name: string } | null
    assignee: { name: string } | null
    handoff_state: string | null
    correlation_id: string | null
    deep_link: string
  }
  contact: {
    name: string
  } | null
  latest_enquiry: {
    summary: string
    at: string | null
  } | null
  latest_human_response: {
    responded: boolean
    by: string | null
    at: string | null
  }
}

export type RevenueContextResult =
  | { ok: true; data: RevenueContextData }
  | { ok: false; code: RevenueContextDenyCode; detail: string }

// ── Allowlist projection — mirrors scripts/src/guard-chatwoot-safe-read.ts ──

/** Field names that must never appear anywhere in this tool's output. */
const FORBIDDEN_FIELDS = new Set([
  'phone_number',
  'phone',
  'email',
  'api_key',
  'access_token',
  'secret',
  'webhook_verify_token',
  'authorization',
  'token',
  'content', // raw message text — never returned; only a summarized `summary` may carry text
  'account_id',
  'inbox_id',
])

function assertAllowlistSafe(allowed: readonly string[]): void {
  const offending = allowed.filter((f) => FORBIDDEN_FIELDS.has(f.toLowerCase()))
  if (offending.length > 0) {
    throw new Error(`revenue-context-read: allowlist names forbidden field(s): ${offending.join(', ')}`)
  }
}

const CONVERSATION_ALLOWED = [
  'id',
  'display_id',
  'status',
  'priority',
  'labels',
  'team',
  'assignee',
  'handoff_state',
  'correlation_id',
  'deep_link',
] as const
const TEAM_ALLOWED = ['name'] as const
const ASSIGNEE_ALLOWED = ['name'] as const
const CONTACT_ALLOWED = ['name'] as const
const LATEST_ENQUIRY_ALLOWED = ['summary', 'at'] as const
const LATEST_HUMAN_RESPONSE_ALLOWED = ['responded', 'by', 'at'] as const
const ROOT_ALLOWED = ['conversation', 'contact', 'latest_enquiry', 'latest_human_response'] as const

assertAllowlistSafe(CONVERSATION_ALLOWED)
assertAllowlistSafe(TEAM_ALLOWED)
assertAllowlistSafe(ASSIGNEE_ALLOWED)
assertAllowlistSafe(CONTACT_ALLOWED)
assertAllowlistSafe(LATEST_ENQUIRY_ALLOWED)
assertAllowlistSafe(LATEST_HUMAN_RESPONSE_ALLOWED)
assertAllowlistSafe(ROOT_ALLOWED)

/** The exact allowlist this module promises to honor — asserted by a test. */
export const REVENUE_CONTEXT_ALLOWED_KEYS = {
  root: ROOT_ALLOWED,
  conversation: CONVERSATION_ALLOWED,
  team: TEAM_ALLOWED,
  assignee: ASSIGNEE_ALLOWED,
  contact: CONTACT_ALLOWED,
  latest_enquiry: LATEST_ENQUIRY_ALLOWED,
  latest_human_response: LATEST_HUMAN_RESPONSE_ALLOWED,
} as const

// ── helpers ──────────────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const nullableStr = (v: unknown): string | null => {
  const s = str(v).trim()
  return s ? s : null
}

/** Chatwoot timestamps are epoch seconds; some payloads use ISO strings. Normalize to ISO. */
function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v * 1000).toISOString()
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

const MAX_SUMMARY_CHARS = 160

/** Summarized, never verbatim beyond a short preview — per the classification contract. */
function summarize(content: unknown): string {
  const s = str(content).replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > MAX_SUMMARY_CHARS ? `${s.slice(0, MAX_SUMMARY_CHARS)}…` : s
}

/**
 * A message's sender is a human (a Chatwoot `User`) rather than the AgentBot,
 * so its EXISTENCE/sender-name/timestamp may count as "a human responded".
 * Its CONTENT is still never surfaced — see `latest_human_response` below,
 * which carries `by`/`at` only.
 */
function isHumanSenderType(v: unknown): boolean {
  const t = str(v).toLowerCase().replace(/[^a-z]/g, '')
  if (!t) return true // no explicit type on this payload — do not assume it was a bot
  return t !== 'agentbot'
}

function isSafePathSegment(v: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(v)
}

function isUsableBase(u: string): boolean {
  if (!u.trim() || u.includes('?') || u.includes('#')) return false
  try {
    const parsed = new URL(u.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function buildDeepLink(binding: ChatwootBindingRow, conversationId: number): string | null {
  if (!isUsableBase(binding.base_url) || !isSafePathSegment(binding.account_id)) return null
  const base = binding.base_url.trim().replace(/\/+$/, '')
  return `${base}/app/accounts/${binding.account_id}/conversations/${conversationId}`
}

function deny(code: RevenueContextDenyCode, detail: string): RevenueContextResult {
  return { ok: false, code, detail }
}

// ── the function ─────────────────────────────────────────────────────────────

export async function runRevenueCustomerContextGet(
  req: RevenueContextRequest,
  ports: RevenueContextPorts = DEFAULT_REVENUE_CONTEXT_PORTS,
): Promise<RevenueContextResult> {
  const agentRef = str(req.caller?.agentRef).trim()
  if (!agentRef) return deny('unauthenticated', 'no caller identity was supplied')

  const tenantId = await ports.resolveTenantForAgent(agentRef)
  if (!tenantId) return deny('unauthenticated', 'caller identity did not resolve to an active tenant')

  const hintAccountId = str(req.hints?.accountId).trim()
  const hintInboxId = str(req.hints?.inboxId).trim()
  const hintConversationId = str(req.hints?.conversationId).trim()
  const conversationIdNum = Number(hintConversationId)
  if (!hintAccountId || !hintInboxId || !hintConversationId || !Number.isFinite(conversationIdNum)) {
    return deny('not_found', 'account_id, inbox_id and conversation_id are all required')
  }

  // ── Verify the hints against THIS tenant's own bindings — never trusted bare.
  // account_id/inbox_id are INTERNAL_ONLY per the contract's §3 classification
  // — used here to scope the read and never placed in the returned data.
  const bindings = await ports.findChatwootBindingsForTenant(tenantId)
  const binding = bindings.find(
    (b) => b.account_id === hintAccountId && b.inbox_id === hintInboxId,
  )
  if (!binding) {
    return deny(
      'not_found',
      `account ${hintAccountId} / inbox ${hintInboxId} is not bound to this tenant`,
    )
  }

  const config: ChatwootConfig = { baseUrl: binding.base_url, accountId: binding.account_id, token: binding.token }

  // ── Re-read the conversation from Chatwoot. Never trust the hint alone —
  // its `inbox_id` must match what was hinted, proven by an independent read.
  let rawConversation: Record<string, unknown> | null
  try {
    rawConversation = await ports.chatwoot.getConversation(config, conversationIdNum)
  } catch {
    return deny('not_found', 'the conversation could not be read')
  }
  if (!rawConversation) return deny('not_found', 'no such conversation on this account')

  const rawInboxId = num(rawConversation.inbox_id)
  if (rawInboxId === null || String(rawInboxId) !== hintInboxId) {
    return deny('not_found', 'the conversation does not belong to the hinted inbox')
  }

  let rawMessages: Record<string, unknown>[] = []
  try {
    rawMessages = await ports.chatwoot.listMessages(config, conversationIdNum, INTERNAL_MESSAGE_FETCH_LIMIT)
  } catch {
    rawMessages = [] // enrichment only; absence is not a deny
  }

  const meta = (rawConversation.meta ?? {}) as Record<string, unknown>
  const sender = (meta.sender ?? {}) as Record<string, unknown>
  const assigneeRaw = (meta.assignee ?? {}) as Record<string, unknown>
  const teamRaw = ((meta.team ?? rawConversation.team) ?? {}) as Record<string, unknown>
  const senderId = num(sender.id) // INTERNAL_ONLY — used for the contact lookup only, never returned.

  let rawContact: Record<string, unknown> | null = null
  if (senderId !== null) {
    try {
      rawContact = await ports.chatwoot.getContact(config, senderId)
    } catch {
      rawContact = null
    }
  }

  const labelsRaw = rawConversation.labels
  const labels = Array.isArray(labelsRaw) ? labelsRaw.filter((l): l is string => typeof l === 'string') : []

  const assigneeName = nullableStr(assigneeRaw.name)
  const assignee = assigneeName ? { name: assigneeName } : null

  const teamName = nullableStr(teamRaw.name)
  const team = teamName ? { name: teamName } : null

  const contactName = nullableStr((rawContact ?? sender).name)
  const contact = contactName ? { name: contactName } : null

  const customAttributes = (rawConversation.custom_attributes ?? {}) as Record<string, unknown>
  const handoffState = nullableStr(customAttributes.handoff_state)
  const correlationId = nullableStr(customAttributes.correlation_id)

  // ── latest_enquiry — the most recent CUSTOMER-authored (incoming) message,
  // summarized, never verbatim. Private notes and system activity are
  // staff-internal and excluded.
  const incoming = rawMessages.filter((m) => m.private !== true && m.message_type === 0)
  const latestIncoming = incoming[incoming.length - 1] ?? null
  const latestEnquiry = latestIncoming
    ? { summary: summarize(latestIncoming.content), at: toIso(latestIncoming.created_at) }
    : null

  // ── latest_human_response — EXISTENCE/sender/timestamp of the most recent
  // HUMAN-authored outgoing message, within the small internally-fetched
  // window. Content is never read into this object — see isHumanSenderType.
  const humanOutgoing = rawMessages.filter((m) => {
    if (m.private === true) return false
    if (m.message_type !== 1 && m.message_type !== 3) return false
    const senderObj = (m.sender ?? {}) as Record<string, unknown>
    return isHumanSenderType(m.sender_type ?? senderObj.type)
  })
  const latestHuman = humanOutgoing[humanOutgoing.length - 1] ?? null
  const latestHumanResponse = latestHuman
    ? {
        responded: true,
        by: nullableStr(((latestHuman.sender ?? {}) as Record<string, unknown>).name),
        at: toIso(latestHuman.created_at),
      }
    : { responded: false, by: null, at: null }

  const data: RevenueContextData = {
    conversation: {
      id: conversationIdNum,
      display_id: num(rawConversation.display_id),
      status: str(rawConversation.status),
      priority: str(rawConversation.priority) || 'none',
      labels,
      team,
      assignee,
      handoff_state: handoffState,
      correlation_id: correlationId,
      deep_link: buildDeepLink(binding, conversationIdNum) ?? '',
    },
    contact,
    latest_enquiry: latestEnquiry,
    latest_human_response: latestHumanResponse,
  }

  return { ok: true, data }
}
