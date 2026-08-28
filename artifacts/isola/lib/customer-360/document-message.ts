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

function firstName(full: string): string {
  const trimmed = full.trim()
  if (!trimmed) return ''
  return trimmed.split(/\s+/)[0]
}

/** ISO or Odoo date → a plain human date. Unparseable input renders nothing. */
function humanDate(raw: string | null): string {
  if (!raw) return ''
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
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
): ComposedDocumentMessage | null {
  if (!isSendableKind(doc.kind)) return null
  if (!Number.isInteger(doc.id) || doc.id <= 0) return null

  const reference = (doc.reference ?? '').trim()
  if (!reference) return null

  // A price we cannot verify is a price we do not state.
  if (typeof doc.total !== 'number' || !Number.isFinite(doc.total)) return null
  const currency = (doc.currency ?? '').trim()
  if (!currency) return null

  const label = KIND_LABEL[doc.kind]
  const name = firstName(customerName)
  const greeting = name ? `Hi ${name},` : 'Hello,'
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
