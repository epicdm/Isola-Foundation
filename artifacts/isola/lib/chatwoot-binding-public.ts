/**
 * Canonical public projection for `ChatwootBinding` (CB-0, sibling route).
 *
 * `ChatwootBinding.token` is a Chatwoot Application API agent token — a live
 * credential that can read and write that account's conversations. Like
 * `WhatsAppNumber.access_token` it must never cross the API boundary, and for
 * the same reason: the model is credential-bearing, so returning a raw row
 * returns a credential.
 *
 * Same construction as `lib/whatsapp-number-public.ts`, deliberately — one
 * pattern for this problem, not two. See that module's header for why the
 * serialiser is written field-by-field instead of spreading or deleting.
 */

import type { ChatwootBinding } from '@prisma/client';

/** Columns approved for client visibility. `token` is deliberately absent. */
export const CHATWOOT_BINDING_PUBLIC_FIELDS = [
  'id',
  'tenant_id',
  'agent_id',
  'base_url',
  'account_id',
  'inbox_id',
  'mode',
  'created_at',
  'updated_at',
] as const;

export type ChatwootBindingPublicField = (typeof CHATWOOT_BINDING_PUBLIC_FIELDS)[number];

export const CHATWOOT_BINDING_PUBLIC_SELECT = {
  id: true,
  tenant_id: true,
  agent_id: true,
  base_url: true,
  account_id: true,
  inbox_id: true,
  mode: true,
  created_at: true,
  updated_at: true,
} as const;

export type ChatwootBindingPublic = Pick<ChatwootBinding, ChatwootBindingPublicField>;

/* --------------------------------------------- compile-time drift guards */

type SelectKey = keyof typeof CHATWOOT_BINDING_PUBLIC_SELECT;

type _SelectKeysAreApprovedFields = SelectKey extends ChatwootBindingPublicField ? true : never;
type _ApprovedFieldsAreSelected = ChatwootBindingPublicField extends SelectKey ? true : never;
type _ApprovedFieldsExistOnModel = ChatwootBindingPublicField extends keyof ChatwootBinding
  ? true
  : never;

const _assertSelectKeysAreApprovedFields: _SelectKeysAreApprovedFields = true;
const _assertApprovedFieldsAreSelected: _ApprovedFieldsAreSelected = true;
const _assertApprovedFieldsExistOnModel: _ApprovedFieldsExistOnModel = true;
void _assertSelectKeysAreApprovedFields;
void _assertApprovedFieldsAreSelected;
void _assertApprovedFieldsExistOnModel;

export function toPublicChatwootBinding(
  row: ChatwootBinding | ChatwootBindingPublic,
): ChatwootBindingPublic {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    agent_id: row.agent_id,
    base_url: row.base_url,
    account_id: row.account_id,
    inbox_id: row.inbox_id,
    mode: row.mode,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function toPublicChatwootBindings(
  rows: ReadonlyArray<ChatwootBinding | ChatwootBindingPublic>,
): ChatwootBindingPublic[] {
  return rows.map(toPublicChatwootBinding);
}
