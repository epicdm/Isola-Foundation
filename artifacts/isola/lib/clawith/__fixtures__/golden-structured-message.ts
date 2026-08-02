/**
 * Canonical golden fixture pair for the Foundation ↔ Clawith structured
 * bridge (`dec-clawith-structured-bridge-versioned-endpoint-2026-08-02`,
 * slice S1). This is the SAME semantic fixture mirrored in
 * `epicdm/isola-runtime` at `backend/isola_tests/fixtures/golden_structured_message.json`
 * — both repos assert against one canonical example so a Clawith-side
 * response that "looks right" is checked against the exact shape Foundation's
 * own parser requires, not against a re-derived approximation of it.
 *
 * `golden-structured-message.json` is the source of truth for field VALUES.
 * This module adds only type structure on top, so a change to either the
 * JSON or `ClawithRequest`/`ClawithResponse` surfaces as a type error here
 * rather than as a silent mismatch.
 */

import type { BuildClawithRequestInput } from '../request';
import type { ClawithRequest, ClawithResponse } from '../contract';

import golden from './golden-structured-message.json';

export const GOLDEN_REQUEST_INPUT = golden.request_input as unknown as BuildClawithRequestInput;
export const GOLDEN_REQUEST = golden.request as unknown as ClawithRequest;
export const GOLDEN_RESPONSE = golden.response as unknown as ClawithResponse;

/**
 * The response shape the deployed Clawith runtime returns TODAY from
 * `/api/isola/bridge/message` (proven live 2026-08-02, see
 * `defect-clawith-bridge-message-schema-mismatch-2026-08-02`): `reply` not
 * `customer_reply`, no `schema_version`, no `session_id`, no `confidence`.
 * `parseClawithResponse` must reject this shape — that is the whole reason
 * the structured endpoint has to be additive rather than an in-place upgrade
 * of the legacy route.
 */
export const LEGACY_LIVE_RESPONSE = golden.legacy_live_response as Record<string, unknown>;
