import { describe, expect, it } from 'vitest'

import {
  composeDocumentMessage,
  documentMessageFingerprint,
  isSendableKind,
} from './document-message'
import type { Customer360Document } from './contracts'

const quotation: Customer360Document = {
  id: 1,
  reference: 'S00001',
  kind: 'quotation',
  state: 'draft',
  total: 273.7,
  currency: 'USD',
  date: '2026-08-27',
  odooLink: 'https://erp.example.com/odoo/sale.order/1',
}

const invoice: Customer360Document = {
  id: 2,
  reference: 'INV/2026/00001',
  kind: 'invoice',
  state: 'posted',
  paymentState: 'not_paid',
  total: 217.35,
  residual: 217.35,
  currency: 'USD',
  date: '2026-08-27',
  odooLink: 'https://erp.example.com/odoo/account.move/2',
}

describe('composeDocumentMessage — what a customer is told', () => {
  it('composes a quotation with its reference, exact total and ISO currency code', () => {
    const out = composeDocumentMessage(quotation, 'Patricia Yvonne Armour')!
    expect(out).not.toBeNull()
    expect(out.body).toContain('S00001')
    expect(out.body).toContain('USD 273.70')
    expect(out.documentKind).toBe('quotation')
    expect(out.documentReference).toBe('S00001')
    expect(out.documentId).toBe(1)
  })

  it('greets an INDIVIDUAL by first name only, never the full Odoo partner string', () => {
    // The third argument is Odoo's own `is_company`. It is required to get a
    // personal greeting at all — see the company cases below.
    const out = composeDocumentMessage(quotation, 'Patricia Yvonne Armour', false)!
    expect(out.body).toContain('Hi Patricia,')
    expect(out.body).not.toContain('Yvonne Armour')
  })

  it('falls back to a neutral greeting rather than inventing a name', () => {
    const out = composeDocumentMessage(quotation, '   ')!
    expect(out.body.startsWith('Hello,')).toBe(true)
  })

  /* ── greeting a COMPANY, which is not a person ───────────────────────────*/

  it('never greets an organisation by its first word', () => {
    // "Hi EPIC," for EPIC Communications Inc reads as unmistakably
    // machine-generated, in a message whose whole point is to look like
    // something EPIC would have written.
    const out = composeDocumentMessage(quotation, 'EPIC Communications Inc', true)!
    expect(out.body.startsWith('Hello,')).toBe(true)
    expect(out.body).not.toContain('Hi EPIC')
  })

  it('POSITIVE CONTROL: an individual IS still greeted by first name', () => {
    // Without this, the rule above would pass just as well against a composer
    // broken to greet nobody personally, ever.
    const out = composeDocumentMessage(quotation, 'Patricia Yvonne Armour', false)!
    expect(out.body.startsWith('Hi Patricia,')).toBe(true)
  })

  it('refuses a first token that is plainly not a name, even for an individual', () => {
    // Measured live: the account "S8-W1 Verification Account" produced
    // "Hi S8-W1,". A token with digits or punctuation is not a salutation.
    expect(
      composeDocumentMessage(quotation, 'S8-W1 Verification Account', false)!.body.startsWith('Hello,'),
    ).toBe(true)
    expect(composeDocumentMessage(quotation, '3M Dominica', false)!.body.startsWith('Hello,')).toBe(true)
    // A single letter is an initial, not a name.
    expect(composeDocumentMessage(quotation, 'J Smith', false)!.body.startsWith('Hello,')).toBe(true)
  })

  it('accepts names with accents, apostrophes and hyphens — the rule is not ASCII-only', () => {
    expect(composeDocumentMessage(quotation, 'Zoë Baptiste', false)!.body).toContain('Hi Zoë,')
    expect(composeDocumentMessage(quotation, "O’Brien Family", false)!.body).toContain('Hi O’Brien,')
    expect(composeDocumentMessage(quotation, 'Jean-Luc Charles', false)!.body).toContain('Hi Jean-Luc,')
  })

  it('defaults to the FORMAL greeting when the flag is not supplied', () => {
    // The cost of over-formality to a person is trivial; the cost of "Hi EPIC,"
    // to a company is a message that reads as broken. Default to the safe side.
    expect(composeDocumentMessage(quotation, 'Patricia Armour')!.body.startsWith('Hello,')).toBe(true)
  })

  /* ── the refusals. Each one has the positive control above it. ───────────*/

  it('REFUSES when the currency is unknown, rather than assuming one', () => {
    expect(composeDocumentMessage({ ...quotation, currency: null }, 'Patricia')).toBeNull()
    // Positive control: identical document WITH a currency composes.
    expect(composeDocumentMessage(quotation, 'Patricia')).not.toBeNull()
  })

  it('REFUSES when the total is missing or not finite', () => {
    expect(composeDocumentMessage({ ...quotation, total: null }, 'Patricia')).toBeNull()
    expect(composeDocumentMessage({ ...quotation, total: Number.NaN }, 'Patricia')).toBeNull()
    expect(composeDocumentMessage(quotation, 'Patricia')).not.toBeNull()
  })

  it('REFUSES a kind that is not sendable', () => {
    expect(composeDocumentMessage({ ...quotation, kind: 'order' }, 'Patricia')).toBeNull()
    expect(isSendableKind('order')).toBe(false)
    expect(isSendableKind('quotation')).toBe(true)
    expect(isSendableKind('invoice')).toBe(true)
  })

  it('REFUSES a document with no reference', () => {
    expect(composeDocumentMessage({ ...quotation, reference: '  ' }, 'Patricia')).toBeNull()
  })

  /* ── what must never appear in a customer-visible message ────────────────*/

  it('never leaks the internal Odoo link', () => {
    const out = composeDocumentMessage(quotation, 'Patricia')!
    expect(out.body).not.toContain('odoo')
    expect(out.body).not.toContain('http')
  })

  it('never claims anything is attached — S8-W1 sends text only', () => {
    const out = composeDocumentMessage(quotation, 'Patricia')!
    expect(out.body.toLowerCase()).not.toContain('attach')
    expect(out.body.toLowerCase()).not.toContain('pdf')
    expect(out.body.toLowerCase()).not.toContain('download')
  })

  it('never states that the customer has accepted or agreed to anything', () => {
    const out = composeDocumentMessage(quotation, 'Patricia')!
    const lowered = out.body.toLowerCase()
    expect(lowered).not.toContain('accepted')
    expect(lowered).not.toContain('confirmed your')
    expect(lowered).not.toContain('as agreed')
  })

  /* ── invoice payment state ───────────────────────────────────────────────*/

  it('states a RECOGNISED payment state in our own words', () => {
    const out = composeDocumentMessage(invoice, 'Patricia')!
    expect(out.body).toContain('currently unpaid')
    // The raw Odoo token is never passed through to a customer.
    expect(out.body).not.toContain('not_paid')
  })

  it('says nothing at all about an unrecognised payment state', () => {
    const out = composeDocumentMessage(
      { ...invoice, paymentState: 'reversed_partial_weirdness' },
      'Patricia',
    )!
    expect(out.body).not.toContain('reversed_partial_weirdness')
    expect(out.body).not.toContain('unpaid')
    // Positive control: the recognised state DOES render, so this is not vacuous.
    expect(composeDocumentMessage(invoice, 'Patricia')!.body).toContain('unpaid')
  })

  it('never puts a payment state on a quotation', () => {
    const out = composeDocumentMessage(
      { ...quotation, paymentState: 'not_paid' } as Customer360Document,
      'Patricia',
    )!
    expect(out.body).not.toContain('unpaid')
  })

  /* ── an UNPOSTED invoice is not a debt (F20) ─────────────────────────────*/

  it('REFUSES a draft invoice — a customer is never sent a demand for an unposted move', () => {
    // Exactly the shape Odoo produces for a draft: name is the placeholder '/',
    // payment_state is already 'not_paid', and the total is real. Without the
    // state guard every one of those fields passes and the customer receives
    // "your invoice /, ... Total: USD 217.35. This invoice is currently unpaid."
    const draft: Customer360Document = {
      ...invoice,
      state: 'draft',
      reference: '/',
      paymentState: 'not_paid',
    }
    expect(composeDocumentMessage(draft, 'Patricia')).toBeNull()
  })

  it('REFUSES a draft invoice even when it carries a real reference', () => {
    // The reference is not the guard — the state is. A draft that has been given
    // a name must still not be sent.
    expect(
      composeDocumentMessage({ ...invoice, state: 'draft' }, 'Patricia'),
    ).toBeNull()
  })

  it('REFUSES a cancelled invoice, and anything whose state is unknown', () => {
    expect(composeDocumentMessage({ ...invoice, state: 'cancel' }, 'Patricia')).toBeNull()
    expect(composeDocumentMessage({ ...invoice, state: null }, 'Patricia')).toBeNull()
  })

  it('POSITIVE CONTROL: the same invoice, POSTED, still composes and still sends', () => {
    // Without this the three refusals above would pass just as well against a
    // composer that had been broken to refuse every invoice.
    const out = composeDocumentMessage(invoice, 'Patricia')
    expect(out).not.toBeNull()
    expect(out!.body).toContain('INV/2026/00001')
    expect(out!.body).toContain('USD 217.35')
  })

  it('POSITIVE CONTROL: a DRAFT QUOTATION is still sendable — the rule is invoice-only', () => {
    // The S3 recommendation exists to send draft quotations. If the state guard
    // had been written against `doc.state` without checking the kind, this
    // fixture — state 'draft' — would have stopped composing.
    expect(quotation.state).toBe('draft')
    expect(composeDocumentMessage(quotation, 'Patricia')).not.toBeNull()
  })

  /* ── the date a customer reads is the date Odoo holds ────────────────────*/

  it('renders a bare invoice DATE as the calendar day Odoo holds, never shifted', () => {
    // `invoice_date` is a Date, not an instant. Rendering UTC midnight in UTC-4
    // would yield "26 August" and tell the customer their invoice is dated the
    // day before the one in Odoo.
    const out = composeDocumentMessage({ ...invoice, date: '2026-08-27' }, 'Patricia')!
    expect(out.body).toContain('27 August 2026')
    expect(out.body).not.toContain('26 August 2026')
  })

  it('renders a quotation TIMESTAMP in the business day, not the UTC day', () => {
    // `date_order` IS an instant, in UTC. 01:30 UTC on the 28th was 21:30 on the
    // 27th in Dominica — the day the customer and the owner both experienced.
    // Rendering this one in UTC would name the wrong day just as surely as
    // shifting the bare date above.
    const out = composeDocumentMessage(
      { ...quotation, date: '2026-08-28 01:30:00' },
      'Patricia',
    )!
    expect(out.body).toContain('27 August 2026')
    expect(out.body).not.toContain('28 August 2026')
  })

  it('CONTROL: the two date kinds are treated DIFFERENTLY, not both one way', () => {
    // Without this, both assertions above would pass against a formatter pinned
    // to whichever single zone happened to suit the two fixtures.
    const bare = composeDocumentMessage({ ...invoice, date: '2026-08-28' }, 'P')!
    const instant = composeDocumentMessage({ ...quotation, date: '2026-08-28 01:30:00' }, 'P')!
    expect(bare.body).toContain('28 August 2026')
    expect(instant.body).toContain('27 August 2026')
  })

  /* ── the fingerprint binds a confirmation to exact bytes ─────────────────*/

  it('fingerprints the exact body, and a changed amount changes it', () => {
    const a = composeDocumentMessage(quotation, 'Patricia')!
    const b = composeDocumentMessage({ ...quotation, total: 999.99 }, 'Patricia')!
    expect(a.fingerprint).toBe(documentMessageFingerprint(a.body))
    expect(a.fingerprint).not.toBe(b.fingerprint)
  })

  it('is deterministic — the same document composes the same bytes twice', () => {
    const a = composeDocumentMessage(quotation, 'Patricia')!
    const b = composeDocumentMessage(quotation, 'Patricia')!
    expect(a.body).toBe(b.body)
    expect(a.fingerprint).toBe(b.fingerprint)
  })
})
