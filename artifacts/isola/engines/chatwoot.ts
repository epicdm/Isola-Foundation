/**
 * chatwoot.ts — Portable Chatwoot Application API client (Bucket 1 extraction)
 *
 * Extracted from (deepseek): /opt/bff-v2/app/lib/chatwoot/app-api.ts
 *   searchContactByPhone()    source L35-50
 *   createContact()           source L52-70
 *   upsertContact()           source L72-94
 *   getContactConversations() source L96-109
 *   createConversation()      source L111-135
 *   addMessage()               source L232-253
 *   addPrivateNote()           source L517-535
 *
 * WHAT THIS DOES
 *   Per-account REST calls against a Chatwoot instance's Application API
 *   (contact search/create/upsert, conversation create/list, message send,
 *   private-note send). This is the Application API (per-account agent
 *   token), NOT the Platform/super-admin API.
 *
 * CONFIG REQUIRED — ChatwootConfig
 *   { baseUrl, accountId, token }
 *     baseUrl   — e.g. 'https://inbox.epic.dm' (no trailing slash)
 *     accountId — Chatwoot account id (per-tenant)
 *     token     — Chatwoot agent API access token for THAT account
 *       (source used a single BFF-system-account admin token; this module
 *       takes it per-call via config so each tenant's own token can be used)
 *
 * CAUTION
 *   - upsertContact() normalizes phone to E.164 (leading '+') before
 *     search/create — Chatwoot 422s on bare-digit phone numbers. Preserve
 *     that normalization if you touch this function.
 *   - searchContactByPhone() does an exact match against Chatwoot's fuzzy
 *     search results (`c.phone_number === phone`) — Chatwoot's own search
 *     endpoint is NOT exact, so don't drop the client-side filter.
 *   - addPrivateNote() swallows all errors (fire-and-forget, matches
 *     source behavior) — it will never throw, but also never tells you it
 *     failed. Check logs/observability on the calling app side if you need
 *     delivery confidence.
 *   - NOT extracted (out of scope for Bucket 1): conversation labels,
 *     conversation status toggling, inbox management, team management,
 *     webhook registration, agent-bot attach, conversation custom
 *     attributes. See the source file if you need those later.
 *
 * READ ADDITIONS (Lane 1 revenue-MCP milestone, 2026-08-06)
 *   getConversationRaw() / listMessagesRaw() / getContactRaw() — added so
 *   lib/revenue-mcp/context-read.ts never has to open its own fetch() against
 *   Chatwoot. Named `*Raw` deliberately: these return whatever Chatwoot sends,
 *   unprojected. NOTHING may print or return a `*Raw` result directly —
 *   lib/revenue-mcp/context-read.ts is the one caller, and it projects every
 *   field it hands back through an explicit allowlist, the same discipline
 *   scripts/src/guard-chatwoot-safe-read.ts enforces for inbox/agent_bot
 *   reads. inboxes, webhooks and agent_bots are NOT read from this module by
 *   design — those are exactly the endpoints that leaked credentials
 *   (see guard-chatwoot-safe-read.ts's header) and this feature never needs
 *   them.
 */

export interface ChatwootConfig {
  baseUrl:   string   // e.g. 'https://inbox.epic.dm' (no trailing slash)
  accountId: string
  token:     string   // per-account agent API access token
}

export interface ChatwootContact {
  id: number
  name: string
  phone_number: string | null
}

export interface ChatwootConversation {
  id: number
  status: string
  inbox_id: number
}

function headers(config: ChatwootConfig): Record<string, string> {
  return { 'Content-Type': 'application/json', api_access_token: config.token }
}

function base(config: ChatwootConfig): string {
  return `${config.baseUrl.replace(/\/+$/, '')}/api/v1/accounts/${config.accountId}`
}

// ── Contacts ──────────────────────────────────────────────────────────────────

/**
 * Search Chatwoot contacts by phone number. Returns the first EXACT match
 * or null if not found (Chatwoot's own search is fuzzy, so results are
 * filtered client-side).
 */
export async function searchContactByPhone(
  config: ChatwootConfig,
  phone: string,
): Promise<ChatwootContact | null> {
  const res = await fetch(
    `${base(config)}/contacts/search?q=${encodeURIComponent(phone)}&include_contacts=true`,
    { headers: headers(config), signal: AbortSignal.timeout(10000) },
  )
  if (!res.ok) return null
  const data = await res.json()
  const contacts: ChatwootContact[] = data?.payload ?? []
  return contacts.find((c) => c.phone_number === phone) ?? null
}

/** Create a new Chatwoot contact. */
export async function createContact(
  config: ChatwootConfig,
  phone: string,
  name?: string,
): Promise<ChatwootContact> {
  const res = await fetch(`${base(config)}/contacts`, {
    method: 'POST',
    headers: headers(config),
    body: JSON.stringify({ phone_number: phone, name: name || phone }),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`createContact failed (${res.status}): ${body}`)
  }
  const data = await res.json()
  // POST /contacts returns {"payload":{"contact":{...},"contact_inbox":{...}}}
  // Fall back to the top-level object for API versions that return it flat.
  return (data?.payload?.contact ?? data) as ChatwootContact
}

/**
 * Find or create a contact. Returns the Chatwoot contact ID. Normalizes
 * phone to E.164 (leading '+') first — Chatwoot 422s on bare digits.
 */
export async function upsertContact(
  config: ChatwootConfig,
  phone: string,
  name?: string,
): Promise<number> {
  const e164 = phone.startsWith('+') ? phone : '+' + phone.replace(/[^\d]/g, '')
  const existing = await searchContactByPhone(config, e164)
  if (existing) return existing.id
  const created = await createContact(config, e164, name)
  return created.id
}

// ── Conversations ─────────────────────────────────────────────────────────────

/** Fetch conversations for a Chatwoot contact. Returns [] on any failure. */
export async function getContactConversations(
  config: ChatwootConfig,
  chatwootContactId: number,
): Promise<ChatwootConversation[]> {
  const res = await fetch(`${base(config)}/contacts/${chatwootContactId}/conversations`, {
    headers: headers(config),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) return []
  const data = await res.json()
  return data?.payload ?? []
}

/** Create a new Chatwoot conversation. */
export async function createConversation(
  config: ChatwootConfig,
  chatwootContactId: number,
  inboxId: number,
  label?: string,
): Promise<ChatwootConversation> {
  const body: Record<string, any> = {
    contact_id: chatwootContactId,
    inbox_id: inboxId,
    status: 'open',
  }
  if (label) body.labels = [label]

  const res = await fetch(`${base(config)}/conversations`, {
    method: 'POST',
    headers: headers(config),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`createConversation failed (${res.status}): ${err}`)
  }
  return res.json()
}

// ── Messages ──────────────────────────────────────────────────────────────────

/**
 * Add a message to a Chatwoot conversation (a visible reply).
 * message_type: "incoming" = from customer, "outgoing" = from agent
 */
export async function addMessage(
  config: ChatwootConfig,
  chatwootConversationId: number,
  content: string,
  messageType: 'incoming' | 'outgoing' = 'incoming',
  contentAttributes?: Record<string, unknown>,
): Promise<{ id: number }> {
  const res = await fetch(
    `${base(config)}/conversations/${chatwootConversationId}/messages`,
    {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify({
        content,
        message_type: messageType,
        private: false,
        ...(contentAttributes ? { content_attributes: contentAttributes } : {}),
      }),
      signal: AbortSignal.timeout(10000),
    },
  )
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`addMessage failed (${res.status}): ${err}`)
  }
  return res.json()
}

/**
 * Add an internal (operator-only) private note to a conversation.
 * Fire-and-forget: swallows all errors, never throws (matches source
 * behavior exactly).
 */
export async function addPrivateNote(
  config: ChatwootConfig,
  chatwootConversationId: number,
  content: string,
): Promise<void> {
  await fetch(
    `${base(config)}/conversations/${chatwootConversationId}/messages`,
    {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify({
        content,
        message_type: 'outgoing',
        private: true,
      }),
      signal: AbortSignal.timeout(10000),
    },
  ).catch(() => null)
}

// ── Read-only additions — unprojected. See the module header. ─────────────────

/**
 * `GET /conversations/{id}`. Returns `null` on 404 (not "this account's
 * conversation" is a caller-side distinction, not this function's) and
 * throws on any other non-2xx or network failure, matching the rest of this
 * module's `createConversation`/`addMessage` error style.
 */
export async function getConversationRaw(
  config: ChatwootConfig,
  chatwootConversationId: number,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${base(config)}/conversations/${chatwootConversationId}`, {
    headers: headers(config),
    signal: AbortSignal.timeout(10000),
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`getConversation failed (${res.status}): ${err}`)
  }
  return res.json()
}

/**
 * `GET /conversations/{id}/messages`. Chatwoot has no server-side `limit`
 * query param on this endpoint (it paginates by `before`), so `limit` is
 * enforced HERE, client-side, by slicing to the most recent N after the
 * fetch — the point is that no caller of this function can accidentally pull
 * "full message history", which lib/revenue-mcp/context-read.ts's contract
 * forbids returning.
 */
export async function listMessagesRaw(
  config: ChatwootConfig,
  chatwootConversationId: number,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const res = await fetch(
    `${base(config)}/conversations/${chatwootConversationId}/messages`,
    { headers: headers(config), signal: AbortSignal.timeout(10000) },
  )
  if (res.status === 404) return []
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`listMessages failed (${res.status}): ${err}`)
  }
  const data = await res.json()
  const all: Record<string, unknown>[] = Array.isArray(data?.payload) ? data.payload : []
  // Chatwoot returns oldest-first within a page; take the most RECENT `limit`.
  return all.slice(Math.max(0, all.length - limit))
}

/** `GET /contacts/{id}`. Returns `null` on 404. */
export async function getContactRaw(
  config: ChatwootConfig,
  chatwootContactId: number,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${base(config)}/contacts/${chatwootContactId}`, {
    headers: headers(config),
    signal: AbortSignal.timeout(10000),
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`getContact failed (${res.status}): ${err}`)
  }
  const data = await res.json()
  return (data?.payload ?? data) as Record<string, unknown>
}

