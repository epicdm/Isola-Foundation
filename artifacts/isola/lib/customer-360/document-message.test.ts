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

  it('greets by first name only, never the full Odoo partner string', () => {
    const out = composeDocumentMessage(quotation, 'Patricia Yvonne Armour')!
    expect(out.body).toContain('Hi Patricia,')
    expect(out.body).not.toContain('Yvonne Armour')
  })

  it('falls back to a neutral greeting rather than inventing a name', () => {
    const out = composeDocumentMessage(quotation, '   ')!
    expect(out.body.startsWith('Hello,')).toBe(true)
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
