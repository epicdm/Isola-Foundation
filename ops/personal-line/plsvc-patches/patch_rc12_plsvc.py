#!/usr/bin/env python3
# rc12 plsvc patch (owner mission 2026-10-10: state-aware concierge). Run in the ISOLATED source copy (src-rc10), never a live checkout.
# Every anchor must match exactly once; each touched file is backed up once as <file>.pre-rc12. Idempotent: refuses a second run.
import os, sys, shutil
ROOT = sys.argv[1]
def P(rel): return os.path.join(ROOT, rel)
def edit(rel, pairs):
    path = P(rel)
    s = open(path, encoding='utf-8').read()
    if 'rc12' in s and rel != 'app/lib/lite-registration-watch.ts':
        pass
    for old, new in pairs:
        n = s.count(old)
        if n != 1: sys.exit(f'ANCHOR {rel}: expected 1 match, found {n}: {old[:90]!r}')
        s = s.replace(old, new)
    if not os.path.exists(path + '.pre-rc12'): shutil.copy2(path, path + '.pre-rc12')
    open(path, 'w', encoding='utf-8', newline='').write(s)
    print('patched', rel)

# ── service.ts ──────────────────────────────────────────────────────────────
edit('app/lib/pl-concierge/service.ts', [
 ("export type Endpoint = 'offer' | 'account/line-status' | 'account/balance' | 'account/recent-calls' | 'account/next-step' | 'flows/launch' | 'lines/provision' | 'lines/status' | 'links/activation'\nexport const READ_ENDPOINTS: Endpoint[] = ['offer', 'account/line-status', 'account/balance', 'account/recent-calls', 'lines/status']",
  "export type Endpoint = 'offer' | 'account/line-status' | 'account/balance' | 'account/recent-calls' | 'account/journey' | 'account/next-step' | 'flows/launch' | 'lines/provision' | 'lines/status' | 'links/activation'\nexport const READ_ENDPOINTS: Endpoint[] = ['offer', 'account/line-status', 'account/balance', 'account/recent-calls', 'account/journey', 'lines/status']"),
 ("  'offer': [], 'account/line-status': [], 'account/balance': [], 'account/recent-calls': [], 'lines/status': [],\n",
  "  'offer': [], 'account/line-status': [], 'account/balance': [], 'account/recent-calls': [], 'account/journey': [], 'lines/status': [],\n"),
 ("// ── /account/recent-calls ────────────────────────────────────────────────────\n",
  """// ── /account/journey (rc12) ──────────────────────────────────────────────────
// The customer's journey state + next actions (journey.ts), from the SAME reads line-status and balance make. Data only:
// the adapter words it, the Flow Done acknowledgement and the proactive follow-ups choose from it, the operator UI shows it.
async function journey(ctx: Ctx): Promise<Outcome> {
  const { classifyJourney, paymentState } = await import('@/app/lib/pl-concierge/journey')
  const payment = paymentState()
  const b = await boundAccount(ctx)
  if (b.kind === 'ambiguous') return b.out
  if (b.kind === 'none') {
    const j = classifyJourney({ hasLine: false, softphoneActivated: false, registration: 'unknown', firstCallDone: null, balanceKnown: false, minutesRemaining: null, low: false, planExpiresAt: null }, { topupAvailable: payment.topup_available })
    return { code: 'journey', data: { ...j, has_line: false, facts: null, payment } }
  }
  const [ls, bal] = await Promise.all([lineStatus(ctx), balance(ctx)])
  if (ls.code !== 'line_status') return ls
  const l: any = ls.data ?? {}
  const d: any = bal.code === 'balance' ? (bal.data ?? {}) : {}
  const facts = {
    did_pretty: l.did_pretty ?? null, did_masked: l.did_masked ?? null,
    registration: typeof l.registration === 'string' ? l.registration : 'unknown', softphone_activated: l.softphone_activated === true,
    first_call_done: typeof l.first_call_done === 'boolean' ? l.first_call_done : null, inbound_enabled: l.inbound_enabled === true,
    plan: l.plan ?? null, plan_expires_at: l.plan_expires_at ?? null,
    balance_known: d.known === true, balance_kind: d.kind ?? 'unknown', plan_name: d.plan_name ?? null,
    minutes_included: d.minutes_included ?? null, minutes_remaining: d.minutes_remaining ?? null, low: d.low === true,
    expires_at: d.expires_at ?? null, expires_date_pretty: d.expires_date_pretty ?? null, wallet_xcd: d.wallet_xcd ?? null,
    overage_dominica_xcd: PL_OVERAGE_RATES_XCD.dominica, overage_uscan_xcd: PL_OVERAGE_RATES_XCD.usCan,
  }
  const j = classifyJourney({
    hasLine: true, softphoneActivated: facts.softphone_activated, registration: facts.registration, firstCallDone: facts.first_call_done,
    balanceKnown: facts.balance_known, minutesRemaining: typeof facts.minutes_remaining === 'number' ? facts.minutes_remaining : null,
    low: facts.low, planExpiresAt: facts.expires_at ?? facts.plan_expires_at,
  }, { topupAvailable: payment.topup_available })
  return { code: 'journey', accountHash: ls.accountHash, data: { ...j, has_line: true, facts, payment } }
}

// ── /account/recent-calls ────────────────────────────────────────────────────
"""),
 ("  const body = existing\n    ? `You already have your Isola line ${didPretty(existing.did) ?? ''}. Open this to check your line and finish setting it up in the free Cloud Softphone app - nothing new will be created.`\n",
  "  // rc12: a line holder gets 'Manage your line' (never signup copy); the Flow opens on their CURRENT step.\n  const body = existing\n    ? `Your Isola line ${didPretty(existing.did) ?? ''}. Open this to see your line, your connection and your balance - and to finish setting up the free Cloud Softphone app if it isn't done yet. Nothing new will be created.`\n"),
 ("  try { decision = await sendPlSignupFlow(ctx.a.wa_id, token, body, { senderPath: 'pl:flows/launch', userId: existing?.userId, sourceEventType: 'pl_verified_inbound', sourceEventId: ctx.a.mid }) }",
  "  try { decision = await sendPlSignupFlow(ctx.a.wa_id, token, body, { senderPath: 'pl:flows/launch', userId: existing?.userId, sourceEventType: 'pl_verified_inbound', sourceEventId: ctx.a.mid }, existing ? { header: 'Manage your line', cta: 'Manage my line' } : undefined) }"),
 ("  'account/recent-calls': recentCalls,\n", "  'account/recent-calls': recentCalls,\n  'account/journey': journey,\n"),
])

# ── http-map.ts ─────────────────────────────────────────────────────────────
edit('app/lib/pl-concierge/http-map.ts', [
 ("  recent_calls:       { http: 200, status: 'ok' },\n", "  recent_calls:       { http: 200, status: 'ok' },\n  journey:            { http: 200, status: 'ok' },\n"),
])

# ── whatsapp.ts: optional header / CTA for the line-holder variant ───────────
edit('app/lib/whatsapp.ts', [
 ("export async function sendPlSignupFlow(toPhone: string, flowToken: string, bodyText: string, ctx?: Partial<WaSendContext>): Promise<GateDecision> {",
  "export async function sendPlSignupFlow(toPhone: string, flowToken: string, bodyText: string, ctx?: Partial<WaSendContext>, ui?: { header?: string; cta?: string }): Promise<GateDecision> {"),
 ("      header: { type: 'text', text: 'Get your free number' },\n      body: { text: bodyText.slice(0, 1024) },\n      footer: { text: 'Isola Personal Line' },\n      action: { name: 'flow', parameters: { flow_message_version: '3', flow_id: flowId, flow_cta: 'Start signup', flow_token: flowToken, mode: 'published', flow_action: 'data_exchange' } },",
  "      header: { type: 'text', text: (ui?.header || 'Get your free number').slice(0, 60) },\n      body: { text: bodyText.slice(0, 1024) },\n      footer: { text: 'Isola Personal Line' },\n      action: { name: 'flow', parameters: { flow_message_version: '3', flow_id: flowId, flow_cta: (ui?.cta || 'Start signup').slice(0, 20), flow_token: flowToken, mode: 'published', flow_action: 'data_exchange' } },"),
])

# ── signup-flow.ts: a line holder opens on their CURRENT step ────────────────
edit('app/lib/pl-concierge/signup-flow.ts', [
 ("    const held = await existingLine(wa)\n    if (held) return { screen: 'WELCOME', data: { offer_text: `You already have your Isola line ${formatDidDisplay(held)}.\\n\\nTap Continue to check your line and finish setting it up in the free Cloud Softphone app. Nothing new will be created.` } }\n",
  "    const held = await existingLine(wa)\n    if (held) {\n      // rc12: never walk a line holder through signup again - open on the step the next-step engine reads now\n      // (CONNECTED with balance for a working line). Any failure falls back to the existing-line welcome.\n      const s = await stepScreen(claims, 'status', '', 'line').catch(() => null)\n      if (s && s.screen && s.screen !== 'ERROR') return s\n      return { screen: 'WELCOME', data: { offer_text: `You already have your Isola line ${formatDidDisplay(held)}.\\n\\nTap Continue to check your line and finish setting it up in the free Cloud Softphone app. Nothing new will be created.` } }\n    }\n"),
])

# ── lite-registration-followups.ts: REGISTRATION_FOLLOWUPS=chatwoot + first_call ──
edit('app/lib/lite-registration-followups.ts', [
 ("export type FollowupKey = 'activated' | 'stalled:handoff_no_register' | 'stalled:peer_absent_from_conf' | 'stalled:link_not_opened' | 'stalled:no_handoff'",
  "export type FollowupKey = 'activated' | 'first_call' | 'stalled:handoff_no_register' | 'stalled:peer_absent_from_conf' | 'stalled:link_not_opened' | 'stalled:no_handoff'"),
 ("  if ((process.env.REGISTRATION_FOLLOWUPS ?? 'direct') === 'off') return { key, action: 'disabled' }\n  const m = (row.metadata ?? {}) as any\n  const stamps = (m.followups ?? {}) as Record<string, number>\n  if (stamps[key]) return { key, action: 'already_sent' }\n  const attempts = Number(((m.followupAttempts ?? {}) as Record<string, number>)[key] ?? 0)\n  if (attempts >= MAX_FOLLOWUP_ATTEMPTS) return { key, action: 'gave_up', detail: `${attempts} refusals` }\n  if (!acct.ownerPhone) return { key, action: 'no_owner_phone' }\n",
  "  const mode = process.env.REGISTRATION_FOLLOWUPS ?? 'direct'\n  if (mode === 'off') return { key, action: 'disabled' }\n  const m = (row.metadata ?? {}) as any\n  const stamps = (m.followups ?? {}) as Record<string, number>\n  if (stamps[key]) return { key, action: 'already_sent' }\n  const attempts = Number(((m.followupAttempts ?? {}) as Record<string, number>)[key] ?? 0)\n  if (attempts >= MAX_FOLLOWUP_ATTEMPTS) return { key, action: 'gave_up', detail: `${attempts} refusals` }\n  if (!acct.ownerPhone) return { key, action: 'no_owner_phone' }\n  // rc12: delivery through Chatwoot via the PL action adapter (ownership, STOP, 24 h window, dedup, state-aware wording).\n  if (mode === 'chatwoot') return deliverViaConcierge(acct, row, m, key)\n"),
 ("async function stamp(rowId: string, m: any, key: FollowupKey): Promise<void> {",
  """/**
 * rc12 REGISTRATION_FOLLOWUPS=chatwoot. The adapter decides (Chatwoot ownership, STOP, 24 h window, duplicate guard) and
 * composes from the customer's CURRENT journey state; this side keeps the once-per-verdict stamps. A held conversation is
 * retried after handback exactly as before; a definitive "no" (stopped, outside the window, no conversation, state already
 * moved on, already delivered) is SETTLED - stamped, with the reason - so it is never knocked on again.
 */
async function deliverViaConcierge(acct: { ownerPhone: string | null }, row: { id: string; metadata: any }, m: any, key: FollowupKey): Promise<FollowupResult> {
  const heldEarlier = !!((m.followupsHeld ?? {}) as Record<string, number>)[key]
  if (heldEarlier && (key === 'stalled:link_not_opened' || key === 'stalled:no_handoff')) {
    await supersede(row.id, m, key)
    return { key, action: 'superseded_by_takeover' }
  }
  const { sendProactiveViaAdapter } = await import('@/app/lib/pl-concierge/proactive')
  const r = await sendProactiveViaAdapter({ waId: String(acct.ownerPhone ?? ''), key, ref: row.id })
  if (r.code === 'sent') {
    await stamp(row.id, m, key)
    for (const k of r.covered ?? []) if (k !== key && (k === 'activated' || k === 'first_call')) await stamp(row.id, m, k as FollowupKey)
    return { key, action: 'sent', detail: r.covered?.length ? `covered:${r.covered.join(',')}` : undefined }
  }
  if (r.code === 'held') { await markHeld(row.id, m, key); return { key, action: 'held' } }
  if (r.code === 'duplicate') { await settle(row.id, m, key, r.code); return { key, action: 'already_sent', detail: r.code } }
  if (r.code === 'stopped' || r.code === 'outside_window' || r.code === 'no_conversation' || r.code === 'superseded_by_state') {
    await settle(row.id, m, key, r.code)
    return { key, action: 'not_delivered', detail: r.code }
  }
  await countAttempt(row.id, m, key)
  return { key, action: 'failed', detail: r.detail ? `${r.code}:${r.detail}` : r.code }
}

/** rc12: the first successful call on an activated hand-off (Magnus CDR via getFirstCallStatus), once per hand-off. */
export async function deliverFirstCallFollowup(args: { acct: { ownerPhone: string | null }; row: { id: string; metadata: any } }): Promise<FollowupResult> {
  if ((process.env.REGISTRATION_FOLLOWUPS ?? 'direct') !== 'chatwoot') return { key: 'first_call', action: 'disabled' }
  const m = (args.row.metadata ?? {}) as any
  if ((m.followups ?? {}).first_call) return { key: 'first_call', action: 'already_sent' }
  const attempts = Number((m.followupAttempts ?? {}).first_call ?? 0)
  if (attempts >= MAX_FOLLOWUP_ATTEMPTS) return { key: 'first_call', action: 'gave_up', detail: `${attempts} refusals` }
  if (!args.acct.ownerPhone) return { key: 'first_call', action: 'no_owner_phone' }
  return deliverViaConcierge(args.acct, args.row, m, 'first_call')
}

/** A definitive non-delivery: stamped (settled) with its reason, never retried. */
async function settle(rowId: string, m: any, key: FollowupKey, reason: string): Promise<void> {
  const followups = { ...((m.followups ?? {}) as Record<string, number>), [key]: Date.now() }
  const followupsSettled = { ...((m.followupsSettled ?? {}) as Record<string, string>), [key]: reason }
  m.followups = followups
  m.followupsSettled = followupsSettled
  await prisma.agentActivity.update({ where: { id: rowId }, data: { metadata: { ...m, followups, followupsSettled } } }).catch(() => null)
}

async function stamp(rowId: string, m: any, key: FollowupKey): Promise<void> {"""),
])

# ── lite-registration-watch.ts: first successful call, inside the horizon ────
edit('app/lib/lite-registration-watch.ts', [
 ("import { deliverRegistrationFollowup, type FollowupResult } from '@/app/lib/lite-registration-followups'",
  "import { deliverRegistrationFollowup, deliverFirstCallFollowup, type FollowupResult } from '@/app/lib/lite-registration-followups'"),
 ("          const heard = !!(m.followups ?? {}).activated\n          const gaveUp = Number((m.followupAttempts ?? {}).activated ?? 0) >= MAX_FOLLOWUP_ATTEMPTS\n          if (heard || gaveUp) continue\n",
  "          const heard = !!(m.followups ?? {}).activated\n          const gaveUp = Number((m.followupAttempts ?? {}).activated ?? 0) >= MAX_FOLLOWUP_ATTEMPTS\n          if (heard || gaveUp) {\n            // rc12: the next fact after registration is the first successful call (Magnus CDR, answered + duration > 0).\n            if ((process.env.REGISTRATION_FOLLOWUPS ?? 'direct') === 'chatwoot' && !(m.followups ?? {}).first_call\n                && Number((m.followupAttempts ?? {}).first_call ?? 0) < MAX_FOLLOWUP_ATTEMPTS) {\n              const { getFirstCallStatus } = await import('@/app/lib/lite-first-call-status')\n              const fc: any = await Promise.race([getFirstCallStatus(acct.userId).catch(() => null), new Promise(r => setTimeout(() => r(null), 4000))])\n              if (fc?.firstCallSucceeded) {\n                const f = await deliverFirstCallFollowup({ acct, row: { id: c.row.id, metadata: m } })\n                out.followups.push({ liteAccountId: acct.id, ...f })\n              }\n            }\n            continue\n          }\n"),
])

# ── route: /api/internal/pl-concierge/v1/account/journey ─────────────────────
rd = P('app/api/internal/pl-concierge/v1/account/journey')
os.makedirs(rd, exist_ok=True)
open(os.path.join(rd, 'route.ts'), 'w', encoding='utf-8', newline='').write("""/**
 * POST /api/internal/pl-concierge/v1/account/journey - the customer's journey state + next actions (rc12, journey.ts).
 * Same assertion, source gate, body schema, read rate limit and audit as every PL concierge endpoint (service.ts).
 */
import { handlePlConcierge } from '@/app/lib/pl-concierge/service'

export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
  return handlePlConcierge(req, 'account/journey')
}
""")
print('wrote route account/journey')
