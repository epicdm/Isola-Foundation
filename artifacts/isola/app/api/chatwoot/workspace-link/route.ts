/**
 * POST /api/chatwoot/workspace-link
 *
 * THE LINK-OUT (dec-one-customer-workspace-mounted-twice-2026-09-06, ruled
 * 2026-09-06). No Chatwoot Dashboard App has ever worked in this org
 * (defect-dashboard-app-architecture-gap-2026-08-21) — the one iframe
 * registration attempt was abandoned. This is the shippable-today
 * substitute: on a new conversation, post ONE private note carrying a link
 * to the customer workspace in the portal, scoped to that conversation's
 * own contact. This is a SCOPE CHANGE from "the 360 tab lives inside
 * Chatwoot" — it is one click away from Chatwoot, not embedded in it. Say
 * so plainly wherever this is described; do not describe it as an embed.
 *
 * SEPARATE from app/api/chatwoot/agent-bot and app/api/chatwoot/webhook —
 * deliberately its own route, its own secret, its own event filter. Those
 * two files gate live AI-reply and human-handoff behaviour for every A2/
 * mirror tenant; this one does nothing but read a phone number and post a
 * private note, so it must never share a code path with them where a bug
 * here could touch customer-facing message routing.
 *
 * SCOPE: only conversation_created events on EPIC's own three doors
 * (EPIC_CHATWOOT_DOORS — inboxes 7/8/12, lib/epic-owner-chatwoot-seed-
 * data.ts) are acted on. Any other inbox, or any other event, is a 200 no-op
 * — this webhook is not a general-purpose relay and must never become one
 * by accident.
 *
 * IDEMPOTENCY: no new schema. Before posting, this reads the conversation's
 * own messages back from Chatwoot and skips if a note carrying
 * WORKSPACE_LINK_MARKER is already there — safe against Chatwoot redelivery
 * without a new persistent marker.
 *
 * TENANT / ODOO: EPIC_OWNER_TENANT_ID is a fixed id read directly from the
 * database (see lib/epic-owner-chatwoot-seed-data.ts's own header) — the
 * same tenant every other Customer 360 read in this codebase resolves Odoo
 * through, via resolveOdooConfigForTenant. Never re-derived here.
 *
 * AUTH: ?secret=<CHATWOOT_WORKSPACE_LINK_WEBHOOK_SECRET>, constant-time
 * compare, fail-closed if unset — identical discipline to
 * app/api/chatwoot/webhook/route.ts.
 */

import { NextRequest, NextResponse } from 'next/server'

import { findCustomerByPhone } from '@/engines/odoo'
import { addPrivateNote, listMessages } from '@/engines/chatwoot'
import { getChatwootConfig } from '@/lib/engines'
import { resolveOdooConfigForTenant } from '@/lib/engine-bindings'
import {
  EPIC_CHATWOOT_ACCOUNT_ID,
  EPIC_CHATWOOT_BASE_URL,
  EPIC_CHATWOOT_DOORS,
  EPIC_CHATWOOT_SERVICE_TOKEN_REF,
  EPIC_OWNER_TENANT_ID,
} from '@/lib/epic-owner-chatwoot-seed-data'
import { buildWorkspaceLink, workspaceLinkNoteContent, WORKSPACE_LINK_MARKER } from '@/lib/chatwoot-workspace-link'

const EPIC_DOOR_INBOX_IDS = new Set(EPIC_CHATWOOT_DOORS.map((d) => d.inboxId))

function authenticate(req: NextRequest): boolean {
  const expected = process.env.CHATWOOT_WORKSPACE_LINK_WEBHOOK_SECRET
  if (!expected) {
    console.error('[chatwoot/workspace-link] CHATWOOT_WORKSPACE_LINK_WEBHOOK_SECRET is not set — rejecting')
    return false
  }
  const provided = new URL(req.url).searchParams.get('secret') ?? ''
  if (provided.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: Record<string, any>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  try {
    if (body?.event === 'conversation_created') {
      await handleConversationCreated(body)
    }
    // Every other event: ack and ignore. This webhook has exactly one job.
    return NextResponse.json({ ok: true })
  } catch (err: any) {
    console.error('[chatwoot/workspace-link] unexpected error:', err?.message ?? err)
    // 500 so Chatwoot retries — the idempotency check above makes a retry safe.
    return NextResponse.json({ error: 'internal error' }, { status: 500 })
  }
}

async function handleConversationCreated(body: Record<string, any>): Promise<void> {
  const cwConvId: number | null = typeof body.id === 'number' ? body.id : null
  if (cwConvId === null) return

  const inboxId: string | null = body.inbox_id != null ? String(body.inbox_id) : null
  if (!inboxId || !EPIC_DOOR_INBOX_IDS.has(inboxId)) {
    // Not one of EPIC's own three doors — not this webhook's concern.
    return
  }

  const rawPhone: string = body.meta?.sender?.phone_number ?? ''
  const digits = rawPhone.replace(/[^\d]/g, '')
  if (!digits) {
    console.log('[chatwoot/workspace-link] conv', cwConvId, '— no sender phone, skipping')
    return
  }

  const chatwootConfig = getChatwootConfig({
    base_url: EPIC_CHATWOOT_BASE_URL,
    account_id: EPIC_CHATWOOT_ACCOUNT_ID,
    token: EPIC_CHATWOOT_SERVICE_TOKEN_REF,
  })

  // Idempotency BEFORE any lookup — a redelivered event should cost nothing
  // beyond one read, not a second Odoo search.
  const existing = await listMessages(chatwootConfig, cwConvId)
  const alreadyPosted = existing.some(
    (m) => typeof m.content === 'string' && m.content.includes(WORKSPACE_LINK_MARKER),
  )
  if (alreadyPosted) {
    console.log('[chatwoot/workspace-link] conv', cwConvId, '— note already posted, skipping')
    return
  }

  const odooConfig = await resolveOdooConfigForTenant(EPIC_OWNER_TENANT_ID)
  const customer = await findCustomerByPhone(odooConfig, digits)
  if (!customer) {
    console.log('[chatwoot/workspace-link] conv', cwConvId, '— no Odoo customer for this phone, skipping')
    return
  }

  const link = buildWorkspaceLink(process.env.ISOLA_WORKSPACE_LINK_BASE_URL, customer.id)
  if (!link) {
    console.warn(
      '[chatwoot/workspace-link] conv', cwConvId,
      '— ISOLA_WORKSPACE_LINK_BASE_URL is not configured or invalid, cannot build a link',
    )
    return
  }

  await addPrivateNote(chatwootConfig, cwConvId, workspaceLinkNoteContent(link))
  console.log('[chatwoot/workspace-link] conv', cwConvId, '— posted workspace link for customer', customer.id)
}
