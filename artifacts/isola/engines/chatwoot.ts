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
 * List every message in a conversation. Read-only, best-effort — returns []
 * on any transport failure rather than throwing, because every caller of
 * this so far is a soft check (e.g. "has this already been posted?"), never
 * a governed-send readback — `findMessage` below is that, and stays
 * separate and unchanged.
 */
export async function listMessages(
  config: ChatwootConfig,
  chatwootConversationId: number,
): Promise<Record<string, unknown>[]> {
  const res = await fetch(
    `${base(config)}/conversations/${chatwootConversationId}/messages`,
    { headers: headers(config), signal: AbortSignal.timeout(10000) },
  )
  if (!res.ok) return []
  const data = await res.json().catch(() => null)
  return Array.isArray(data?.payload) ? (data.payload as Record<string, unknown>[]) : []
}

/**
 * Read ONE message back from a conversation, by id.
 *
 * This is the authoritative readback for a governed send: the only evidence
 * that what we posted is really there and really customer-visible. It therefore
 * THROWS on transport failure rather than returning null — "the platform did not
 * answer" and "the message is not there" are different facts, and collapsing
 * them would let an unproven send report as a clean failure.
 *
 * Returns null only when the conversation genuinely has no message with that id.
 */
export async function findMessage(
  config: ChatwootConfig,
  chatwootConversationId: number,
  messageId: number,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(
    `${base(config)}/conversations/${chatwootConversationId}/messages`,
    { headers: headers(config), signal: AbortSignal.timeout(10000) },
  )
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`findMessage failed (${res.status}): ${err}`)
  }
  const data = await res.json()
  const messages: Array<Record<string, unknown>> = data?.payload ?? []
  return messages.find((m) => Number(m.id) === messageId) ?? null
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

