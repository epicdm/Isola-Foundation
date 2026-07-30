/**
 * operation.ts - the exactly-once claim substrate every governed customer tool
 * that WRITES must go through (Tools 2, 3, 4 and 5).
 *
 * THE RULE
 *   Claim before the write. Record the verified readback after. On a repeat,
 *   return what was recorded - never re-execute, and never invent a fresh
 *   answer that merely looks like the old one.
 *
 * WHY NOT "SEARCH ODOO FIRST"
 *   The cheaper design is to look for an existing record that resembles what
 *   we are about to create. That is a heuristic and it fails in the exact case
 *   that matters: two retries of the same turn race, both search, both find
 *   nothing, both create. It also cannot survive the record being completed,
 *   archived or unlinked - a done mail.activity is gone from the searchable
 *   set, so a retry would cheerfully create a second one. The ledger is
 *   durable and independent of the Odoo records later lifecycle.
 *
 * WHY THE HINT IS NOT THE IDENTITY
 *   Clawith supplies `operation_id_hint`. It is a hint. Foundation derives the
 *   real operation id from the tenant, the tool, the conversation, the hint AND
 *   a hash of the AUTHORISED arguments. A model that reuses one hint for two
 *   genuinely different requests must be REFUSED, not quietly served the
 *   earlier result - which is what a hint-as-identity design would do, and it
 *   would do it silently, which is the worst version.
 *
 * CONCURRENCY
 *   The unique index on (tenant_id, operation_id) is the enforcement, not the
 *   read-then-write check below it. Two concurrent claims both attempt the
 *   insert; the database picks one winner and the loser re-reads and reports
 *   in_flight. There is no window in which both proceed.
 */
import { createHash } from "node:crypto"
import { prisma } from "@/lib/prisma"

export const OPERATION_STATES = ["claimed", "succeeded", "failed"] as const
export type OperationState = (typeof OPERATION_STATES)[number]

/**
 * Canonical JSON: object keys sorted at every depth, so two arguments objects
 * that differ only in key order hash the same. Without this, a retry whose
 * serialiser happened to emit keys in another order would look like a
 * conflicting request and be refused.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`
}

/** SHA-256 of the canonical form of the AUTHORISED arguments. */
export function hashArguments(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args)).digest("hex")
}

export interface DeriveOperationIdInput {
  tenantId: string
  toolName: string
  conversationId: string
  /** Clawith idempotency hint. An input to the identity, never the identity. */
  hint: string
  requestHash: string
}

/**
 * Derive the operation id Foundation will actually key on.
 *
 * Deterministic: the same authorised turn derives the same id on every retry,
 * with no state carried between attempts. Tenant-prefixed so an id can never
 * be mistaken for another tenant operation even if the remainder collides.
 */
export function deriveOperationId(input: DeriveOperationIdInput): string {
  const material = canonicalJson([
    input.tenantId,
    input.toolName,
    input.conversationId,
    input.hint,
    input.requestHash,
  ])
  return `op-${createHash("sha256").update(material).digest("hex").slice(0, 32)}`
}

export interface OperationRecord {
  id: string
  tenant_id: string
  operation_id: string
  tool_name: string
  request_hash: string
  state: string
  result_model: string | null
  result_id: number | null
  result: unknown
  failure_code: string | null
  claimed_at: Date
}

export interface ClaimOperationInput {
  tenantId: string
  toolName: string
  conversationId: string
  correlationId: string
  agentSessionId?: string | null
  hint: string
  /** The arguments Foundation has ALREADY authorised. Not the raw proposal. */
  authorisedArguments: unknown
}

export type ClaimOutcome =
  /** The caller owns this operation and must now execute it. */
  | { status: "claimed"; operationId: string; recordId: string }
  /** Completed earlier. Return `result` verbatim; do not execute. */
  | { status: "already_succeeded"; operationId: string; resultModel: string | null; resultId: number | null; result: unknown }
  /** Another attempt holds the claim right now. Do not execute. */
  | { status: "in_flight"; operationId: string; claimedAt: Date }
  /** Same id, different arguments. Refuse - this is not a retry. */
  | { status: "conflict"; operationId: string; detail: string }
  /** A previous attempt failed. The claim is re-taken; execute again. */
  | { status: "retry_after_failure"; operationId: string; recordId: string; previousFailureCode: string | null }

/** Storage seam so the claim logic is testable without a database. */
export interface OperationStore {
  findByOperationId(tenantId: string, operationId: string): Promise<OperationRecord | null>
  insert(row: {
    tenant_id: string
    operation_id: string
    tool_name: string
    request_hash: string
    conversation_id: string
    correlation_id: string
    agent_session_id: string | null
  }): Promise<OperationRecord>
  reclaim(id: string): Promise<OperationRecord>
  markSucceeded(id: string, data: { result_model: string | null; result_id: number | null; result: unknown }): Promise<OperationRecord>
  markFailed(id: string, data: { failure_code: string; failure_detail: string | null }): Promise<OperationRecord>
}

/** Postgres unique-violation, as surfaced by Prisma. */
function isUniqueViolation(err: unknown): boolean {
  return typeof (err as { code?: unknown })?.code === "string" && (err as { code: string }).code === "P2002"
}

export const prismaOperationStore: OperationStore = {
  findByOperationId: (tenantId, operationId) =>
    prisma.customerToolOperation.findUnique({
      where: { tenant_id_operation_id: { tenant_id: tenantId, operation_id: operationId } },
    }) as unknown as Promise<OperationRecord | null>,
  insert: (row) => prisma.customerToolOperation.create({ data: row }) as unknown as Promise<OperationRecord>,
  reclaim: (id) =>
    prisma.customerToolOperation.update({
      where: { id },
      data: { state: "claimed", failure_code: null, failure_detail: null, claimed_at: new Date(), completed_at: null },
    }) as unknown as Promise<OperationRecord>,
  markSucceeded: (id, data) =>
    prisma.customerToolOperation.update({
      where: { id },
      data: {
        state: "succeeded",
        result_model: data.result_model,
        result_id: data.result_id,
        result: (data.result ?? null) as never,
        completed_at: new Date(),
        failure_code: null,
        failure_detail: null,
      },
    }) as unknown as Promise<OperationRecord>,
  markFailed: (id, data) =>
    prisma.customerToolOperation.update({
      where: { id },
      data: {
        state: "failed",
        failure_code: data.failure_code,
        failure_detail: data.failure_detail,
        completed_at: new Date(),
      },
    }) as unknown as Promise<OperationRecord>,
}

/**
 * Take the exactly-once claim for one authorised tool execution.
 *
 * Never throws for an expected outcome. Every branch a caller must handle is a
 * status, because an exception two frames up is not handling.
 */
export async function claimOperation(
  input: ClaimOperationInput,
  store: OperationStore = prismaOperationStore,
): Promise<ClaimOutcome> {
  const requestHash = hashArguments(input.authorisedArguments)
  const operationId = deriveOperationId({
    tenantId: input.tenantId,
    toolName: input.toolName,
    conversationId: input.conversationId,
    hint: input.hint,
    requestHash,
  })

  /** A failed row needs a write before it becomes an outcome, so `decide`
   *  reports the intent and the caller performs the reclaim. */
  type Decision = ClaimOutcome | {
    status: "pending_reclaim"
    operationId: string
    recordId: string
    previousFailureCode: string | null
  }

  const decide = (existing: OperationRecord): Decision => {
    // A hash mismatch on the same id cannot be a retry. Refuse rather than
    // serve the earlier result for a request that is not the earlier request.
    if (existing.request_hash !== requestHash) {
      return {
        status: "conflict",
        operationId,
        detail: "operation id reused with different authorised arguments",
      }
    }
    if (existing.tool_name !== input.toolName) {
      return { status: "conflict", operationId, detail: "operation id reused for a different tool" }
    }
    if (existing.state === "succeeded") {
      return {
        status: "already_succeeded",
        operationId,
        resultModel: existing.result_model,
        resultId: existing.result_id,
        result: existing.result,
      }
    }
    if (existing.state === "failed") {
      return { status: "pending_reclaim", operationId, recordId: existing.id, previousFailureCode: existing.failure_code }
    }
    return { status: "in_flight", operationId, claimedAt: existing.claimed_at }
  }

  let existing = await store.findByOperationId(input.tenantId, operationId)
  if (!existing) {
    try {
      const created = await store.insert({
        tenant_id: input.tenantId,
        operation_id: operationId,
        tool_name: input.toolName,
        request_hash: requestHash,
        conversation_id: input.conversationId,
        correlation_id: input.correlationId,
        agent_session_id: input.agentSessionId ?? null,
      })
      return { status: "claimed", operationId, recordId: created.id }
    } catch (err) {
      // Lost the insert race. The unique index did its job; re-read and report
      // what the winner is doing rather than proceeding alongside it.
      if (!isUniqueViolation(err)) throw err
      existing = await store.findByOperationId(input.tenantId, operationId)
      if (!existing) throw err
    }
  }

  const outcome = decide(existing)
  if (outcome.status === "pending_reclaim") {
    const reclaimed = await store.reclaim(outcome.recordId)
    return {
      status: "retry_after_failure",
      operationId,
      recordId: reclaimed.id,
      previousFailureCode: outcome.previousFailureCode,
    }
  }
  return outcome
}

/**
 * Record a VERIFIED readback against the claim.
 *
 * `resultModel`/`resultId` are the authoritative Odoo record, and the caller
 * must have read them BACK from Odoo. An id echoed by a create response is not
 * proof of what was stored, and this ledger is not the place to start
 * pretending otherwise.
 */
export async function completeOperation(
  recordId: string,
  outcome: { resultModel: string | null; resultId: number | null; result: unknown },
  store: OperationStore = prismaOperationStore,
): Promise<OperationRecord> {
  return store.markSucceeded(recordId, {
    result_model: outcome.resultModel,
    result_id: outcome.resultId,
    result: outcome.result,
  })
}

/**
 * Record a failure. The row is kept, not deleted: a retry must be able to see
 * that a previous attempt happened and what went wrong with it.
 */
export async function failOperation(
  recordId: string,
  failure: { code: string; detail?: string | null },
  store: OperationStore = prismaOperationStore,
): Promise<OperationRecord> {
  return store.markFailed(recordId, { failure_code: failure.code, failure_detail: failure.detail ?? null })
}
