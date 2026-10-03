/**
 * The durable delivery ledger.
 *
 * WHY THIS EXISTS
 * ---------------
 * De-duplication used to live in a `Map` (see `MemoryIdempotencyStore`). That
 * was honest but incomplete: a container replacement lost the window, so a
 * duplicate delivery arriving across a restart produced a SECOND customer
 * reply. This module closes that gap without giving the only publicly-exposed
 * component a filesystem.
 *
 * WHAT IS AND IS NOT STORED
 * -------------------------
 * Identifiers, state and digests only. Specifically NOT: message bodies, AI
 * answers, attachment filenames, attachment URLs, credentials, or anything else
 * a customer wrote or the model produced. `test/ledger-no-content.test.ts`
 * asserts the column list by source scan, so a future column carrying content
 * fails the build rather than the audit.
 *
 * The one thing a restart needs that is NOT here is the message text itself.
 * That is deliberate: on recovery the text is re-read from Chatwoot, which
 * already owns it, rather than duplicated into a second store.
 *
 * ATOMICITY
 * ---------
 * The primary key IS the atomic key the owner specified:
 *
 *     (tenant, binding, chatwoot account, chatwoot inbox, event id, action type)
 *
 * Uniqueness is enforced by Postgres, not by this code — two concurrent
 * `INSERT ... ON CONFLICT` statements cannot both report `inserted`. That is
 * the property in-memory de-duplication could never have across processes.
 *
 * CONFLICT
 * --------
 * The same event id re-presented with a DIFFERENT signed-body digest is not a
 * retry, it is a collision or a tampering attempt. It is refused and alerted
 * on, never processed.
 *
 * NO FILESYSTEM
 * -------------
 * `pg` opens a TCP socket to a private, non-exposed host. `node:fs` remains
 * absent from this service, and `src/ledger.ts` is the only module permitted to
 * import `pg` — `test/no-direct-network.test.ts` asserts both.
 */
// `pg` is CommonJS. Under NodeNext a NAMED runtime import (`import { Pool }`)
// type-checks — @types/pg declares named exports — and then throws
// `SyntaxError: Named export 'Pool' not found` the moment plain Node loads the
// built file. Vitest does not reproduce it because Vite interops CJS for you,
// so the unit suite passes and only the deployed container fails. This did
// happen: the first deploy of this module crash-looped on exactly that line.
//
// The default import is the interop-safe form, and `import type` is erased at
// compile time so it adds no runtime named import.
// `test/no-direct-network.test.ts` asserts the shape, and the Dockerfile loads
// the built module graph under plain Node so the class cannot recur silently.
import pgPkg from "pg";
import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";

const { Pool } = pgPkg;

import {
  DELIVERY_ACTION,
  deliveryRef,
  type LedgerIdentity,
} from "./deliveryref.js";

export {
  DELIVERY_ACTION,
  DELIVERY_REF_ATTRIBUTE,
  bindingIdentity,
  deliveryRef,
  payloadDigest,
  type LedgerIdentity,
} from "./deliveryref.js";

export type DeliveryState =
  /** Durably accepted, not yet worked. A restart must resume this. */
  | "reserved"
  /** A worker holds the lease and is running the pipeline. */
  | "in_progress"
  /** Finished. Nothing may be sent for this key again. */
  | "completed"
  /** Finished unsuccessfully and deliberately not retried. */
  | "failed";

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type ReserveResult =
  /** This process now owns the key. Nobody has worked it. */
  | { kind: "reserved"; attempts: number }
  /**
   * A prior reservation existed whose lease had expired, and this process has
   * taken it over. Work may already be partly done, so every write must be
   * claimed and every ambiguous send reconciled.
   */
  | { kind: "resumed"; attempts: number }
  /** Already claimed by a live lease, or already finished. Do nothing. */
  | { kind: "duplicate"; state: DeliveryState }
  /** Same key, different signed body. Refuse and alert. */
  | { kind: "conflict"; storedDigest: string };

export type ClaimResult =
  /** A fresh claim. `attempts` (1) is the claim's token: `release` presents it. */
  | { kind: "claimed"; attempts: number }
  | { kind: "completed"; chatwootMessageId: number | null }
  /**
   * Claimed by a previous attempt that never recorded an outcome. Whether the
   * write reached Chatwoot is UNKNOWN — the caller must reconcile, never
   * blindly resend.
   *
   * `owned` says whether THIS caller now holds the claim (Codex R4): true when the previous
   * claim's lease had expired or been released and this call took it over (`attempts` was
   * incremented and is the new token); false when another worker's lease is still live, in
   * which case this caller holds nothing and must not release it. Concurrent execution of the
   * action is NOT prevented either way (the exclusivity gap, Codex F2/F3, is open by design).
   */
  | { kind: "ambiguous"; attempts: number; owned: boolean };

/**
 * One ACTION row beneath a delivery, as recovery needs to see it (Codex R5): its state and the
 * disposition code recorded when it was closed without being performed. Reads existing
 * columns only; no schema change.
 */
export interface DeliveryActionRow {
  action: string;
  state: DeliveryState;
  /** `failure_code` of a `failed` row (a recorded disposition), else null. */
  failureCode: string | null;
}

/** A delivery whose lease expired before it finished. */
export interface RecoverableDelivery {
  tenantId: string;
  bindingId: string;
  chatwootAccountId: number;
  chatwootInboxId: number;
  eventId: string;
  payloadDigest: string;
  correlationId: string;
  conversationId: number | null;
  messageId: number | null;
  mode: string | null;
  state: DeliveryState;
  attempts: number;
}

/** The ledger could not be reached. NEVER treat this as "not a duplicate". */
export class LedgerUnavailableError extends Error {
  constructor(cause: string) {
    super(`delivery ledger unavailable: ${cause}`);
    this.name = "LedgerUnavailableError";
  }
}

export interface ReserveArgs {
  identity: LedgerIdentity;
  digest: string;
  correlationId: string;
  conversationId: number | null;
  messageId: number | null;
  mode: string;
  leaseMs: number;
}

/** What a statement returns. Deliberately the smallest useful shape: the rows
 *  and the row count, because `rowCount` IS the result for a conditional
 *  update used as a claim. */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/**
 * The minimal SQL surface, so a module that needs the database does not need
 * the driver.
 *
 * `src/ownership-store.ts` issues SQL through this interface and imports no
 * database package at all. That keeps the structural guarantee asserted by
 * `test/no-direct-network.test.ts` — `pg` is imported by this file and by no
 * other — intact while a SECOND store shares the one pool. One driver import,
 * one pool, one confinement rule, two stores.
 */
export interface SqlClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

export interface SqlExecutor extends SqlClient {
  /**
   * Run `fn` inside ONE transaction on ONE pooled connection: `BEGIN`, the
   * body, then `COMMIT`, or `ROLLBACK` if the body throws.
   *
   * A single connection is the point, not an implementation detail. `SELECT
   * ... FOR UPDATE` takes a row lock that is held until the transaction ends,
   * and the ownership engine's preconditions — `allowedFrom` and
   * `expectedEpisode` — are only sound if they are evaluated while that lock is
   * held. Issuing the lock and the check on two pooled connections would take
   * the lock in one transaction and test the precondition in another, which is
   * no lock at all.
   *
   * ERRORS FROM `fn` PROPAGATE UNWRAPPED, on purpose. See `SqlClient` below.
   */
  transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T>;
}

export interface Ledger {
  /** Idempotent DDL. Safe to run on every boot. */
  migrate(): Promise<void>;
  reserve(args: ReserveArgs): Promise<ReserveResult>;
  /** Claim one write beneath a delivery. */
  claimAction(
    identity: LedgerIdentity,
    action: string,
    digest: string,
    correlationId: string,
    leaseMs: number,
  ): Promise<ClaimResult>;
  complete(
    identity: LedgerIdentity,
    action: string,
    chatwootMessageId: number | null,
  ): Promise<void>;
  fail(identity: LedgerIdentity, action: string, failureCode: string): Promise<void>;
  /**
   * Give back an action that was CLAIMED and then NOT PERFORMED because the turn budget
   * ran out (Codex R3 F4). It is NOT `fail`: a failed row is terminal and `claimAction`
   * reports it as completed, so the worker that resumes the delivery would skip an
   * action that never happened. A released row stays `in_progress` with its lease
   * expired, which `claimAction` reports as `ambiguous` -- the existing, tested
   * "claimed and never recorded" path: a message is reconciled against Chatwoot and sent
   * only if proven absent; an idempotent write is simply re-run. No schema change.
   * Only an `in_progress` row is touched: a completed or failed row is never reopened.
   *
   * HOLDER-FENCED (Codex R4): `attempts` is the token the caller's own `claimAction` returned,
   * and the release applies only while the row still carries that token AND this process's
   * lease owner. A stale worker whose claim was taken over (a later `claimAction` incremented
   * `attempts`) cannot clear the new holder's lease. Returns true when it released, false when
   * it did not (stale, terminal, or not this process's claim): a refusal is not an error.
   */
  release(identity: LedgerIdentity, action: string, attempts: number): Promise<boolean>;
  /**
   * The ACTIONS (never the delivery row) of one delivery that are claimed and not settled:
   * `in_progress`, whether still leased, released or expired (Codex R4 G4-1). A delivery
   * whose reply was found in Chatwoot is NOT finished while any of these remains: it
   * ordinarily means a released escalation (note, status change, assignment) or an
   * annotation that was never published. Reads existing columns only; no schema change.
   */
  unsettledActions(identity: LedgerIdentity): Promise<string[]>;
  /**
   * EVERY action row of one delivery with its state and recorded disposition (Codex R5).
   * Recovery decides from these durable rows -- never from what is visible in a Chatwoot
   * message window -- whether a delivery is provably complete or must be escalated.
   */
  deliveryActions(identity: LedgerIdentity): Promise<DeliveryActionRow[]>;
  /** Extend the lease on a long-running delivery. */
  heartbeat(identity: LedgerIdentity, action: string, leaseMs: number): Promise<void>;
  dueForRecovery(limit: number): Promise<RecoverableDelivery[]>;
  healthy(): Promise<boolean>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Explicit DDL, idempotent, additive only. There is no ORM and no
 * diff-the-schema step: what runs is what is written here.
 *
 * Every column is an identifier, a state, a digest, a timestamp or a counter.
 * There is deliberately no column that could hold a message body, an answer, an
 * attachment name or a URL.
 */
export const LEDGER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS delivery_ledger (
  tenant_id            text        NOT NULL,
  binding_id           text        NOT NULL,
  chatwoot_account_id  integer     NOT NULL,
  chatwoot_inbox_id    integer     NOT NULL,
  event_id             text        NOT NULL,
  action_type          text        NOT NULL,
  payload_digest       text        NOT NULL,
  delivery_ref         text        NOT NULL,
  correlation_id       text        NOT NULL,
  delivery_state       text        NOT NULL,
  conversation_id      integer,
  message_id           bigint,
  mode                 text,
  chatwoot_message_id  bigint,
  lease_owner          text,
  lease_expires_at     timestamptz,
  attempts             integer     NOT NULL DEFAULT 0,
  failure_code         text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,
  CONSTRAINT delivery_ledger_pkey PRIMARY KEY
    (tenant_id, binding_id, chatwoot_account_id, chatwoot_inbox_id, event_id, action_type)
);

CREATE INDEX IF NOT EXISTS delivery_ledger_recovery_idx
  ON delivery_ledger (lease_expires_at)
  WHERE action_type = 'delivery' AND delivery_state IN ('reserved', 'in_progress');

CREATE INDEX IF NOT EXISTS delivery_ledger_ref_idx
  ON delivery_ledger (delivery_ref);

CREATE INDEX IF NOT EXISTS delivery_ledger_tenant_idx
  ON delivery_ledger (tenant_id, created_at DESC);
`;

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

const KEY_PREDICATE = `
  tenant_id = $1 AND binding_id = $2 AND chatwoot_account_id = $3
  AND chatwoot_inbox_id = $4 AND event_id = $5 AND action_type = $6
`;

function keyParams(identity: LedgerIdentity, action: string): unknown[] {
  return [
    identity.tenantId,
    identity.bindingId,
    identity.chatwootAccountId,
    identity.chatwootInboxId,
    identity.eventId,
    action,
  ];
}

export interface PostgresLedgerOptions {
  /** Connection string for the private ledger store. */
  connectionString: string;
  /** Identifies this process in `lease_owner`. Never a secret. */
  instanceId: string;
  poolSize?: number;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
}

export class PostgresLedger implements Ledger, SqlExecutor {
  private readonly pool: PgPool;
  private readonly instanceId: string;

  constructor(options: PostgresLedgerOptions) {
    const config: PoolConfig = {
      connectionString: options.connectionString,
      max: options.poolSize ?? 4,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 3_000,
      // A statement that hangs on the ACK path is as bad as an unreachable
      // ledger, so bound it rather than inheriting the server default.
      statement_timeout: options.statementTimeoutMs ?? 3_000,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: false,
    };
    this.pool = new Pool(config);
    // An idle client that errors must not take the process down. The next
    // query will surface the failure as LedgerUnavailableError instead.
    this.pool.on("error", () => undefined);
    this.instanceId = options.instanceId;
  }

  /**
   * One pooled statement.
   *
   * The delivery ledger's own call sites want a failure here to be
   * indistinguishable from "the ledger is unreachable", because for them it is:
   * either way the delivery cannot be recorded and must fail closed. So the
   * driver error is deliberately flattened into `LedgerUnavailableError`, and
   * only its NAME is carried — never its message, which can quote SQL and
   * parameter values.
   */
  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (err) {
      throw new LedgerUnavailableError(err instanceof Error ? err.name : "connect_failed");
    }
    try {
      const result = await client.query(sql, params as unknown[]);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    } catch (err) {
      throw new LedgerUnavailableError(err instanceof Error ? err.name : "query_failed");
    } finally {
      client.release();
    }
  }

  /**
   * See `SqlExecutor.transaction`.
   *
   * WHY THE SCOPED CLIENT DOES NOT WRAP ITS ERRORS
   *   The ownership engine has to tell a UNIQUE-violation (SQLSTATE `23505` —
   *   a concurrent writer claimed the same operation id, which is a normal,
   *   expected outcome meaning "the other one won") apart from a database that
   *   is unreachable (which must fail closed and alert). `LedgerUnavailableError`
   *   carries only the error NAME, so wrapping here would erase the SQLSTATE
   *   that distinguishes them and the engine would have to guess. It would
   *   guess "unavailable", and a routine concurrent claim would page somebody.
   *
   *   The raw driver error is therefore rethrown as-is. It never reaches a log
   *   or a response: `src/ownership-store.ts` classifies it by `code` and
   *   returns a value.
   */
  async transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (err) {
      throw new LedgerUnavailableError(err instanceof Error ? err.name : "connect_failed");
    }

    const scoped: SqlClient = {
      query: async <T2 = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ): Promise<QueryResult<T2>> => {
        const result = await client.query(sql, params as unknown[]);
        return { rows: result.rows as T2[], rowCount: result.rowCount ?? 0 };
      },
    };

    // When ROLLBACK itself fails the connection cannot be trusted to be back at
    // idle, and node-postgres does NOT close an open transaction for you when a
    // client is returned. Handing such a client back to the pool would let the
    // next unrelated caller inherit an open transaction. Passing a truthy value
    // to release() destroys the client instead, and the pool opens a fresh one.
    let poisoned: unknown = null;

    try {
      await client.query("BEGIN");
      const result = await fn(scoped);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackErr) {
        poisoned = rollbackErr;
      }
      // The ORIGINAL error is rethrown either way: it is the one that explains
      // what happened, and the ownership engine classifies it by SQLSTATE.
      throw err;
    } finally {
      if (poisoned !== null) client.release(true);
      else client.release();
    }
  }

  async migrate(): Promise<void> {
    await this.query(LEDGER_SCHEMA_SQL, []);
  }

  /**
   * Insert-or-take-over, in one statement.
   *
   * `xmax = 0` is true only for a freshly inserted row, so the same statement
   * distinguishes a first claim from a lease takeover without a second round
   * trip and without a race between them. The `DO UPDATE ... WHERE` clause is
   * what makes takeover safe: it fires only when the digest matches AND the
   * prior lease has actually expired.
   */
  async reserve(args: ReserveArgs): Promise<ReserveResult> {
    const { identity } = args;
    const ref = deliveryRef(identity, DELIVERY_ACTION);
    const leaseSeconds = Math.max(1, Math.ceil(args.leaseMs / 1000));

    const inserted = await this.query<{
      inserted: boolean;
      delivery_state: DeliveryState;
      attempts: number;
    }>(
      `
      INSERT INTO delivery_ledger (
        tenant_id, binding_id, chatwoot_account_id, chatwoot_inbox_id,
        event_id, action_type, payload_digest, delivery_ref, correlation_id,
        delivery_state, conversation_id, message_id, mode,
        lease_owner, lease_expires_at, attempts
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8, $9,
        'reserved', $10, $11, $12,
        $13, now() + make_interval(secs => $14::double precision), 1
      )
      ON CONFLICT ON CONSTRAINT delivery_ledger_pkey DO UPDATE
        SET lease_owner       = EXCLUDED.lease_owner,
            lease_expires_at  = EXCLUDED.lease_expires_at,
            delivery_state    = 'reserved',
            attempts          = delivery_ledger.attempts + 1,
            updated_at        = now()
        WHERE delivery_ledger.payload_digest = EXCLUDED.payload_digest
          AND delivery_ledger.delivery_state IN ('reserved', 'in_progress')
          AND delivery_ledger.lease_expires_at < now()
      RETURNING (xmax = 0) AS inserted, delivery_state, attempts
      `,
      [
        identity.tenantId,
        identity.bindingId,
        identity.chatwootAccountId,
        identity.chatwootInboxId,
        identity.eventId,
        DELIVERY_ACTION,
        args.digest,
        ref,
        args.correlationId,
        args.conversationId,
        args.messageId,
        args.mode,
        this.instanceId,
        leaseSeconds,
      ],
    );

    const row = inserted.rows[0];
    if (row !== undefined) {
      return row.inserted
        ? { kind: "reserved", attempts: row.attempts }
        : { kind: "resumed", attempts: row.attempts };
    }

    // The row exists but the takeover predicate refused. Classify why.
    const existing = await this.query<{
      payload_digest: string;
      delivery_state: DeliveryState;
    }>(
      `SELECT payload_digest, delivery_state FROM delivery_ledger WHERE ${KEY_PREDICATE}`,
      keyParams(identity, DELIVERY_ACTION),
    );
    const found = existing.rows[0];
    if (found === undefined) {
      // Vanishingly rare: deleted between the two statements. Treat as a
      // duplicate rather than sending twice.
      return { kind: "duplicate", state: "completed" };
    }
    if (found.payload_digest !== args.digest) {
      return { kind: "conflict", storedDigest: found.payload_digest };
    }
    return { kind: "duplicate", state: found.delivery_state };
  }

  async claimAction(
    identity: LedgerIdentity,
    action: string,
    digest: string,
    correlationId: string,
    leaseMs: number,
  ): Promise<ClaimResult> {
    const ref = deliveryRef(identity, action);
    const leaseSeconds = Math.max(1, Math.ceil(leaseMs / 1000));

    // Insert-or-ACQUIRE (Codex R4). A first claim inserts (attempts 1). A claim whose lease
    // has EXPIRED or been RELEASED is taken over by this caller in the same statement:
    // `attempts` is incremented, which is the claim's token (`release` presents it) and the
    // count of how often the action was attempted. A claim another worker still holds under a
    // live lease, and any completed or failed row, is not touched.
    const inserted = await this.query<{ inserted: boolean; attempts: number }>(
      `
      INSERT INTO delivery_ledger (
        tenant_id, binding_id, chatwoot_account_id, chatwoot_inbox_id,
        event_id, action_type, payload_digest, delivery_ref, correlation_id,
        delivery_state, lease_owner, lease_expires_at, attempts
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8, $9,
        'in_progress', $10, now() + make_interval(secs => $11::double precision), 1
      )
      ON CONFLICT ON CONSTRAINT delivery_ledger_pkey DO UPDATE
        SET lease_owner       = EXCLUDED.lease_owner,
            lease_expires_at  = EXCLUDED.lease_expires_at,
            attempts          = delivery_ledger.attempts + 1,
            updated_at        = now()
        WHERE delivery_ledger.delivery_state = 'in_progress'
          AND (delivery_ledger.lease_expires_at IS NULL
               OR delivery_ledger.lease_expires_at <= now())
      RETURNING (xmax = 0) AS inserted, attempts
      `,
      [
        identity.tenantId,
        identity.bindingId,
        identity.chatwootAccountId,
        identity.chatwootInboxId,
        identity.eventId,
        action,
        digest,
        ref,
        correlationId,
        this.instanceId,
        leaseSeconds,
      ],
    );

    const took = inserted.rows[0];
    if (took !== undefined) {
      return took.inserted
        ? { kind: "claimed", attempts: took.attempts }
        : { kind: "ambiguous", attempts: took.attempts, owned: true };
    }

    const existing = await this.query<{
      delivery_state: DeliveryState;
      chatwoot_message_id: string | number | null;
      attempts: number;
    }>(
      `SELECT delivery_state, chatwoot_message_id, attempts FROM delivery_ledger WHERE ${KEY_PREDICATE}`,
      keyParams(identity, action),
    );
    const found = existing.rows[0];
    if (found === undefined) return { kind: "claimed", attempts: 1 };
    if (found.delivery_state === "completed") {
      const id = found.chatwoot_message_id;
      return {
        kind: "completed",
        chatwootMessageId: id === null ? null : Number(id),
      };
    }
    if (found.delivery_state === "failed") {
      // A deliberate, recorded failure is not retried blind either.
      return { kind: "completed", chatwootMessageId: null };
    }
    // In progress under a lease another worker still holds: report it, do not take it.
    return { kind: "ambiguous", attempts: found.attempts, owned: false };
  }

  async complete(
    identity: LedgerIdentity,
    action: string,
    chatwootMessageId: number | null,
  ): Promise<void> {
    await this.query(
      `
      UPDATE delivery_ledger
         SET delivery_state      = 'completed',
             chatwoot_message_id = COALESCE($7, chatwoot_message_id),
             lease_owner         = NULL,
             lease_expires_at    = NULL,
             completed_at        = now(),
             updated_at          = now()
       WHERE ${KEY_PREDICATE}
      `,
      [...keyParams(identity, action), chatwootMessageId],
    );
  }

  async fail(identity: LedgerIdentity, action: string, failureCode: string): Promise<void> {
    await this.query(
      `
      UPDATE delivery_ledger
         SET delivery_state   = 'failed',
             failure_code     = $7,
             lease_owner      = NULL,
             lease_expires_at = NULL,
             completed_at     = now(),
             updated_at       = now()
       WHERE ${KEY_PREDICATE}
      `,
      [...keyParams(identity, action), failureCode],
    );
  }

  async release(identity: LedgerIdentity, action: string, attempts: number): Promise<boolean> {
    // Holder-fenced: only the claim this process took (its lease owner, its attempts token)
    // can be released. A stale worker, or a claim since taken over, matches no row.
    const result = await this.query(
      `
      UPDATE delivery_ledger
         SET lease_owner      = NULL,
             lease_expires_at = now(),
             updated_at       = now()
       WHERE ${KEY_PREDICATE}
         AND delivery_state = 'in_progress'
         AND attempts       = $7
         AND lease_owner    = $8
      `,
      [...keyParams(identity, action), attempts, this.instanceId],
    );
    return result.rowCount === 1;
  }

  async unsettledActions(identity: LedgerIdentity): Promise<string[]> {
    const result = await this.query<{ action_type: string }>(
      `
      SELECT action_type
        FROM delivery_ledger
       WHERE tenant_id = $1 AND binding_id = $2 AND chatwoot_account_id = $3
         AND chatwoot_inbox_id = $4 AND event_id = $5
         AND action_type <> $6
         AND delivery_state = 'in_progress'
       ORDER BY action_type
      `,
      [
        identity.tenantId,
        identity.bindingId,
        identity.chatwootAccountId,
        identity.chatwootInboxId,
        identity.eventId,
        DELIVERY_ACTION,
      ],
    );
    return result.rows.map((r) => r.action_type);
  }

  async deliveryActions(identity: LedgerIdentity): Promise<DeliveryActionRow[]> {
    const result = await this.query<{
      action_type: string;
      delivery_state: DeliveryState;
      failure_code: string | null;
    }>(
      `
      SELECT action_type, delivery_state, failure_code
        FROM delivery_ledger
       WHERE tenant_id = $1 AND binding_id = $2 AND chatwoot_account_id = $3
         AND chatwoot_inbox_id = $4 AND event_id = $5
         AND action_type <> $6
       ORDER BY action_type
      `,
      [
        identity.tenantId,
        identity.bindingId,
        identity.chatwootAccountId,
        identity.chatwootInboxId,
        identity.eventId,
        DELIVERY_ACTION,
      ],
    );
    return result.rows.map((r) => ({
      action: r.action_type,
      state: r.delivery_state,
      failureCode: r.failure_code,
    }));
  }

  async heartbeat(
    identity: LedgerIdentity,
    action: string,
    leaseMs: number,
  ): Promise<void> {
    await this.query(
      `
      UPDATE delivery_ledger
         SET delivery_state   = 'in_progress',
             lease_expires_at = now() + make_interval(secs => $7::double precision),
             updated_at       = now()
       WHERE ${KEY_PREDICATE}
      `,
      [...keyParams(identity, action), Math.max(1, Math.ceil(leaseMs / 1000))],
    );
  }

  async dueForRecovery(limit: number): Promise<RecoverableDelivery[]> {
    const result = await this.query<{
      tenant_id: string;
      binding_id: string;
      chatwoot_account_id: number;
      chatwoot_inbox_id: number;
      event_id: string;
      payload_digest: string;
      correlation_id: string;
      conversation_id: number | null;
      message_id: string | number | null;
      mode: string | null;
      delivery_state: DeliveryState;
      attempts: number;
    }>(
      `
      SELECT tenant_id, binding_id, chatwoot_account_id, chatwoot_inbox_id,
             event_id, payload_digest, correlation_id, conversation_id,
             message_id, mode, delivery_state, attempts
        FROM delivery_ledger
       WHERE action_type = 'delivery'
         AND delivery_state IN ('reserved', 'in_progress')
         AND lease_expires_at < now()
       ORDER BY lease_expires_at ASC
       LIMIT $1
      `,
      [Math.max(1, limit)],
    );
    return result.rows.map((r) => ({
      tenantId: r.tenant_id,
      bindingId: r.binding_id,
      chatwootAccountId: r.chatwoot_account_id,
      chatwootInboxId: r.chatwoot_inbox_id,
      eventId: r.event_id,
      payloadDigest: r.payload_digest,
      correlationId: r.correlation_id,
      conversationId: r.conversation_id,
      messageId: r.message_id === null ? null : Number(r.message_id),
      mode: r.mode,
      state: r.delivery_state,
      attempts: r.attempts,
    }));
  }

  async healthy(): Promise<boolean> {
    try {
      await this.query("SELECT 1", []);
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Returns the ledger AND the SQL executor the ownership store needs, because
 * they are one object over one pool. Widening the return type rather than the
 * `Ledger` interface is deliberate: `src/app.ts` and the test double in
 * `test/harness.ts` continue to depend on `Ledger` alone and are unaffected.
 */
export function createLedger(options: PostgresLedgerOptions): Ledger & SqlExecutor {
  return new PostgresLedger(options);
}
