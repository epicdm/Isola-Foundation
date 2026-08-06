/**
 * revenue-context-read@1 — `isola_revenue_customer_context_get`.
 *
 * A read-only Foundation function that will be exposed as an MCP tool to a
 * Clawith AI agent ("Atlas"). It resolves the controlled Chatwoot
 * conversation/customer context AND any already-linked Odoo opportunity
 * state, and returns exactly one allowlisted JSON shape — never a raw
 * Chatwoot or Odoo response.
 *
 * THE TRUST BOUNDARY — browser/agent-supplied context is an untrusted hint
 * ---------------------------------------------------------------------
 * `hints.accountId` / `hints.inboxId` / `hints.conversationId` are taken from
 * whatever called this tool (an AI agent, ultimately acting on a Chatwoot
 * webhook payload or a staff-typed reference). None of them is trusted as an
 * authorization decision. The ONLY thing this function trusts is the
 * caller's own resolved identity (`caller.agentRef`, resolved server-side to
 * a Foundation tenant via `resolveTenantForAgent`) — matching the pattern
 * already proven in app/api/agent-tools/invoke/route.ts ("Resolve the agent
 * -> its REAL, trusted tenant. Never trust the caller-supplied tenant_id past
 * this point.") and in lib/chatwoot-conversation-link.ts (a binding's
 * `tenant_id` is checked against the caller's tenant before a link is ever
 * built, never assumed from the request).
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
 * - Never returns phone/email, full message history, or a raw Chatwoot/Odoo
 *   response. Every returned field is named in ALLOWED_KEYS below and
 *   nowhere else — see `projectAllowlist`, mirroring
 *   scripts/src/guard-chatwoot-safe-read.ts's allowlist-only discipline
 *   (never a denylist: an unlisted field is invisible by construction, not
 *   newly dangerous the day Chatwoot adds one).
 *
 * THE CHATWOOT-CONVERSATION <-> ODOO-LEAD LINK: AN HONEST GAP
 * -------------------------------------------------------------
 * Foundation has NO formal, schema-level link from a Chatwoot conversation to
 * an Odoo crm.lead today (searched: prisma/schema.prisma's `Conversation`
 * model carries `chatwoot_binding_id` and `chatwoot_conversation_id`, but no
 * lead/opportunity reference of any kind; `ConsumerLead.odoo_lead_id` is the
 * only lead-linking field in the schema, and it belongs to the anonymous
 * marketing-funnel table, unrelated to a Chatwoot conversation).
 * `resolveLinkedOpportunity` is therefore an injected PORT with an honest
 * default: `defaultResolveLinkedOpportunity` returns `null` unconditionally,
 * documented as best-effort/absent rather than fabricating a link. A test
 * fixture may inject a fake that resolves conversation 131 to crm.lead 1642
 * (the real, already-verified EPIC Communications case) to prove the SHAPE
 * this function produces once a real linking mechanism exists — but no
 * conversation-131-specific logic is hardcoded into this file.
 */

import type { ChatwootConfig } from '@/engines/chatwoot'
import { getConversationRaw, listMessagesRaw, getContactRaw } from '@/engines/chatwoot'
import { prisma } from '@/lib/prisma'

export const REVENUE_CONTEXT_VERSION = 'revenue-context-read@1' as const

/** Hard cap regardless of what a caller asks for — "small limit", never full history. */
export const MAX_MESSAGE_LIMIT = 10
export const DEFAULT_MESSAGE_LIMIT = 5

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

export interface OpportunitySnapshot {
  leadId: string
  stage: string | null
  ownerRef: string | null
  ownerName: string | null
  nextAction: string | null
  dueDate: string | null
}

export interface RevenueContextPorts {
  /** Resolves the CALLER's identity to a Foundation tenant. Never the reverse. */
  resolveTenantForAgent(agentRef: string): Promise<string | null>
  /** All ChatwootBinding rows Foundation holds for this tenant. */
  findChatwootBindingsForTenant(tenantId: string): Promise<ChatwootBindingRow[]>
  chatwoot: ChatwootReadClient
  /** Best-effort, honest-by-default. See the file header. */
  resolveLinkedOpportunity(input: {
    tenantId: string
    chatwootConversationId: number
    chatwootContactId: number | null
  }): Promise<OpportunitySnapshot | null>
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

/** Honest default — see the file header's "honest gap" section. */
async function defaultResolveLinkedOpportunity(): Promise<OpportunitySnapshot | null> {
  return null
}

export const DEFAULT_REVENUE_CONTEXT_PORTS: RevenueContextPorts = {
  resolveTenantForAgent: defaultResolveTenantForAgent,
  findChatwootBindingsForTenant: defaultFindChatwootBindingsForTenant,
  chatwoot: defaultChatwootReadClient,
  resolveLinkedOpportunity: defaultResolveLinkedOpportunity,
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
  messageLimit?: number
}

export type RevenueContextDenyCode = 'unauthenticated' | 'not_found'

export interface RevenueContextData {
  version: typeof REVENUE_CONTEXT_VERSION
  tenantId: string
  conversation: {
    id: number
    accountId: string
    inboxId: number
    status: string
    createdAt: string | null
    lastActivityAt: string | null
    labels: string[]
    assignee: { id: number; name: string } | null
  }
  contact: { id: number; name: string } | null
  messages: { direction: 'incoming' | 'outgoing'; sentAt: string | null; preview: string }[]
  opportunity: OpportunitySnapshot | null
  /** §6 deep-link shape: `{base}/app/accounts/{account}/conversations/{id}`. */
  chatwootDeepLink: string | null
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
  'content', // raw message text — only the truncated `preview` may carry text
])

function assertAllowlistSafe(allowed: readonly string[]): void {
  const offending = allowed.filter((f) => FORBIDDEN_FIELDS.has(f.toLowerCase()))
  if (offending.length > 0) {
    throw new Error(`revenue-context-read: allowlist names forbidden field(s): ${offending.join(', ')}`)
  }
}

const CONVERSATION_ALLOWED = [
  'id',
  'accountId',
  'inboxId',
  'status',
  'createdAt',
  'lastActivityAt',
  'labels',
  'assignee',
] as const
const ASSIGNEE_ALLOWED = ['id', 'name'] as const
const CONTACT_ALLOWED = ['id', 'name'] as const
const MESSAGE_ALLOWED = ['direction', 'sentAt', 'preview'] as const
const OPPORTUNITY_ALLOWED = ['leadId', 'stage', 'ownerRef', 'ownerName', 'nextAction', 'dueDate'] as const
const ROOT_ALLOWED = [
  'version',
  'tenantId',
  'conversation',
  'contact',
  'messages',
  'opportunity',
  'chatwootDeepLink',
] as const

assertAllowlistSafe(CONVERSATION_ALLOWED)
assertAllowlistSafe(ASSIGNEE_ALLOWED)
assertAllowlistSafe(CONTACT_ALLOWED)
assertAllowlistSafe(MESSAGE_ALLOWED)
assertAllowlistSafe(OPPORTUNITY_ALLOWED)
assertAllowlistSafe(ROOT_ALLOWED)

/** The exact allowlist this module promises to honor — asserted by a test. */
export const REVENUE_CONTEXT_ALLOWED_KEYS = {
  root: ROOT_ALLOWED,
  conversation: CONVERSATION_ALLOWED,
  assignee: ASSIGNEE_ALLOWED,
  contact: CONTACT_ALLOWED,
  message: MESSAGE_ALLOWED,
  opportunity: OPPORTUNITY_ALLOWED,
} as const

// ── helpers ──────────────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Chatwoot timestamps are epoch seconds; some payloads use ISO strings. Normalize to ISO. */
function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v * 1000).toISOString()
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

const MAX_PREVIEW_CHARS = 160

/** Summarized, never verbatim beyond a short preview — per the classification contract. */
function previewOf(content: unknown): string {
  const s = str(content).replace(/\s+/g, ' ').trim()
  if (!s) return ''
  return s.length > MAX_PREVIEW_CHARS ? `${s.slice(0, MAX_PREVIEW_CHARS)}…` : s
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

  const limit = Math.min(Math.max(1, req.messageLimit ?? DEFAULT_MESSAGE_LIMIT), MAX_MESSAGE_LIMIT)
  let rawMessages: Record<string, unknown>[] = []
  try {
    rawMessages = await ports.chatwoot.listMessages(config, conversationIdNum, limit)
  } catch {
    rawMessages = [] // messages are enrichment; their absence is not a deny
  }

  const meta = (rawConversation.meta ?? {}) as Record<string, unknown>
  const sender = (meta.sender ?? {}) as Record<string, unknown>
  const assigneeRaw = (meta.assignee ?? {}) as Record<string, unknown>
  const senderId = num(sender.id)

  let rawContact: Record<string, unknown> | null = null
  if (senderId !== null) {
    try {
      rawContact = await ports.chatwoot.getContact(config, senderId)
    } catch {
      rawContact = null
    }
  }

  const opportunity = await ports.resolveLinkedOpportunity({
    tenantId,
    chatwootConversationId: conversationIdNum,
    chatwootContactId: senderId,
  })

  const labelsRaw = rawConversation.labels
  const labels = Array.isArray(labelsRaw) ? labelsRaw.filter((l): l is string => typeof l === 'string') : []

  const assigneeId = num(assigneeRaw.id)
  const assignee = assigneeId !== null ? { id: assigneeId, name: str(assigneeRaw.name) } : null

  const contactId = num((rawContact ?? sender).id)
  const contact = contactId !== null ? { id: contactId, name: str((rawContact ?? sender).name) } : null

  const messages = rawMessages
    .map((m) => {
      const type = m.message_type
      // 0 = incoming, 1 = outgoing, 2 = activity (system note), 3 = template.
      // Private notes and system activity are staff-internal / non-customer
      // content and are excluded — this tool answers "what is the customer
      // context", not "what did staff write about it".
      if (m.private === true) return null
      if (type === 0) return { direction: 'incoming' as const, sentAt: toIso(m.created_at), preview: previewOf(m.content) }
      if (type === 1 || type === 3) return { direction: 'outgoing' as const, sentAt: toIso(m.created_at), preview: previewOf(m.content) }
      return null
    })
    .filter((m): m is RevenueContextData['messages'][number] => m !== null)

  const data: RevenueContextData = {
    version: REVENUE_CONTEXT_VERSION,
    tenantId,
    conversation: {
      id: conversationIdNum,
      accountId: hintAccountId,
      inboxId: rawInboxId,
      status: str(rawConversation.status),
      createdAt: toIso(rawConversation.created_at),
      lastActivityAt: toIso(rawConversation.timestamp ?? rawConversation.last_activity_at),
      labels,
      assignee,
    },
    contact,
    messages,
    opportunity,
    chatwootDeepLink: buildDeepLink(binding, conversationIdNum),
  }

  return { ok: true, data }
}
