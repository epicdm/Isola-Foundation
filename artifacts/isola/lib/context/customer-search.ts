/**
 * customer-search@1 — finding a customer, in the same bounded-reader shape as
 * every other Odoo read in this workspace.
 *
 * WHY THIS EXISTS
 * --------------
 * The Customer 360 workspace was built with exactly one door: a Recent Work
 * row's customer. Production then showed that every one of the 59 activity rows
 * carries `customerId: null`, because no source populates it. The door is real
 * and there is nothing standing in it, so the only way to reach a working
 * workspace was to type the URL. That is not an application.
 *
 * This module is the second door, and it is deliberately nothing more than a
 * door: it finds a customer and hands over the partner id. It renders no
 * context, holds no state and duplicates no section of Customer 360.
 *
 * THE DISCIPLINE, UNCHANGED
 * ------------------------
 * The caller supplies a search TERM and nothing else. This module decides what
 * kind of term it is from its shape, and each kind maps to exactly one domain
 * fixed in code. The model, the method, the searchable fields, the returned
 * fields, the ordering and the limit are all fixed here where they are
 * diffable. There is no path by which a caller chooses an operator, a field or
 * a model — which is the whole reason `json2Call` is not exposed to a route.
 */

import { LEAD_FIELDS } from '@/lib/customer-tools/lookup'

import {
  MAX_SECTION_ROWS,
  PARTNER_FIELDS,
  odooDeepLink,
  parseCustomerId,
  type CustomerRecord,
  type OdooCaller,
} from './customer-sources'

export const CUSTOMER_SEARCH_VERSION = 'customer-search@1' as const

/** Hard ceiling, independent of what the caller asks for. */
export const MAX_SEARCH_RESULTS = 25

/** Below this a name search matches most of the database. */
export const MIN_SEARCH_LENGTH = 2

/**
 * Enough digits to be a telephone number rather than a house number inside a
 * company name. Named because two separate branches below depend on the same
 * threshold, and they must not drift apart.
 */
export const MIN_PHONE_DIGITS = 6

/**
 * The fields a term can be matched against. Every one of them is a field the
 * partner reader already returns, so the search cannot find a customer on
 * evidence the result is not allowed to show.
 *
 * Deliberately NOT searchable: street, city, comment, or any free-text field.
 * A customer found by a fragment of an internal note is a customer whose
 * internal note has just been confirmed to exist.
 */
export const SEARCHABLE_FIELDS = ['id', 'name', 'email', 'phone'] as const
export type SearchableField = (typeof SEARCHABLE_FIELDS)[number]

export type SearchTermKind = 'partner_id' | 'email' | 'phone' | 'name' | 'partner_id_or_phone'

export interface SearchTerm {
  kind: SearchTermKind
  /** Normalised for the domain. Never the raw string when a shape was matched. */
  value: string
}

/** Digits only, so "+1 767-818-3742" and "17678183742" are the same search. */
function digits(raw: string): string {
  return raw.replace(/\D/g, '')
}

/**
 * What kind of thing did the reader type?
 *
 * Decided here, from shape alone. The caller never says — a caller that could
 * declare "this is an id" could ask for a domain the reader did not intend.
 */
export function parseSearchTerm(raw: unknown): SearchTerm | null {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s.length < MIN_SEARCH_LENGTH) return null

  if (s.includes('@') && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) {
    return { kind: 'email', value: s.toLowerCase() }
  }

  const d = digits(s)
  const looksNumeric = /^[\d\s+()\-.]+$/.test(s)
  const isBareInteger = parseCustomerId(s) !== null

  /*
    A BARE INTEGER IS AMBIGUOUS HERE, AND GUESSING COST US THE OWNER'S OWN
    CUSTOMERS.

    This used to classify every bare positive integer as a partner id, before
    the phone branch below could ever be reached. In Dominica that is not an
    edge case: every local number starts 767, so `7674490001` was looked up as
    Odoo partner id 7,674,490,001 — which does not exist — and the screen
    reported no match. Measured on production 2026-09-07: `767`, `7674490001`
    and `1767449` all came back `term=partner_id, count=0`, while
    `+17674490001` correctly came back `term=phone`. The defect was never
    about 767; ANY all-digit input was read as an account id, and 767 merely
    guarantees it hits every Dominican customer.

    The fix is not to reorder the guess — that would simply lose partner-id
    search for anything long. It is to STOP GUESSING when the input genuinely
    could be either, and ask both questions in one query. `partner_id_or_phone`
    ORs the two domains, so a reader who types digits gets an answer whichever
    kind of number it was.

    Short bare integers stay a plain partner id: below the phone threshold
    there is no phone reading to be had, so there is nothing to disambiguate.
  */
  if (isBareInteger && d.length >= MIN_PHONE_DIGITS) {
    return { kind: 'partner_id_or_phone', value: d }
  }
  if (isBareInteger) return { kind: 'partner_id', value: s }

  // Phone only when it is unambiguously one: mostly digits, enough of them to
  // be a number rather than a house number in a company name.
  if (d.length >= MIN_PHONE_DIGITS && looksNumeric) return { kind: 'phone', value: d }

  return { kind: 'name', value: s }
}

/**
 * One domain per kind, fixed. `ilike` is Odoo's case-insensitive contains and
 * is the only operator used; the term is a VALUE in the domain, never part of
 * its structure, so nothing a reader types can change the shape of the query.
 */
export function buildSearchDomain(term: SearchTerm): unknown[] {
  switch (term.kind) {
    case 'partner_id':
      return [['id', '=', Number(term.value)]]
    case 'partner_id_or_phone':
      // Odoo domains are prefix notation: '|' applies to the NEXT TWO leaves.
      // Asking both questions is the point -- see parseSearchTerm. The phone
      // leaf uses the same normalised digits as the 'phone' case below, so the
      // two paths cannot answer differently for the same number.
      return ['|', ['id', '=', Number(term.value)], ['phone', 'ilike', term.value]]
    case 'email':
      return [['email', '=ilike', term.value]]
    case 'phone':
      // Odoo stores phones formatted; matching on the digits the reader typed
      // is why the term is normalised rather than passed through.
      return [['phone', 'ilike', term.value]]
    case 'name':
      return [['name', 'ilike', term.value]]
  }
}

function clamp(limit: number): number {
  return Math.min(Math.max(1, Math.trunc(limit) || 1), Math.min(MAX_SEARCH_RESULTS, MAX_SECTION_ROWS))
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

function nameOf(value: unknown): string | null {
  if (Array.isArray(value) && value.length > 1) return typeof value[1] === 'string' ? value[1] : null
  return null
}

export interface CustomerSearchResult extends CustomerRecord {
  /** Present only when the instance URL is configured. Never constructed. */
  link: string | null
}

/**
 * The read. Same fixed field allowlist the customer section uses — a search
 * result must not be able to show a field the workspace itself would not.
 */
export async function searchCustomers(
  call: OdooCaller,
  term: SearchTerm,
  limit: number,
  odooBaseUrl: string | null,
): Promise<CustomerSearchResult[]> {
  const result = await call('res.partner', 'search_read', {
    domain: buildSearchDomain(term),
    fields: [...PARTNER_FIELDS],
    order: 'name asc',
    limit: clamp(limit),
  })

  const rows = Array.isArray(result) ? (result as Record<string, unknown>[]) : []
  return rows.map((r) => {
    const id = Number(r.id)
    return {
      id,
      name: str(r.name),
      email: str(r.email),
      phone: str(r.phone),
      city: str(r.city),
      street: str(r.street),
      // Missing defaults to TRUE, converged with lib/customer-360's projection
      // (dec 2026-08-29). The two surfaces read the same Odoo field and had
      // OPPOSITE defaults on an absent value. The cockpit picks a greeting from
      // this, and addressing a company as "Hi Marisol," is the worse of the two
      // errors — so an unknown is treated as a company on both sides now.
      isCompany: r.is_company !== false,
      companyName: nameOf(r.parent_id),
      active: r.active !== false,
      customerSince: str(r.create_date),
      link: odooDeepLink(odooBaseUrl, 'res.partner', Number.isInteger(id) ? id : null),
    }
  })
}

/** Re-exported so the route does not reach into two modules for one read. */
export { LEAD_FIELDS }
