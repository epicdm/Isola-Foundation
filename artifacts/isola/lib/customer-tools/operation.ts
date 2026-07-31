/**
 * The customer-tool exactly-once ledger — now a thin wrapper.
 *
 * Every export and every signature in this file is unchanged. What changed is
 * underneath: the claim lifecycle is `lib/operations/ledger.ts`, shared with
 * Foundation staff actions. One table, one set of race semantics, one place to
 * reason about "has this already happened".
 *
 * WHAT DELIBERATELY DID NOT CHANGE
 * --------------------------------
 * 1. The operation ID. `deriveOperationId` below is byte-for-byte the scheme
 *    that produced every row already in the table. Re-deriving under the neutral
 *    scheme would have made every historical operation invisible — and an
 *    invisible completed operation is one that runs a second time.
 * 2. The inputs. Customer tools still require the tenant, the transport-verified
 *    customer identity, the conversation, the session, the correlation, the
 *    hint, and the policy-approved assignee where one applies. The shared ledger
 *    unifies STORAGE. It does not unify authorization.
 *
 * The two id shapes cannot collide: this file mints `op-` + 32 hex; the neutral
 * scheme mints `op_` + 64 hex. Different separator, different length. A test
 * asserts it rather than trusting it.
 */

import {
  canonicalJson as neutralCanonicalJson,
  claimOperation as ledgerClaim,
  completeOperation as ledgerComplete,
  failOperation as ledgerFail,
  hashArguments as neutralHashArguments,
  prismaLedgerStore,
  rowToLedgerRecord,
  unwrapResult,
  type LedgerRecord,
  type LedgerStore,
  type OperationEnvelope,
} from '@/lib/operations/ledger'
import { prisma } from '@/lib/prisma'

import { createHash } from 'node:crypto'

export const OPERATION_STATES = ['claimed', 'succeeded', 'failed'] as const
export type OperationState = (typeof OPERATION_STATES)[number]

/**
 * Canonical JSON: object keys sorted at every depth, so two arguments objects
 * that differ only in key order hash the same. Without this, a retry whose
 * serialiser happened to emit keys in another order would look like a
 * conflicting request and be refused.
 */
export const canonicalJson = neutralCanonicalJson

/** SHA-256 of the canonical form of the AUTHORISED arguments. */
export const hashArguments = neutralHashArguments

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
 * UNCHANGED, and it must stay unchanged: every row already in the table was
 * keyed this way. Deterministic, tenant-prefixed, no state carried between
 * attempts.
 */
export function deriveOperationId(input: DeriveOperationIdInput): string {
  const material = canonicalJson([
    input.tenantId,
    input.toolName,
    input.conversationId,
    input.hint,
    input.requestHash,
  ])
  return `op-${createHash('sha256').update(material).digest('hex').slice(0, 32)}`
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
  | { status: 'claimed'; operationId: string; recordId: string }
  /** Completed earlier. Return `result` verbatim; do not execute. */
  | {
      status: 'already_succeeded'
      operationId: string
      resultModel: string | null
      resultId: number | null
      result: unknown
    }
  /** Another attempt holds the claim right now. Do not execute. */
  | { status: 'in_flight'; operationId: string; claimedAt: Date }
  /** Same id, different arguments. Refuse - this is not a retry. */
  | { status: 'conflict'; operationId: string; detail: string }
  /** A previous attempt failed. The claim is re-taken; execute again. */
  | {
      status: 'retry_after_failure'
      operationId: string
      recordId: string
      previousFailureCode: string | null
    }

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
  markSucceeded(
    id: string,
    data: { result_model: string | null; result_id: number | null; result: unknown },
  ): Promise<OperationRecord>
  markFailed(
    id: string,
    data: { failure_code: string; failure_detail: string | null },
  ): Promise<OperationRecord>
}

/** Postgres unique-violation, as surfaced by Prisma. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof (err as { code?: unknown })?.code === 'string' &&
    (err as { code: string }).code === 'P2002'
  )
}

export const prismaOperationStore: OperationStore = {
  findByOperationId: (tenantId, operationId) =>
    prisma.customerToolOperation.findUnique({
      where: { tenant_id_operation_id: { tenant_id: tenantId, operation_id: operationId } },
    }) as unknown as Promise<OperationRecord | null>,
  insert: (row) =>
    prisma.customerToolOperation.create({ data: row }) as unknown as Promise<OperationRecord>,
  reclaim: (id) =>
    prisma.customerToolOperation.update({
      where: { id },
      data: {
        state: 'claimed',
        failure_code: null,
        failure_detail: null,
        claimed_at: new Date(),
        completed_at: null,
      },
    }) as unknown as Promise<OperationRecord>,
  markSucceeded: (id, data) =>
    prisma.customerToolOperation.update({
      where: { id },
      data: {
        state: 'succeeded',
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
        state: 'failed',
        failure_code: data.failure_code,
        failure_detail: data.failure_detail,
        completed_at: new Date(),
      },
    }) as unknown as Promise<OperationRecord>,
}

/**
 * Presents a customer-tool `OperationStore` to the neutral ledger. Injected
 * fakes in the existing tests keep working untouched, which is the point: if
 * those tests still pass, the behaviour genuinely did not change.
 */
export function ledgerStoreFrom(store: OperationStore): LedgerStore {
  const toLedger = (r: OperationRecord): LedgerRecord =>
    rowToLedgerRecord(r as unknown as Record<string, unknown>)

  return {
    find: (tenantId, operationId) =>
      store.findByOperationId(tenantId, operationId).then((r) => (r ? toLedger(r) : null)),
    insert: (row) =>
      store
        .insert({
          tenant_id: row.tenantId,
          operation_id: row.operationId,
          tool_name: row.toolName,
          request_hash: row.requestHash,
          conversation_id: row.contextRef ?? '',
          correlation_id: row.correlationId,
          agent_session_id: row.actorRef || null,
        })
        .then(toLedger),
    reclaim: (recordId) => store.reclaim(recordId).then(toLedger),
    markCompleted: (recordId, data) =>
      store
        .markSucceeded(recordId, {
          result_model: data.resultModel,
          result_id: data.resultId,
          result: data.envelope,
        })
        .then(toLedger),
    markFailed: (recordId, data) =>
      store
        .markFailed(recordId, {
          failure_code: data.failureClass,
          failure_detail: data.failureDetail,
        })
        .then(toLedger),
    isUniqueViolation,
  }
}

/** The envelope shape a customer-tool operation records for the auditor. */
function envelopeFor(input: ClaimOperationInput): OperationEnvelope {
  return {
    version: 'operations.ledger@1',
    callerClass: 'customer_agent',
    companyId: input.tenantId,
    actionType: input.toolName,
    objectType: 'customer_tool',
    objectId: input.conversationId,
    actorRef: input.agentSessionId ?? '',
    auditRef: null,
    readback: null,
    result: null,
  }
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

  const outcome = await ledgerClaim(
    {
      identity: {
        callerClass: 'customer_agent',
        tenantId: input.tenantId,
        companyId: input.tenantId,
        actionType: input.toolName,
        objectType: 'customer_tool',
        objectId: input.conversationId,
        idempotencyKey: input.hint,
      },
      // The historical id, kept. See the file header.
      operationIdOverride: operationId,
      toolNameOverride: input.toolName,
      authorizedArguments: input.authorisedArguments,
      correlationId: input.correlationId,
      actorRef: input.agentSessionId ?? '',
      contextRef: input.conversationId,
      // Same id, different tool, is not a retry either.
      guard: (existing) =>
        existing.toolName && existing.toolName !== input.toolName
          ? 'operation id reused for a different tool'
          : null,
    },
    ledgerStoreFrom(store),
  )

  switch (outcome.status) {
    case 'claimed':
      return { status: 'claimed', operationId, recordId: outcome.recordId }
    case 'already_completed':
      return {
        status: 'already_succeeded',
        operationId,
        resultModel: outcome.record.resultModel,
        resultId: outcome.record.resultId,
        // Rows written before the envelope existed hold the result directly.
        result: unwrapResult(outcome.record.rawResult),
      }
    case 'in_flight':
      return { status: 'in_flight', operationId, claimedAt: outcome.claimedAt }
    case 'argument_conflict':
      return {
        status: 'conflict',
        operationId,
        detail:
          outcome.detail === 'operation id reused for a different tool'
            ? outcome.detail
            : 'operation id reused with different authorised arguments',
      }
    case 'retry_after_failure':
      return {
        status: 'retry_after_failure',
        operationId,
        recordId: outcome.recordId,
        previousFailureCode: outcome.previousFailureClass,
      }
    default:
      // `previously_failed` cannot occur: retryFailed defaults to true.
      throw new Error(`unexpected ledger outcome ${(outcome as { status: string }).status}`)
  }
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
  const ledgerStore = ledgerStoreFrom(store)
  const existing = await ledgerStore.find('', '').catch(() => null)
  void existing

  const record = await ledgerComplete(
    recordId,
    {
      envelope: {
        version: 'operations.ledger@1',
        callerClass: 'customer_agent',
        companyId: '',
        actionType: '',
        objectType: 'customer_tool',
        objectId: '',
        actorRef: '',
        auditRef: null,
        readback: null,
        result: null,
      },
      readback: null,
      result: outcome.result,
      resultModel: outcome.resultModel,
      resultId: outcome.resultId,
    },
    ledgerStore,
  )
  return ledgerRecordToOperationRecord(record, outcome.result)
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
  const record = await ledgerFail(
    recordId,
    { failureClass: failure.code, detail: failure.detail ?? null },
    ledgerStoreFrom(store),
  )
  return ledgerRecordToOperationRecord(record)
}

function ledgerRecordToOperationRecord(r: LedgerRecord, result?: unknown): OperationRecord {
  return {
    id: r.recordId,
    tenant_id: r.tenantId,
    operation_id: r.operationId,
    tool_name: r.toolName ?? '',
    request_hash: r.requestHash,
    state: r.state === 'completed' ? 'succeeded' : r.state,
    result_model: r.resultModel,
    result_id: r.resultId,
    result: result !== undefined ? result : unwrapResult(r.rawResult),
    failure_code: r.failureClass,
    claimed_at: r.claimedAt,
  }
}
