/**
 * whatsapp.ts — Portable WhatsApp Cloud API send client (Bucket 1 extraction)
 *
 * Extracted from (deepseek): /opt/bff-v2/app/lib/whatsapp.ts
 *   sendWhatsAppMessage()  source L168-193 → renamed sendText(config, input)
 *   sendWhatsAppTemplate() source L213-245 → renamed sendTemplate(config, input)
 *
 * WHAT THIS DOES
 *   Raw POSTs to the Meta WhatsApp Cloud (Graph) API
 *   `https://graph.facebook.com/{graphVersion}/{phoneId}/messages` — one
 *   free-text send, one pre-approved-template send. Nothing else.
 *
 * CONFIG REQUIRED — WhatsAppConfig
 *   { graphVersion? }
 *     graphVersion — optional, defaults to 'v25.0'
 *   Per-call inputs (NOT config, since these vary per tenant/agent/send):
 *     phoneId — Meta phone-number id (numeric string) to send FROM
 *     token   — Meta WhatsApp access token for that phone number / WABA
 *     to      — recipient phone in the format Meta expects (E.164 digits, no '+')
 *
 * CAUTION — GATING IS DELIBERATELY NOT HERE
 *   The original source routed every send through a P0-0 consent/compliance
 *   gate (evaluateWaSend / gateAndDispatch in wa-send-gate.ts) BEFORE the
 *   Meta fetch fired, plus an outbound mirror to an internal inbox
 *   (paperclipMirrorOutbound) and a runtime kill-switch (getSetting). ALL of
 *   that has been stripped from this module — it is Bucket 2 territory.
 *   These two functions are the RAW send calls only. The calling app MUST
 *   implement and pass its own consent/compliance gate and call sendText /
 *   sendTemplate ONLY after that gate allows the send. Calling these
 *   directly with no upstream gate will send real WhatsApp messages with no
 *   compliance check.
 *   - Free-form text (sendText) only delivers inside the 24-hour customer
 *     service window; outside it, Meta returns HTTP 200 but delivery fails
 *     asynchronously (error 131047) — use sendTemplate for anything proactive.
 *   - The 767-818-xxxx sender-number branding policy and the PHONE_ID_MAP /
 *     resolveAgentSenderPhoneId lookup logic from the source file are NOT
 *     extracted — the calling app supplies phoneId directly.
 */

export interface WhatsAppConfig {
  graphVersion?: string   // defaults to 'v25.0'
}

export interface WhatsAppSendTextInput {
  phoneId: string
  token:   string
  to:      string
  body:    string
}

export interface WhatsAppSendTemplateInput {
  phoneId:  string
  token:    string
  to:       string
  name:     string
  language: string     // e.g. 'en_US'
  params?:  string[]   // positional body-text params, in order
  /**
   * Developer-defined payloads for the template's QUICK_REPLY buttons, in
   * button order. Meta freezes a template's button LABELS at approval time,
   * but the payload is supplied per send — that is what lets a frozen button
   * carry a per-episode correlation id.
   *
   * A tap on one of these arrives inbound as `msg.type === 'button'` with
   * `msg.button.payload`, NOT as `interactive.button_reply`. Both shapes are
   * normalised to the same tap id at the webhook boundary.
   */
  quickReplyPayloads?: string[]
}

export interface WhatsAppSendAuthTemplateInput {
  phoneId:  string
  token:    string
  to:       string
  name:     string
  language: string  // e.g. 'en_US'
  /** the OTP code itself — used as BOTH the BODY {{1}} and the OTP button's URL {{1}}, per Meta's AUTHENTICATION template contract */
  code:     string
}

export interface WhatsAppSendResult {
  ok:         boolean
  status:     number
  messageId?: string
  error?:     string
  raw?:       unknown
}

const DEFAULT_GRAPH_VERSION = 'v25.0'

async function postToGraph(
  config: WhatsAppConfig,
  phoneId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<WhatsAppSendResult> {
  const version = config.graphVersion || DEFAULT_GRAPH_VERSION
  const res = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  const raw = await res.json().catch(() => undefined)
  if (!res.ok) {
    const error = (raw as any)?.error?.message || `WhatsApp send failed (HTTP ${res.status})`
    return { ok: false, status: res.status, error, raw }
  }
  const messageId = (raw as any)?.messages?.[0]?.id
  return { ok: true, status: res.status, messageId, raw }
}

/**
 * sendText — free-form text message. Only delivers inside the 24h customer
 * service window (see CAUTION above).
 */
export async function sendText(
  config: WhatsAppConfig,
  input: WhatsAppSendTextInput,
): Promise<WhatsAppSendResult> {
  if (!input.body?.trim()) {
    return { ok: false, status: 0, error: 'empty message body — nothing sent' }
  }
  return postToGraph(config, input.phoneId, input.token, {
    messaging_product: 'whatsapp',
    to: input.to,
    type: 'text',
    text: { body: input.body },
  })
}

/**
 * sendTemplate — pre-approved WhatsApp message template. Delivers even when
 * the 24-hour customer-service window is closed.
 */
export async function sendTemplate(
  config: WhatsAppConfig,
  input: WhatsAppSendTemplateInput,
): Promise<WhatsAppSendResult> {
  const params = input.params ?? []
  const components: Record<string, unknown>[] = params.length
    ? [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: t })) }]
    : []

  // One component per quick-reply button. Meta indexes buttons positionally
  // and rejects the ENTIRE send if an index has no matching button on the
  // approved template, so payloads must be passed in button order.
  const quickReplies = input.quickReplyPayloads ?? []
  quickReplies.forEach((payload, index) => {
    components.push({
      type: 'button',
      sub_type: 'quick_reply',
      index: String(index),
      parameters: [{ type: 'payload', payload }],
    })
  })

  return postToGraph(config, input.phoneId, input.token, {
    messaging_product: 'whatsapp',
    to: input.to,
    type: 'template',
    template: {
      name: input.name,
      language: { code: input.language },
      ...(components.length ? { components } : {}),
    },
  })
}

/**
 * sendAuthTemplate — sends a Meta AUTHENTICATION-category template with a
 * COPY_CODE OTP button (e.g. an approved "ema_otp" template). Delivers even
 * when the 24-hour customer-service window is closed — this is the "cold"
 * OTP path. The code is threaded into both the BODY {{1}} placeholder and
 * the OTP button's URL {{1}} placeholder, matching Meta's documented
 * request shape for AUTHENTICATION templates with an OTP button.
 */
export async function sendAuthTemplate(
  config: WhatsAppConfig,
  input: WhatsAppSendAuthTemplateInput,
): Promise<WhatsAppSendResult> {
  return postToGraph(config, input.phoneId, input.token, {
    messaging_product: 'whatsapp',
    to: input.to,
    type: 'template',
    template: {
      name: input.name,
      language: { code: input.language },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: input.code }] },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: input.code }],
        },
      ],
    },
  })
}


/**
 * ── Interactive messages ────────────────────────────────────────────────────
 *
 * IN-WINDOW ONLY. Like `sendText`, these deliver only inside the 24-hour
 * customer-service window; outside it Meta answers 200 and then fails the
 * message asynchronously with 131047. The first proactive contact must still be
 * a template — see lib/staff-ops/staff-notification.ts for that policy.
 *
 * A tap returns the developer-defined `id` verbatim on the inbound webhook, so
 * the id is the contract: it carries the action AND the work reference, which
 * is what removes typed references from the staff loop.
 */

export interface WhatsAppInteractiveButton {
  /** Echoed back on tap. Max 256 chars. */
  id: string
  /** Visible label. Max 20 chars — Meta rejects longer, it does not truncate. */
  title: string
}

export interface WhatsAppSendButtonsInput {
  phoneId: string
  token: string
  to: string
  body: string
  buttons: WhatsAppInteractiveButton[]
  header?: string
  footer?: string
}

/**
 * sendInteractiveButtons — up to THREE inline reply buttons.
 *
 * Validates before sending rather than after: a fourth button, an over-long
 * title or an empty body is a 400 from Meta that would otherwise be recorded as
 * a delivery failure against the staff member, which reads as "unreachable"
 * instead of "we built a bad payload".
 */
export async function sendInteractiveButtons(
  config: WhatsAppConfig,
  input: WhatsAppSendButtonsInput,
): Promise<WhatsAppSendResult> {
  if (!input.body?.trim()) {
    return { ok: false, status: 0, error: 'empty interactive body — nothing sent' }
  }
  if (input.buttons.length < 1 || input.buttons.length > 3) {
    return { ok: false, status: 0, error: `interactive buttons must be 1..3, got ${input.buttons.length}` }
  }
  for (const b of input.buttons) {
    if (!b.id || b.id.length > 256) {
      return { ok: false, status: 0, error: `button id must be 1..256 chars: ${b.id?.length ?? 0}` }
    }
    if (!b.title?.trim() || b.title.length > 20) {
      return { ok: false, status: 0, error: `button title must be 1..20 chars: "${b.title}"` }
    }
  }

  return postToGraph(config, input.phoneId, input.token, {
    messaging_product: 'whatsapp',
    to: input.to,
    type: 'interactive',
    interactive: {
      type: 'button',
      ...(input.header ? { header: { type: 'text', text: input.header } } : {}),
      body: { text: input.body },
      ...(input.footer ? { footer: { text: input.footer } } : {}),
      action: {
        buttons: input.buttons.map((b) => ({
          type: 'reply',
          reply: { id: b.id, title: b.title },
        })),
      },
    },
  })
}

export interface WhatsAppListRow {
  id: string
  /** Max 24 chars. */
  title: string
  /** Max 72 chars. */
  description?: string
}

export interface WhatsAppSendListInput {
  phoneId: string
  token: string
  to: string
  body: string
  /** Label on the button that opens the list. Max 20 chars. */
  buttonText: string
  rows: WhatsAppListRow[]
  sectionTitle?: string
  header?: string
  footer?: string
}

/**
 * sendInteractiveList — up to TEN rows behind a single "open menu" button.
 *
 * Used when more actions are valid than will fit in three buttons. The trade is
 * deliberate: a list hides the options behind one tap, so buttons stay the
 * default for the common two-or-three-action case.
 */
export async function sendInteractiveList(
  config: WhatsAppConfig,
  input: WhatsAppSendListInput,
): Promise<WhatsAppSendResult> {
  if (!input.body?.trim()) {
    return { ok: false, status: 0, error: 'empty interactive body — nothing sent' }
  }
  if (!input.buttonText?.trim() || input.buttonText.length > 20) {
    return { ok: false, status: 0, error: `list button text must be 1..20 chars: "${input.buttonText}"` }
  }
  if (input.rows.length < 1 || input.rows.length > 10) {
    return { ok: false, status: 0, error: `list rows must be 1..10, got ${input.rows.length}` }
  }
  for (const r of input.rows) {
    if (!r.id || r.id.length > 200) {
      return { ok: false, status: 0, error: `row id must be 1..200 chars: ${r.id?.length ?? 0}` }
    }
    if (!r.title?.trim() || r.title.length > 24) {
      return { ok: false, status: 0, error: `row title must be 1..24 chars: "${r.title}"` }
    }
    if (r.description && r.description.length > 72) {
      return { ok: false, status: 0, error: `row description must be <=72 chars: ${r.description.length}` }
    }
  }

  return postToGraph(config, input.phoneId, input.token, {
    messaging_product: 'whatsapp',
    to: input.to,
    type: 'interactive',
    interactive: {
      type: 'list',
      ...(input.header ? { header: { type: 'text', text: input.header } } : {}),
      body: { text: input.body },
      ...(input.footer ? { footer: { text: input.footer } } : {}),
      action: {
        button: input.buttonText,
        sections: [
          {
            title: input.sectionTitle ?? 'Actions',
            rows: input.rows.map((r) => ({
              id: r.id,
              title: r.title,
              ...(r.description ? { description: r.description } : {}),
            })),
          },
        ],
      },
    },
  })
}
