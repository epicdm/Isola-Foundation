/**
 * document-message@1 — the ONLY place a customer-visible document message is
 * composed, and it is server-side on purpose.
 *
 * The panel never writes a word the customer reads. It proposes "send this
 * document to this conversation"; this module turns a VERIFIED Odoo document
 * into the exact sentence that will be delivered. That is the S8 rule "no
 * business logic in the panel" applied to the one place it matters most —
 * the text a customer could hold EPIC to.
 *
 * WHY THIS REFUSES RATHER THAN IMPROVISES
 * ---------------------------------------
 * A document with no verified amount, or no verified currency, composes to
 * NOTHING. It does not compose to a message that quietly omits the price, and
 * it certainly does not compose to a number under an assumed currency. EPIC's
 * ledger genuinely holds more than one currency, and a confident wrong price is
 * more dangerous than an error message because nothing about it looks broken.
 *
 * WHAT IS DELIBERATELY NOT IN THE MESSAGE
 * ---------------------------------------
 *   - `odooLink`. It is an internal Odoo URL behind a staff login. Sending it to
 *     a customer would be leaking an internal surface and would read to them as
 *     a broken link.
 *   - Any claim that a document is attached. S8-W1 sends TEXT. There is no PDF
 *     in this slice, so no sentence may imply one.
 *   - Any promise about what happens next that EPIC has not committed to.
 */

import { createHash } from 'node:crypto'

import type { Customer360Document } from './contracts'

export const DOCUMENT_MESSAGE_VERSION = 'document-message@1' as const

/** The kinds a customer may be sent. `order` is deliberately not one of them. */
export const SENDABLE_KINDS = ['quotation', 'invoice'] as const
export type SendableKind = (typeof SENDABLE_KINDS)[number]

export interface ComposedDocumentMessage {
  body: string
  documentId: number
  documentReference: string
  documentKind: SendableKind
  /** sha256 of `body`. What the operator reviewed, proven at send time. */
  fingerprint: string
}

const KIND_LABEL: Record<SendableKind, string> = {
  quotation: 'quotation',
  invoice: 'invoice',
}

/**
 * Payment states we are willing to state to a customer in our own words. An
 * unrecognised state renders NOTHING rather than being passed through raw —
 * `not_paid` is an Odoo token, not a sentence, and a customer once received a
 * raw `HTTP 402 Insufficient Balance` on this estate.
 */
const PAYMENT_SENTENCE: Record<string, string> = {
  not_paid: 'This invoice is currently unpaid.',
  paid: 'This invoice is paid in full — thank you.',
  partial: 'This invoice is partially paid.',
}

export function isSendableKind(kind: unknown): kind is SendableKind {
  return typeof kind === 'string' && (SENDABLE_KINDS as readonly string[]).includes(kind)
}

/** sha256 of the exact body. The operator's confirmation is bound to this. */
export function documentMessageFingerprint(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

/**
 * The greeting, and the rule is deliberately conservative: personalise ONLY
 * when we can justify it, otherwise be polite and generic.
 *
 * "Hi EPIC," for EPIC Communications Inc, or "Hi S8-W1," for an account named
 * "S8-W1 Verification Account", is the failure this exists to prevent. It is a
 * small thing that reads as unmistakably machine-generated, in a message whose
 * whole purpose is to be something EPIC would have written.
 *
 * The authority is Odoo's `res.partner.is_company`, not the shape of the
 * string. A name-shape heuristic is wrong in both directions — it mangles
 * short surnames and personalises "Atlas Trading" — so the flag decides, and
 * the string is only checked for the narrow case of a token that plainly is
 * not a name (digits, punctuation, a single letter).
 */
function greetingFor(full: string, isCompany: boolean): string {
  if (isCompany) return 'Hello,'
  const first = full.trim().split(/\s+/)[0] ?? ''
  // A personal first name is alphabetic and more than one character. Anything
  // else — "S8-W1", "3M", "J" — gets the neutral greeting rather than a
  // salutation that would read as broken.
  if (!/^\p{L}[\p{L}'’-]+$/u.test(first)) return 'Hello,'
  return `Hi ${first},`
}

/**
 * Where EPIC does business. Customer- and owner-facing text renders here; ledger
 * and audit records stay UTC. Dominica does not observe DST, so this is a fixed
 * UTC-4 and no seasonal shift can move a rendered date across midnight.
 */
export const BUSINESS_TIMEZONE = 'America/Dominica'

/**
 * Odoo date or datetime → a plain human date. Unparseable input renders nothing.
 *
 * TWO KINDS OF INPUT, AND THEY MUST NOT BE TREATED ALIKE.
 *
 * `account.move.invoice_date` is a DATE: "2026-08-27". It names a calendar day
 * and carries no instant, so it is rendered verbatim. Converting it to a zone is
 * not a correction, it is a corruption — `new Date('2026-08-27')` is UTC
 * midnight, and rendering THAT in UTC-4 yields "26 August", so the customer is
 * told an invoice is dated the day before the one Odoo holds.
 *
 * `sale.order.date_order` is a DATETIME in UTC: "2026-08-27 14:05:00". That IS
 * an instant, and the day a customer should read is the day it was in Dominica,
 * not in UTC — an order placed 21:30 local on the 27th is 01:30 UTC on the 28th,
 * and UTC would name the wrong day just as surely.
 *
 * So: a bare date is a calendar day and is never shifted; a timestamp is an
 * instant and renders in the business timezone. Getting this backwards moves a
 * customer-facing date by one day, in one direction or the other.
 */
function humanDate(raw: string | null): string {
  if (!raw) return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''

  const isCalendarDay = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)

  // Odoo datetimes are UTC but arrive with no zone marker, and `new Date` reads a
  // bare "YYYY-MM-DD HH:MM:SS" as LOCAL time. Say UTC explicitly.
  const normalised = isCalendarDay
    ? `${trimmed}T00:00:00Z`
    : /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(trimmed)
      ? `${trimmed.replace(' ', 'T')}Z`
      : trimmed

  const d = new Date(normalised)
  if (Number.isNaN(d.getTime())) return ''

  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: isCalendarDay ? 'UTC' : BUSINESS_TIMEZONE,
  })
}

/**
 * Amount rendered as `CODE 1,234.56` — the ISO code, never a symbol.
 *
 * A symbol would have to be guessed from the code, and `$` in front of an XCD
 * amount is exactly the confident-wrong-number failure this file exists to
 * prevent. The code is unambiguous and costs one word.
 */
function money(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/**
 * Compose the customer-visible message for one verified document.
 *
 * Returns null when the document cannot be described truthfully — a missing
 * reference, a non-finite total, an absent currency, or a kind we do not send.
 * Null means "refuse", never "send something vaguer".
 */
export function composeDocumentMessage(
  doc: Customer360Document,
  customerName: string,
  isCompany = true,
): ComposedDocumentMessage | null {
  if (!isSendableKind(doc.kind)) return null
  if (!Number.isInteger(doc.id) || doc.id <= 0) return null

  const reference = (doc.reference ?? '').trim()
  if (!reference) return null

  // A price we cannot verify is a price we do not state.
  if (typeof doc.total !== 'number' || !Number.isFinite(doc.total)) return null
  const currency = (doc.currency ?? '').trim()
  if (!currency) return null

  // AN UNPOSTED INVOICE IS NOT A DEBT, AND MUST NEVER BE SENT AS ONE.
  //
  // Odoo gives a draft `account.move` payment_state 'not_paid' and the
  // placeholder name '/'. Composed without this guard, a draft produces
  // "Here are the details of your invoice /, dated ... Total: XCD 1,234.00.
  // This invoice is currently unpaid." — a payment demand, under EPIC's name,
  // for a document that does not legally exist yet.
  //
  // This is not an edge case here: def-receivables-headline-figure-is-mostly-
  // draft-invoices-2026-08-13 established that EPIC's ledger carries a large
  // draft population, so it is the COMMON case.
  //
  // The projection already applies posted-only to the money it REPORTS
  // (odoo-projection.ts skips state !== 'posted' when summing balances). This
  // applies the same rule to the money we ASSERT to a customer.
  //
  // Quotations are deliberately unaffected: a draft quotation is a real,
  // sendable thing — it is the entire subject of the S3 recommendation.
  if (doc.kind === 'invoice' && (doc.state ?? '').trim() !== 'posted') return null

  const label = KIND_LABEL[doc.kind]
  const greeting = greetingFor(customerName, isCompany)
  const dated = humanDate(doc.date)

  const lines: string[] = [
    greeting,
    '',
    dated
      ? `Here are the details of your ${label} ${reference}, dated ${dated}:`
      : `Here are the details of your ${label} ${reference}:`,
    '',
    `Total: ${money(doc.total, currency)}`,
  ]

  // Only an invoice carries a payment state, and only a recognised one is said.
  if (doc.kind === 'invoice') {
    const sentence = PAYMENT_SENTENCE[(doc.paymentState ?? '').trim()]
    if (sentence) lines.push(sentence)
  }

  lines.push(
    '',
    'If you have any questions, just reply to this message and a member of our team will help.',
  )

  const body = lines.join('\n')

  return {
    body,
    documentId: doc.id,
    documentReference: reference,
    documentKind: doc.kind,
    fingerprint: documentMessageFingerprint(body),
  }
}
