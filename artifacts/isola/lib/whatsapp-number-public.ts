/**
 * Canonical public projection for `WhatsAppNumber` (CB-0).
 *
 * WHY THIS MODULE EXISTS
 *   `WhatsAppNumber` is a credential-bearing model: `access_token` holds a
 *   live Meta access token in plaintext, and `token_env` names the process
 *   environment variable that holds one. Returning a raw row across the API
 *   boundary therefore hands a Meta sending credential to the browser.
 *
 *   That is exactly what `app/api/onboard/whatsapp/route.ts` did before this
 *   module existed: POST returned the whole upserted row, and GET ran
 *   `findMany` with no projection, so every stored token for the tenant was
 *   serialised into the response on page load.
 *
 * THE RULE THIS MODULE ENFORCES
 *   No raw Prisma row for this model crosses the API boundary. Callers use
 *   `WHATSAPP_NUMBER_PUBLIC_SELECT` at the query, and `toPublicWhatsAppNumber`
 *   at the response. Both together, deliberately — the select keeps the secret
 *   out of process memory, and the serialiser keeps the contract correct even
 *   if a future edit drops the select.
 *
 * WHY THE SERIALISER IS WRITTEN FIELD-BY-FIELD
 *   It never spreads. A spread (`{ ...row }`) or a denylist (`delete
 *   row.access_token`) is only correct for the columns that exist today: the
 *   next credential column added to the schema would become public the moment
 *   it was merged, silently and with no failing test. Explicit construction
 *   inverts that default — a new column is private until someone deliberately
 *   adds it here, to the select, and to the field list, all three of which are
 *   cross-checked at compile time below and asserted in
 *   `whatsapp-number-public.test.ts`.
 *
 * WHAT IS DELIBERATELY NOT PUBLIC
 *   `access_token` — live Meta credential.
 *   `token_env`    — names the env var holding a live Meta credential, so it
 *                    discloses secret-store internals even though it is not
 *                    itself a secret.
 *   `tenant_id`    — not a secret, but nothing in the UI consumes it and the
 *                    caller's own tenant is already implied by the session.
 *                    Kept out to hold the allowlist to what is actually used.
 *
 *   `phone_number` IS public: it is the tenant's own business number, typed in
 *   by the tenant during onboarding and rendered back to them on the dashboard.
 *   Masking it would break the surface it exists to serve. It is not customer
 *   PII and not a credential.
 *
 * SCOPE
 *   This closes the response path only. Plaintext-at-rest remediation for
 *   `access_token` (envelope encryption via `lib/tenant-secrets.ts`, as already
 *   used by `OdooBinding.api_key_enc` and `FiservBinding.api_key_enc`) is a
 *   separate change under
 *   `defect-isola-meta-credentials-plaintext-channel-configs-and-onboarding-2026-08-05`
 *   and is NOT attempted here.
 */

import type { WhatsAppNumber } from '@prisma/client';

/**
 * The complete set of `WhatsAppNumber` columns approved for client visibility.
 * Adding a name here makes that column public. Nothing else does.
 */
export const WHATSAPP_NUMBER_PUBLIC_FIELDS = [
  'id',
  'phone_number_id',
  'waba_id',
  'phone_number',
  'display_name',
  'coex_mode',
  'created_at',
  'updated_at',
] as const;

export type WhatsAppNumberPublicField = (typeof WHATSAPP_NUMBER_PUBLIC_FIELDS)[number];

/** Prisma `select` clause. Keeps credential columns out of process memory. */
export const WHATSAPP_NUMBER_PUBLIC_SELECT = {
  id: true,
  phone_number_id: true,
  waba_id: true,
  phone_number: true,
  display_name: true,
  coex_mode: true,
  created_at: true,
  updated_at: true,
} as const;

/** The shape any client-visible WhatsApp number takes. */
export type WhatsAppNumberPublic = Pick<WhatsAppNumber, WhatsAppNumberPublicField>;

/* ------------------------------------------------------------------ *
 * Compile-time drift guards.
 *
 * These fail `tsc` — not a test — if the field list, the select clause and
 * the public type ever disagree. That is the point: the three must move
 * together or the build stops.
 * ------------------------------------------------------------------ */

type SelectKey = keyof typeof WHATSAPP_NUMBER_PUBLIC_SELECT;

// Every key in the select is an approved field name...
type _SelectKeysAreApprovedFields = SelectKey extends WhatsAppNumberPublicField ? true : never;
// ...and every approved field name appears in the select.
type _ApprovedFieldsAreSelected = WhatsAppNumberPublicField extends SelectKey ? true : never;
// ...and every approved field name is a real column on the model.
type _ApprovedFieldsExistOnModel = WhatsAppNumberPublicField extends keyof WhatsAppNumber ? true : never;

const _assertSelectKeysAreApprovedFields: _SelectKeysAreApprovedFields = true;
const _assertApprovedFieldsAreSelected: _ApprovedFieldsAreSelected = true;
const _assertApprovedFieldsExistOnModel: _ApprovedFieldsExistOnModel = true;
void _assertSelectKeysAreApprovedFields;
void _assertApprovedFieldsAreSelected;
void _assertApprovedFieldsExistOnModel;

/**
 * Build the client-visible shape.
 *
 * Accepts either a full row or an already-projected one, so a caller that
 * forgot the `select` still cannot leak — the output is constructed from named
 * fields only and never carries anything the input happened to include.
 */
export function toPublicWhatsAppNumber(
  row: WhatsAppNumber | WhatsAppNumberPublic,
): WhatsAppNumberPublic {
  return {
    id: row.id,
    phone_number_id: row.phone_number_id,
    waba_id: row.waba_id,
    phone_number: row.phone_number,
    display_name: row.display_name,
    coex_mode: row.coex_mode,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Convenience for list responses. */
export function toPublicWhatsAppNumbers(
  rows: ReadonlyArray<WhatsAppNumber | WhatsAppNumberPublic>,
): WhatsAppNumberPublic[] {
  return rows.map(toPublicWhatsAppNumber);
}
