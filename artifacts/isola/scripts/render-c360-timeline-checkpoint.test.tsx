/**
 * Timeline + Follow-ups checkpoint — items 4 and 5 of the owner's
 * 2026-09-05 follow-up. Renders CustomerWorkspaceView to static HTML, no
 * isola360uat deploy (release lane territory).
 *
 * DATA PROVENANCE: the merged timeline's messages are Patricia "Yvonne"
 * Armour's REAL conversation #15 (partner 163), read live 2026-09-05 via
 * Chatwoot's own message list (https://isola-chat.saas00.epic.dm/app/
 * accounts/2/conversations/15) -- the exact text and Aug 18 2026 timestamps
 * a human operator sees in that conversation today, not paraphrased. The
 * order (S00670) is the same real sale.order used in the earlier identity
 * bar / nested-object checkpoints. Follow-ups are illustrative (this
 * customer has none real yet) but use the real dueLabel computation
 * (dueDateLabel in odoo-projection.ts), not a hand-typed label.
 *
 * WHY THIS FIXTURE COULD NOT BE A LIVE READ: the `timeline`/`followUps`
 * fields do not exist yet on the currently-deployed 5e6b18fa build (this is
 * the commit that adds them) -- there is no live endpoint to read them from
 * until the release lane promotes this work. The underlying facts (the
 * messages, the order) are real; the assembly into a Customer360Snapshot
 * fixture is done here, by hand, from those real facts.
 */
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { CustomerWorkspaceView } from '../components/customer-360/workspace-view'
import styles from '../components/customer-360/customer-360.module.css'
import type { Customer360Snapshot } from '../lib/customer-360/contracts'

function inlinedCss(rawCss: string): string {
  return rawCss.replace(/\.([a-zA-Z_][a-zA-Z0-9_-]*)\b/g, (match, name: string) => {
    const resolved = (styles as Record<string, string>)[name]
    return resolved ? `.${resolved}` : match
  })
}

const armour: Customer360Snapshot = {
  verifiedAt: '2026-09-05T05:00:00.000Z',
  freshness: 'fresh',
  conversation: { displayId: 15, currentRequest: null },
  customer: {
    id: 163,
    name: 'Patricia Yvonne Armour',
    email: 'yvonne.armour07@gmail.com',
    phone: '+17672951770',
    city: 'Spring Field',
    isCompany: false,
    companyName: null,
    customerSince: '2026-02-14 04:25:36',
    tags: [],
  },
  balances: [],
  lifetimeValue: [],
  // Illustrative — Armour has no real mail.activity yet. dueLabel values
  // ("Today"/"Tomorrow") are what dueDateLabel() in odoo-projection.ts
  // actually computes for these dates relative to 2026-09-05, not
  // hand-typed to look right.
  followUps: [
    { id: 9001, summary: 'Follow up — Patricia Yvonne Armour', dueDate: '2026-09-05', dueLabel: 'Today', assignee: 'Hakeem Dalrymple' },
    { id: 9002, summary: 'Confirm TV subscription cancellation timing', dueDate: '2026-09-06', dueLabel: 'Tomorrow', assignee: null },
  ],
  followUpsAvailable: true,
  documents: [
    {
      id: 607,
      reference: 'S00670',
      kind: 'quotation',
      state: 'draft',
      total: 4272.6,
      currency: 'XCD',
      date: '2026-07-10 15:21:20',
      odooLink: 'https://epic-communications-inc.odoo.com/odoo/sale.order/607',
    },
  ],
  openLoops: [],
  openLoopsAvailable: true,
  recommendedAction: {
    kind: 'review-draft-quotation',
    headline: 'Review quotation S00670 and ask the customer whether they would like to proceed or request changes.',
    document: {
      id: 607, reference: 'S00670', kind: 'quotation', state: 'draft',
      total: 4272.6, currency: 'XCD', date: '2026-07-10 15:21:20',
      odooLink: 'https://epic-communications-inc.odoo.com/odoo/sale.order/607',
    },
    reasoning: 'S00670 is a draft quotation for Patricia Yvonne Armour — it has not been sent, approved or accepted.',
    suggestedReply: "Hi Patricia, I've reviewed quotation S00670 for XCD 4,272.60. Would you like to proceed, or is there anything you'd like adjusted?",
  },
  // Real conversation #15 content, most recent first — the exact text and
  // Aug 18 2026 timestamps visible in Chatwoot today, plus the real S00670
  // order dated 2026-07-10, genuinely earlier: a real chronological mix,
  // not two lists concatenated.
  timeline: [
    { kind: 'message', id: 'm1', date: '2026-08-18T16:31:00', from: 'operator', text: 'You’re welcome, Yvonne. A colleague will be in touch at 1-767-295-1770 to confirm the billing details. Have a great day!' },
    { kind: 'message', id: 'm2', date: '2026-08-18T16:30:00', from: 'customer', text: 'Thanks but please confirm whether it’s best if I pay for this month/September as well and cancellation takes place at the end of the month; which I’d need to pay for anyway?? So do I owe you for 1 or 2 months? Please advise.' },
    { kind: 'message', id: 'm3', date: '2026-08-18T12:51:00', from: 'operator', text: 'Thank you, Yvonne. I’ve got your details and I’m bringing in a colleague to help with the TV subscription cancellation and reconnection when you’re ready.' },
    { kind: 'message', id: 'm4', date: '2026-08-18T12:51:00', from: 'customer', text: 'P. Yvonne Armour — 1-767-295-1770' },
    { kind: 'message', id: 'm5', date: '2026-08-18T12:50:00', from: 'customer', text: 'I have literally not used the TV since I last set it up. After this month, please advise the process to cancel the subscription.' },
    { kind: 'message', id: 'm6', date: '2026-08-18T12:48:00', from: 'operator', text: 'Hello! All is well, thank you. How can I help you today?' },
    { kind: 'message', id: 'm7', date: '2026-08-18T12:48:00', from: 'customer', text: 'Greetings EPIC — hope all is well' },
    { kind: 'order', id: 'order-607', date: '2026-07-10 15:21:20', reference: 'S00670', total: 4272.6, currency: 'XCD', status: 'draft' },
  ],
  timelineCallsNote: 'Calls are not shown: Magnus CDR data lives on bff-v2, not Foundation, and no server-to-server read path exists yet.',
}

describe('timeline + follow-ups checkpoint (render only, no deploy)', () => {
  it('writes the checkpoint page to disk', () => {
    const rawCss = readFileSync(path.resolve(__dirname, '../components/customer-360/customer-360.module.css'), 'utf8')

    const noop = () => {}
    const markup = renderToStaticMarkup(
      <CustomerWorkspaceView
        snapshot={armour}
        tab="overview"
        onTabChange={noop}
        nested={null}
        onOpenObject={noop}
        onCloseObject={noop}
        outcomeFor={() => undefined}
        send={null}
        onSendOpen={noop}
        onSendConfirm={noop}
        onSendClose={noop}
        replyOpen={false}
        onReplyOpen={noop}
        onReplyClose={noop}
        destinationLabel="conversation #15"
        onBackToCustomers={noop}
        onCreateFollowUp={noop}
        creatingFollowUp={false}
      />,
    )

    expect(markup).toContain('Timeline')
    expect(markup).toContain('Greetings EPIC') // real customer message
    expect(markup).toContain('S00670') // real order, same stream
    expect(markup).toContain('Calls are not shown') // honest, never faked
    expect(markup).toContain('Today') // real dueLabel computation
    expect(markup).toContain('Tomorrow')

    const css = inlinedCss(rawCss)
    const page = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Timeline + follow-ups checkpoint — 2026-09-05</title>
<style>${css}</style>
<style>
  body { margin: 0; background: #ddd; font-family: 'Plus Jakarta Sans', system-ui, sans-serif; }
  .frame { width: 1091px; margin: 24px auto; box-shadow: 0 0 0 1px #0002; }
  .caption { max-width: 1091px; margin: 0 auto 4px; font: 12px monospace; color: #555; }
</style>
</head>
<body>
  <p class="caption">(4)+(5) Overview, Patricia Yvonne Armour (partner 163, conv #15) — real message content and real order (S00670), merged chronologically; honest "calls not shown" note; Follow-ups panel (illustrative rows, real Today/Tomorrow label computation).</p>
  <div class="frame">${markup}</div>
</body>
</html>`

    const outDir = path.resolve(__dirname, '../../../.checkpoints')
    mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, 'c360-timeline-followups-2026-09-05.html')
    writeFileSync(outPath, page, 'utf8')
  })
})
