/**
 * The durable conversation-ownership store.
 *
 * WHY THIS IS A DATABASE AND NOT A FILE
 * -------------------------------------
 * Every correctness guarantee the ownership contract makes is a DATABASE
 * guarantee, and none of them can be provided by a process-local structure:
 *
 *   - exactly-once       -> a UNIQUE index the database enforces
 *   - the ack claim      -> a conditional UPDATE whose ROW COUNT is the answer
 *   - `allowedFrom`      -> a precondition read under a row lock, in the same
 *                           transaction as the write it guards
 *   - `expectedEpisode`  -> compared under that SAME lock
 *
 * The sibling service `isola-runtime` persists its whole state as one JSON file
 * behind an in-process promise chain. That serialises transactions within one
 * process and not at all across two, so two concurrent webhook deliveries race
 * on a whole-file read-modify-write and one silently wins. Porting this engine
 * onto that substrate would pass every test written against it and fail under
 * real concurrency, silently. So the store came first.
 *
 * WHERE IT LIVES
 * --------------
 * The same database as `delivery_ledger` — `isola_ledger` on the existing
 * managed Postgres — reached through the same pool via `SqlExecutor`.
 *
 * SAME DATABASE, DELIBERATELY. Postgres has no cross-database transaction. A
 * separate database would make it permanently impossible to claim a delivery
 * and move ownership in one atomic step, which is exactly the coupling the
 * reply path needs: suppress first, publish second, both or neither. The
 * cheaper-looking isolation would have bought nothing and foreclosed that.
 *
 * NO ORM, NO MIGRATION ENGINE
 * ---------------------------
 * Explicit, idempotent, additive DDL applied at boot — the idiom `ledger.ts`
 * already established here. What runs is what is written below. The same
 * statements are also checked in as a reviewable migration under
 * `migrations/`, so the schema has a diff even though nothing diffs it.
 *
 * NO CUSTOMER CONTENT
 * -------------------
 * Identifiers, states, episodes, reason CODES and timestamps only. No message
 * body, no answer text, no customer name, no attachment name, no credential.
 * `test/ledger-no-content.test.ts`'s column-scan discipline applies here too.
 */
import {
  assertReasonCode,
  canTransition,
  conversationKey,
  DEFAULT_OWNERSHIP_STATE,
  readEpisode,
  readState,
  type ConversationRef,
  type OwnershipGate,
  type OwnershipOperationKind,
  type OwnershipState,
  type OwnershipView,
  type TransitionOutcome,
  type TransitionStatus,
} from "./ownership.js";
import type { QueryResult, SqlClient, SqlExecutor } from "./ledger.js";

export type {
  ConversationRef,
  OwnershipGate,
  OwnershipView,
  TransitionOutcome,
  TransitionStatus,
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Idempotent and additive. Nothing here drops, renames or re-types anything,
 * and it does not touch `delivery_ledger`.
 *
 * `ownership_state` is TEXT with no enum and no CHECK, matching the ratified
 * Foundation schema and for the reason recorded there: the vocabulary is shared
 * with an external contract, and a Postgres enum (or a CHECK listing the
 * values) makes every future state a locking DDL migration on a live table.
 * An unrecognised value is not left to the database to catch — `readState()`
 * fails it closed to HUMAN_OWNED, which silences the AI rather than licensing
 * it. The two numeric CHECKs below constrain quantities, not vocabulary, so
 * they can never need to change.
 */
export const OWNERSHIP_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversation_ownership (
  tenant_id                         text        NOT NULL,
  conversation_key                  text        NOT NULL,
  chatwoot_account_id               integer     NOT NULL,
  chatwoot_conversation_id          integer     NOT NULL,
  chatwoot_inbox_id                 integer,
  binding_id                        text,
  ownership_state                   text        NOT NULL DEFAULT 'AI_OWNED',
  ownership_episode                 integer     NOT NULL DEFAULT 0,
  handover_ack_episode              integer,
  handover_ack_ref                  text,
  ownership_changed_at              timestamptz,
  ownership_reason                  text,
  ownership_actor_ref               text,
  ownership_correlation_id          text,
  ownership_escalation_operation_id text,
  ownership_handback_operation_id   text,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_ownership_pkey
    PRIMARY KEY (tenant_id, conversation_key),
  CONSTRAINT conversation_ownership_episode_nonneg
    CHECK (ownership_episode >= 0),
  CONSTRAINT conversation_ownership_ack_episode_nonneg
    CHECK (handover_ack_episode IS NULL OR handover_ack_episode >= 0)
);

-- Additive, for a database where the table above already exists.
-- CREATE TABLE IF NOT EXISTS does nothing at all when the table is present, so
-- a column added after the first deploy needs this second statement or it never
-- lands on the environments that mattered. ADD COLUMN IF NOT EXISTS is
-- idempotent, and adding a nullable column with no default does not rewrite the
-- table or take a long lock.
ALTER TABLE conversation_ownership
  ADD COLUMN IF NOT EXISTS handover_ack_ref text;

CREATE INDEX IF NOT EXISTS conversation_ownership_tenant_state_idx
  ON conversation_ownership (tenant_id, ownership_state);

CREATE TABLE IF NOT EXISTS conversation_ownership_transition (
  id               bigint      GENERATED ALWAYS AS IDENTITY,
  tenant_id        text        NOT NULL,
  conversation_key text        NOT NULL,
  episode          integer     NOT NULL,
  from_state       text        NOT NULL,
  to_state         text        NOT NULL,
  reason           text        NOT NULL,
  operation_id     text        NOT NULL,
  operation_kind   text        NOT NULL,
  actor_ref        text,
  correlation_id   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_ownership_transition_pkey PRIMARY KEY (id),
  CONSTRAINT conversation_ownership_transition_conversation_fkey
    FOREIGN KEY (tenant_id, conversation_key)
    REFERENCES conversation_ownership (tenant_id, conversation_key)
    ON DELETE RESTRICT ON UPDATE CASCADE
);

-- THE CLAIM. Exactly-once for escalation, assignment, handoff and handback is
-- this index and nothing else. A replayed webhook or a retried tool call
-- presenting the same operation id loses the INSERT, and its call site performs
-- no side effect.
--
-- A UNIQUE INDEX, not an ALTER TABLE ADD CONSTRAINT. Adding a constraint has
-- no IF NOT EXISTS form, so making it re-runnable needs a DROP first -- and
-- this DDL runs on EVERY boot, which would mean every restart briefly leaves
-- the claim unenforced. A restart is exactly when a redelivery storm arrives.
-- The enforcement is identical either way: a duplicate raises SQLSTATE 23505.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_ownership_transition_claim_key
  ON conversation_ownership_transition (tenant_id, conversation_key, operation_id);

CREATE INDEX IF NOT EXISTS conversation_ownership_transition_episode_idx
  ON conversation_ownership_transition (tenant_id, conversation_key, episode);

CREATE INDEX IF NOT EXISTS conversation_ownership_transition_created_idx
  ON conversation_ownership_transition (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS conversation_ownership_transition_correlation_idx
  ON conversation_ownership_transition (correlation_id);
`;

/** The name of the claim constraint, so tests and error handling refer to the
 *  same string the DDL declares rather than a copy of it. */
export const CLAIM_CONSTRAINT = "conversation_ownership_transition_claim_key";

/** Postgres `unique_violation`. The value that means "a concurrent writer
 *  claimed this operation id first", which is a normal outcome, not a fault. */
export const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * What a `resolvePlan` callback decides, having seen the LOCKED state.
 *
 *   `apply`     — move to `toState`, opening a new episode if asked.
 *   `duplicate` — the intent already holds; change nothing, report success.
 *   `refuse`    — refused, with the reason the caller should report.
 */
export type TransitionPlan =
  | { kind: "apply"; toState: OwnershipState; startsNewEpisode: boolean }
  /**
   * The intent already holds and nothing needs to move — but the operation id
   * IS still claimed, as a self-transition, so a later replay of this same
   * operation is recognised as one.
   *
   * `duplicate` (below) claims nothing, which means a replay arriving after the
   * conversation has moved on would find no claim and be judged fresh. For a
   * human reply that is a real hole: replay an old message after a handback and
   * it would apply a brand new takeover against AI_RESUMED.
   *
   * `touchOwnershipChangedAt` (default true, preserving every existing caller's
   * behaviour unchanged) governs whether this observation also bumps
   * `ownership_changed_at`. GitHub Codex review of PR #135, final pass: the
   * handback sweeper floors its idle clock against that column specifically so
   * that a CUSTOMER's own message cannot postpone their own handback (see
   * handback.ts's own "a customer chasing for an answer no longer pushes their
   * own handback away"). `recordHumanReply`'s `observe` is fired by a genuine
   * human reply and correctly wants the clock bumped — that IS fresh human
   * activity. `reconcileObservedAssignment`'s `observe` fires on EVERY
   * suppressed delivery for an already-human-owned conversation, including an
   * ordinary customer message that only re-confirms an assignee already on
   * record — bumping the clock there would silently re-introduce the exact bug
   * the floor exists to prevent, through a different door. Pass `false` there.
   */
  | { kind: "observe"; touchOwnershipChangedAt?: boolean }
  /** Nothing to do and nothing to claim. */
  | { kind: "duplicate" }
  | { kind: "refuse"; status: Exclude<TransitionStatus, "applied" | "duplicate"> };

export interface ApplyTransitionInput {
  conversation: ConversationRef;
  /** The claim key. Stable for the life of the operation it names. */
  operationId: string;
  operationKind: OwnershipOperationKind;
  /** Ignored — and not required — when `selfTransition` is set. */
  toState?: OwnershipState;
  reason: string;
  /**
   * States this transition may legally start from. A current state outside this
   * set is refused EVEN WHEN `canTransition` would allow it, so each caller's
   * own precondition is explicit rather than implied by the graph.
   *
   * Ignored when `selfTransition` is set: an observation that moves nothing is
   * legal from every state by construction.
   */
  allowedFrom?: readonly OwnershipState[];
  /**
   * Record an OBSERVATION rather than a move: the target is whatever the state
   * is under the lock, so `from_state` and `to_state` are equal and no
   * authority changes.
   *
   * This is how `conversation_resolved` is recorded. It exists as a flag rather
   * than a self-edge in `LEGAL_TRANSITIONS` because adding `X -> X` for all
   * five states to the graph would make "nothing happened" indistinguishable
   * from a real transition at every call site that reads the graph.
   *
   * The target is read UNDER THE LOCK and never taken from the caller: a
   * caller-supplied "current state" read before the lock could be stale, and
   * writing it back would overwrite a transition that landed in between.
   */
  selfTransition?: boolean;
  /**
   * Decide the transition FROM THE LOCKED STATE, instead of from anything the
   * caller believed before the lock was taken.
   *
   * Needed by any transition whose target depends on where the conversation
   * actually is — `recordHumanReply` is the case: a human message means "open a
   * new episode" from an AI state, "confirm the existing one" from
   * HUMAN_REQUESTED, and "nothing to do" when a human already has it. Deciding
   * that from a caller-supplied `currentState` read BEFORE the lock is a
   * time-of-check-to-time-of-use hole: a stale "HUMAN_OWNED" would skip
   * recording a real takeover while the stored row still said AI_OWNED, leaving
   * the bot licensed to speak.
   *
   * When set, `toState`, `allowedFrom` and `startsNewEpisode` are ignored.
   */
  resolvePlan?: (view: OwnershipView) => TransitionPlan;
  actorRef?: string | null;
  correlationId?: string | null;
  /** When set, the current episode must equal this exactly. */
  expectedEpisode?: number | null;
  /** True for transitions that OPEN a new span of human involvement. */
  startsNewEpisode?: boolean;
  escalationOperationId?: string | null;
  handbackOperationId?: string | null;
}

interface OwnershipRow {
  ownership_state: string | null;
  ownership_episode: number | string | null;
  handover_ack_episode: number | string | null;
  ownership_escalation_operation_id?: string | null;
}

const SELECT_COLUMNS =
  "ownership_state, ownership_episode, handover_ack_episode, ownership_escalation_operation_id";

function viewOf(row: OwnershipRow): OwnershipView {
  const state = readState(row.ownership_state);
  return {
    state,
    episode: readEpisode(row.ownership_episode),
    handoverAckEpisode:
      row.handover_ack_episode === null || row.handover_ack_episode === undefined
        ? null
        : readEpisode(row.handover_ack_episode),
    escalationOperationId: row.ownership_escalation_operation_id ?? null,
    diverged: row.ownership_state !== state,
  };
}

function refused(
  status: TransitionStatus,
  view: OwnershipView,
  operationId: string,
): TransitionOutcome {
  return {
    ok: false,
    status,
    state: view.state,
    episode: view.episode,
    operationId,
    duplicateSource: null,
  };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Create the conversation's ownership row if this is the first time we have
 * seen it, then LOCK it and return what it says.
 *
 * `ON CONFLICT DO NOTHING` is the race-safe form: two transactions arriving
 * together for a brand-new conversation cannot both insert, and the loser
 * blocks until the winner commits rather than raising. `FOR UPDATE` then takes
 * the row lock that every precondition below is evaluated under, and that lock
 * is held until the transaction ends.
 *
 * A conversation the gateway has never transitioned starts at the default
 * AI_OWNED / episode 0 — which is the truthful reading, not an assumption: it
 * is exactly the state in which the AI is permitted to answer, and it is the
 * state the current Chatwoot-derived predicate already puts every unassigned
 * pending conversation in.
 */
async function lockConversation(
  tx: SqlClient,
  ref: ConversationRef,
  key: string,
): Promise<OwnershipView> {
  await tx.query(
    `
    INSERT INTO conversation_ownership (
      tenant_id, conversation_key, chatwoot_account_id, chatwoot_conversation_id,
      chatwoot_inbox_id, binding_id, ownership_state, ownership_episode
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0)
    ON CONFLICT ON CONSTRAINT conversation_ownership_pkey DO NOTHING
    `,
    [
      ref.tenantId,
      key,
      ref.chatwootAccountId,
      ref.chatwootConversationId,
      ref.chatwootInboxId ?? null,
      ref.bindingId ?? null,
      DEFAULT_OWNERSHIP_STATE,
    ],
  );

  const locked: QueryResult<OwnershipRow> = await tx.query<OwnershipRow>(
    `
    SELECT ${SELECT_COLUMNS}
      FROM conversation_ownership
     WHERE tenant_id = $1 AND conversation_key = $2
       FOR UPDATE
    `,
    [ref.tenantId, key],
  );

  const row = locked.rows[0];
  if (row === undefined) {
    // Unreachable in practice: the INSERT above guarantees the row exists and
    // the lock is taken in the same transaction. Treated as a divergence and
    // failed closed rather than assumed away.
    return {
      state: "HUMAN_OWNED",
      episode: 0,
      handoverAckEpisode: null,
      escalationOperationId: null,
      diverged: true,
    };
  }
  return viewOf(row);
}

/**
 * Move response authority. THE only function that writes `ownership_state`.
 *
 * ORDER OF CHECKS, AND WHY
 *
 *   1. Lock the conversation row.       Everything after this is serialised
 *                                       against every other transition on the
 *                                       same conversation.
 *   2. Replay pre-check.                A retry must NOT be judged against
 *                                       preconditions its own original
 *                                       application already changed. Without
 *                                       this, a retried escalation would read
 *                                       HUMAN_REQUESTED, fail `allowedFrom`,
 *                                       and report `illegal_transition` for an
 *                                       operation that in fact SUCCEEDED.
 *   3. `expectedEpisode`, then          Under the lock, so the value tested is
 *      `allowedFrom` + `canTransition`. the value written against.
 *   4. INSERT the transition.           The claim. If a writer got past step 2
 *                                       concurrently, THE CONSTRAINT rejects it
 *                                       here — application code does not, and
 *                                       cannot, because both readers saw the
 *                                       same absence.
 *   5. UPDATE the conversation.         Same transaction. A crash between 4 and
 *                                       5 would otherwise leave a claimed
 *                                       operation whose state change never
 *                                       landed — and because the claim is
 *                                       idempotent, the retry would be
 *                                       swallowed as a duplicate and the
 *                                       conversation would sit in the old state
 *                                       forever.
 */
export async function applyOwnershipTransition(
  exec: SqlExecutor,
  input: ApplyTransitionInput,
): Promise<TransitionOutcome> {
  const {
    conversation,
    operationId,
    operationKind,
    toState,
    reason,
    allowedFrom = [],
    selfTransition = false,
    resolvePlan,
    actorRef = null,
    correlationId = null,
    expectedEpisode = null,
    startsNewEpisode = false,
    escalationOperationId = null,
    handbackOperationId = null,
  } = input;

  const key = conversationKey(
    conversation.chatwootAccountId,
    conversation.chatwootConversationId,
  );

  // Refuse free text BEFORE opening a transaction. This value is persisted to
  // the audit trail on both tables, so a prose reason would be customer content
  // written into a store that promises it holds none.
  const reasonCode = assertReasonCode(reason);

  return exec.transaction(async (tx) => {
    const view = await lockConversation(tx, conversation, key);

    // 2. Replay.
    const existing = await tx.query<{ episode: number | string }>(
      `
      SELECT episode
        FROM conversation_ownership_transition
       WHERE tenant_id = $1 AND conversation_key = $2 AND operation_id = $3
      `,
      [conversation.tenantId, key, operationId],
    );
    if (existing.rows[0] !== undefined) {
      return {
        ok: true,
        status: "duplicate" as const,
        state: view.state,
        episode: view.episode,
        operationId,
        duplicateSource: "replay" as const,
      };
    }

    // 3. Preconditions, under the lock taken in step 1.
    if (expectedEpisode !== null && expectedEpisode !== view.episode) {
      return refused("stale_episode", view, operationId);
    }

    // The target is resolved HERE, under the lock, never by the caller.
    let target: OwnershipState;
    let opensEpisode: boolean;
    // Whether this call renews `ownership_changed_at`. True everywhere except
    // an `observe` that explicitly opts out — see TransitionPlan's own doc
    // comment on why `reconcileObservedAssignment` must opt out here.
    let touchOwnershipChangedAt = true;

    if (resolvePlan !== undefined) {
      const plan = resolvePlan(view);
      if (plan.kind === "refuse") return refused(plan.status, view, operationId);
      if (plan.kind === "duplicate") {
        // The intent already holds in the state we just locked. Nothing is
        // written, and no claim is made, because there is no operation to
        // claim — reporting `duplicate` says exactly that.
        return {
          ok: true,
          status: "duplicate" as const,
          state: view.state,
          episode: view.episode,
          operationId,
          duplicateSource: "replay" as const,
        };
      }
      if (plan.kind === "observe") {
        // Claim the operation id against the CURRENT state, moving nothing.
        target = view.state;
        opensEpisode = false;
        touchOwnershipChangedAt = plan.touchOwnershipChangedAt ?? true;
      } else {
        if (!canTransition(view.state, plan.toState)) {
          return refused("illegal_transition", view, operationId);
        }
        target = plan.toState;
        opensEpisode = plan.startsNewEpisode;
      }
    } else if (selfTransition) {
      target = view.state;
      opensEpisode = false;
    } else {
      if (toState === undefined) {
        return refused("illegal_transition", view, operationId);
      }
      if (!allowedFrom.includes(view.state) || !canTransition(view.state, toState)) {
        return refused("illegal_transition", view, operationId);
      }
      target = toState;
      opensEpisode = startsNewEpisode;
    }

    const nextEpisode = opensEpisode ? view.episode + 1 : view.episode;

    // 4. The claim. A SAVEPOINT so that losing the race leaves the transaction
    //    usable: without it the unique violation aborts the whole transaction
    //    and the accurate `duplicate` answer below could not be returned.
    await tx.query("SAVEPOINT ownership_claim");
    try {
      await tx.query(
        `
        INSERT INTO conversation_ownership_transition (
          tenant_id, conversation_key, episode, from_state, to_state,
          reason, operation_id, operation_kind, actor_ref, correlation_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          conversation.tenantId,
          key,
          nextEpisode,
          view.state,
          target,
          reasonCode,
          operationId,
          operationKind,
          actorRef,
          correlationId,
        ],
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await tx.query("ROLLBACK TO SAVEPOINT ownership_claim");
      return {
        ok: true,
        status: "duplicate" as const,
        state: view.state,
        episode: view.episode,
        operationId,
        duplicateSource: "constraint" as const,
      };
    }
    await tx.query("RELEASE SAVEPOINT ownership_claim");

    // 5. The state change, in the same transaction as the claim.
    //
    // `ownership_changed_at` only advances when `touchOwnershipChangedAt` is
    // true (the default everywhere except an `observe` that opts out — see
    // TransitionPlan's own doc comment). A CASE, not a second query: the same
    // transaction, no extra round trip, and no branch where the column could
    // be left stale by an early return.
    await tx.query(
      `
      UPDATE conversation_ownership
         SET ownership_state          = $3,
             ownership_episode        = $4,
             ownership_changed_at     = CASE WHEN $10 THEN now() ELSE ownership_changed_at END,
             ownership_reason         = $5,
             ownership_actor_ref      = $6,
             ownership_correlation_id = $7,
             ownership_escalation_operation_id =
               COALESCE($8, ownership_escalation_operation_id),
             ownership_handback_operation_id =
               COALESCE($9, ownership_handback_operation_id),
             updated_at               = now()
       WHERE tenant_id = $1 AND conversation_key = $2
      `,
      [
        conversation.tenantId,
        key,
        target,
        nextEpisode,
        reasonCode,
        actorRef,
        correlationId,
        escalationOperationId,
        handbackOperationId,
        touchOwnershipChangedAt,
      ],
    );

    return {
      ok: true,
      status: "applied" as const,
      state: target,
      episode: nextEpisode,
      operationId,
      duplicateSource: null,
    };
  });
}

/**
 * Claim the right to send ONE handover acknowledgement for one episode.
 *
 * The claim is the ROW COUNT of a conditional UPDATE, not a read followed by a
 * write. Two inbound messages arriving in the same instant both run this
 * statement; the predicate can only hold for one of them, so exactly one gets
 * `rowCount === 1` and sends. A duplicate acknowledgement is worse than the
 * silence it replaces, which is why this is a claim and not a check.
 *
 * `ownership_episode = $3` in the predicate is what ties the claim to the
 * episode it was decided for: if the conversation has moved on to another
 * episode since the caller read it, no row matches and nothing is sent.
 *
 * Returns true if THIS caller may send. The caller must post the message only
 * on true, and must accept that a crash after the claim and before the post
 * loses that one acknowledgement — deliberately, because the alternative is
 * sending two.
 */
export async function claimHandoverAck(
  exec: SqlExecutor,
  ref: ConversationRef,
  episode: number,
  claimantRef: string,
): Promise<boolean> {
  const key = conversationKey(ref.chatwootAccountId, ref.chatwootConversationId);
  const claim = await exec.query(
    `
    UPDATE conversation_ownership
       SET handover_ack_episode = $3,
           handover_ack_ref     = $4,
           updated_at           = now()
     WHERE tenant_id         = $1
       AND conversation_key  = $2
       AND ownership_episode = $3
       AND (handover_ack_episode IS NULL
            OR handover_ack_episode < $3
            OR handover_ack_ref = $4)
    `,
    [ref.tenantId, key, episode, claimantRef],
  );
  return claim.rowCount === 1;
}

/**
 * Read ownership without taking a lock or creating a row.
 *
 * Returns the default AI_OWNED view for a conversation that has no row yet:
 * that is not an absence of information, it is the state a conversation the
 * gateway has never had to hold is in.
 */
export async function readConversationOwnership(
  exec: SqlClient,
  ref: ConversationRef,
): Promise<OwnershipView> {
  const key = conversationKey(ref.chatwootAccountId, ref.chatwootConversationId);
  const result = await exec.query<OwnershipRow>(
    `
    SELECT ${SELECT_COLUMNS}
      FROM conversation_ownership
     WHERE tenant_id = $1 AND conversation_key = $2
    `,
    [ref.tenantId, key],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return {
      state: DEFAULT_OWNERSHIP_STATE,
      episode: 0,
      handoverAckEpisode: null,
      escalationOperationId: null,
      diverged: false,
    };
  }
  return viewOf(row);
}

/** Idempotent DDL. Safe to run on every boot, alongside `Ledger.migrate()`. */
export async function migrateOwnershipStore(exec: SqlClient): Promise<void> {
  await exec.query(OWNERSHIP_SCHEMA_SQL);
}

/**
 * The Postgres implementation of the port the reply path depends on.
 *
 * Deliberately thin: it binds an executor to the free functions above and adds
 * nothing. All the behaviour is in the SQL, where it can be enforced rather
 * than intended.
 *
 * NOTHING HERE CATCHES. A store that cannot be reached must propagate, so the
 * caller fails closed. Returning AI_OWNED on an unreachable database would let
 * the bot answer a conversation a human is holding — the precise defect this
 * whole module exists to make impossible — and it would do it silently,
 * because a swallowed error looks exactly like a healthy AI_OWNED read.
 */
export function createPostgresOwnershipGate(exec: SqlExecutor): OwnershipGate {
  return {
    read: (ref) => readConversationOwnership(exec, ref),
    requestHuman: (input) => requestHumanOwnership(exec, input),
    claimAck: (ref, episode, claimantRef) => claimHandoverAck(exec, ref, episode, claimantRef),
    reconcileObservedAssignment: (input) => reconcileObservedAssignment(exec, input),
  };
}

// ---------------------------------------------------------------------------
// The named transitions — the contract call sites use
// ---------------------------------------------------------------------------

/**
 * Accepted escalation -> HUMAN_REQUESTED, opening a new episode.
 *
 * Automated replies are suppressed from the moment this returns `applied` (or
 * `duplicate` — the suppression is already in force), BEFORE the caller
 * performs the Chatwoot assignment. Suppress first, publish second: the reverse
 * order leaves a window in which the bot can answer a conversation that has
 * already been handed to a person.
 */
export function requestHumanOwnership(
  exec: SqlExecutor,
  input: {
    conversation: ConversationRef;
    operationId: string;
    reason: string;
    actorRef?: string | null;
    correlationId?: string | null;
  },
): Promise<TransitionOutcome> {
  return applyOwnershipTransition(exec, {
    ...input,
    operationKind: "escalate",
    toState: "HUMAN_REQUESTED",
    allowedFrom: ["AI_OWNED", "AI_RESUMED"],
    startsNewEpisode: true,
    escalationOperationId: input.operationId,
  });
}

/** Assignment and context publication completed -> HUMAN_OWNED. Replies stay
 *  suppressed; the difference is that a person can now actually see it. */
export function confirmHumanOwnership(
  exec: SqlExecutor,
  input: {
    conversation: ConversationRef;
    operationId: string;
    episode: number;
    reason: string;
    actorRef?: string | null;
    correlationId?: string | null;
  },
): Promise<TransitionOutcome> {
  return applyOwnershipTransition(exec, {
    ...input,
    operationKind: "human_assigned",
    toState: "HUMAN_OWNED",
    allowedFrom: ["HUMAN_REQUESTED"],
    expectedEpisode: input.episode,
  });
}

/**
 * A human agent replied in the Chatwoot dashboard -> HUMAN_OWNED.
 *
 * From an AI state this opens a new episode (a takeover with no prior
 * escalation). From HUMAN_REQUESTED it confirms the existing one. Already
 * HUMAN_OWNED or mid-handback, there is nothing to transition and the bot is
 * already silent — `duplicate` says exactly that, rather than reporting an
 * illegal transition for an event whose intent already holds.
 */
export async function recordHumanReply(
  exec: SqlExecutor,
  input: {
    conversation: ConversationRef;
    /** Chatwoot's own message id — one physical human reply, one transition. */
    operationId: string;
    reason?: string;
    actorRef?: string | null;
  },
): Promise<TransitionOutcome> {
  return applyOwnershipTransition(exec, {
    conversation: input.conversation,
    operationId: input.operationId,
    operationKind: "human_reply",
    reason: input.reason ?? "human_agent_replied_in_chatwoot",
    actorRef: input.actorRef ?? null,
    // Decided from the LOCKED state. This deliberately takes no `currentState`
    // argument: a caller's pre-lock reading of "a human already has it" could
    // be stale, and acting on it would skip recording a real takeover and leave
    // the bot licensed to speak into a conversation a person had just entered.
    resolvePlan: (view) => {
      if (view.state === "HUMAN_OWNED" || view.state === "HANDING_BACK") {
        // Nothing to transition and the bot is already silent. Mid-handback a
        // human message is part of the reconciliation, not a new takeover.
        //
        // `observe`, not `duplicate`: the operation id must still be CLAIMED.
        // Chatwoot message ids are the operation id here, and a replay of this
        // same message arriving after a handback would otherwise find no claim,
        // see AI_RESUMED, and apply a brand new human takeover for a message
        // the human sent in a previous episode.
        return { kind: "observe" };
      }
      const fromAi = view.state === "AI_OWNED" || view.state === "AI_RESUMED";
      return { kind: "apply", toState: "HUMAN_OWNED", startsNewEpisode: fromAi };
    },
  });
}

/** Explicit, authorized handback begins -> HANDING_BACK. Nobody speaks. */
export function beginHandback(
  exec: SqlExecutor,
  input: {
    conversation: ConversationRef;
    operationId: string;
    episode: number;
    actorRef: string;
    reason?: string;
    correlationId?: string | null;
  },
): Promise<TransitionOutcome> {
  return applyOwnershipTransition(exec, {
    conversation: input.conversation,
    operationId: input.operationId,
    operationKind: "handback_begin",
    toState: "HANDING_BACK",
    reason: input.reason ?? "explicit_authorized_handback_requested",
    allowedFrom: ["HUMAN_OWNED", "HUMAN_REQUESTED"],
    expectedEpisode: input.episode,
    actorRef: input.actorRef,
    correlationId: input.correlationId ?? null,
    handbackOperationId: input.operationId,
  });
}

/** Reconciliation succeeded -> AI_RESUMED. The ONLY edge back to AI authority. */
export function completeHandback(
  exec: SqlExecutor,
  input: {
    conversation: ConversationRef;
    operationId: string;
    episode: number;
    actorRef: string;
    correlationId?: string | null;
  },
): Promise<TransitionOutcome> {
  return applyOwnershipTransition(exec, {
    conversation: input.conversation,
    // Suffixed so completing and beginning the same handback are two distinct
    // claims. Without it the completion would collide with its own begin and be
    // swallowed as a duplicate.
    operationId: `${input.operationId}:complete`,
    operationKind: "handback_complete",
    toState: "AI_RESUMED",
    reason: "handback_reconciled",
    allowedFrom: ["HANDING_BACK"],
    expectedEpisode: input.episode,
    actorRef: input.actorRef,
    correlationId: input.correlationId ?? null,
    handbackOperationId: input.operationId,
  });
}

/**
 * Reconciliation failed -> back to HUMAN_OWNED. The AI does not resume.
 *
 * `allowedFrom` INCLUDES THE POST-RECONCILIATION STATES, and that is the whole
 * point of this function. Found by review 2026-08-17, and it was wrong in the
 * most dangerous way — the caller's comment claimed the abort recovered the
 * conversation, and it could not.
 *
 * `performHandback` runs begin -> complete -> settle BEFORE it asks Chatwoot to
 * mark the conversation pending. So when that Chatwoot call fails, the store is
 * already at AI_RESUMED (or AI_OWNED after settle) — never HANDING_BACK. With
 * `allowedFrom: ["HANDING_BACK"]` the abort was REFUSED every time it was
 * needed, leaving: Chatwoot still `open`, the store saying the AI owns it, and
 * AI_OWNED absent from HANDBACK_ELIGIBLE_STATES so the sweeper would never look
 * at it again. Every later customer message suppresses as `status_not_pending`.
 * Permanently. That is the same strand that silenced a live conversation for
 * nine hours this morning, reappearing on the failure edge of its own fix.
 *
 * Both AI_RESUMED -> HUMAN_OWNED and AI_OWNED -> HUMAN_OWNED are already legal
 * in ALLOWED_TRANSITIONS, so this widens no authority; it lets the recovery path
 * actually run.
 */
export function abortHandback(
  exec: SqlExecutor,
  input: {
    conversation: ConversationRef;
    operationId: string;
    episode: number;
    actorRef: string;
    reason: string;
    correlationId?: string | null;
  },
): Promise<TransitionOutcome> {
  return applyOwnershipTransition(exec, {
    conversation: input.conversation,
    operationId: `${input.operationId}:failed`,
    operationKind: "handback_failed",
    toState: "HUMAN_OWNED",
    reason: input.reason,
    allowedFrom: ["HANDING_BACK", "AI_RESUMED", "AI_OWNED"],
    expectedEpisode: input.episode,
    actorRef: input.actorRef,
    correlationId: input.correlationId ?? null,
  });
}

/**
 * The resumed turn has been consumed -> AI_RESUMED settles to AI_OWNED.
 *
 * Both states permit an invocation, so this changes no authority; it makes "the
 * next customer message invoked the runtime once after handback" an observable
 * fact rather than an assumption.
 */
export function settleResumed(
  exec: SqlExecutor,
  input: {
    conversation: ConversationRef;
    operationId: string;
    episode: number;
  },
): Promise<TransitionOutcome> {
  return applyOwnershipTransition(exec, {
    conversation: input.conversation,
    operationId: input.operationId,
    operationKind: "resumed_settled",
    toState: "AI_OWNED",
    reason: "resumed_turn_consumed",
    allowedFrom: ["AI_RESUMED"],
    expectedEpisode: input.episode,
  });
}

/**
 * `conversation_resolved` — recorded, NOT a grant of authority.
 *
 * This is the behaviour the Chatwoot-derived predicate gets wrong today. An
 * agent resolving a ticket for housekeeping, or an automation rule doing it,
 * currently returns the conversation to a state the AI will answer in, with no
 * reconciliation, no human outcome in context and no record. Here it writes a
 * ledger row and moves ownership NOWHERE. Only an explicit authorized handback
 * returns authority to the AI.
 *
 * Implemented as a self-transition so the audit trail carries the observation
 * without the state graph having to admit an edge for it.
 */
export function recordResolution(
  exec: SqlExecutor,
  input: {
    conversation: ConversationRef;
    /** Stable per (conversation, episode) so webhook retries collapse. */
    operationId: string;
    reason?: string;
  },
): Promise<TransitionOutcome> {
  return applyOwnershipTransition(exec, {
    conversation: input.conversation,
    operationId: input.operationId,
    operationKind: "resolution_observed",
    reason: input.reason ?? "chatwoot_resolution_observed_ownership_unchanged",
    // No target and no `allowedFrom`: the state under the lock is both the
    // from- and the to-state, so this is legal from anywhere and moves nothing.
    selfTransition: true,
    actorRef: "chatwoot:conversation_resolved",
  });
}

/**
 * RECONCILIATION for a human assignee observed OUTSIDE this gateway's own
 * escalation flow. See the doc comment on `OwnershipGate.reconcileObservedAssignment`
 * for the full rationale; this is that port's Postgres implementation.
 *
 * def-handback-sweeper-is-blind-to-manually-assigned-conversations-2026-09-13.
 *
 * TWO GUARDS, BOTH BEFORE ANY LOCK IS TAKEN — cheap and deliberate:
 *   - no assignee present: nothing to reconcile, and this is also the
 *     "assignee just cleared" direction, which this function does NOT act on.
 *     The existing sweeper's own MANUAL trigger (handback.ts, `readConversationStatus
 *     (record) === "pending"`) already completes that side once a row exists in
 *     an eligible state — recording the un-assign here too would be a second,
 *     unneeded path to the same outcome, and this function stays a pure
 *     "notice a hold" primitive.
 *   - status is 'resolved': resolve is a terminal state an operator chose
 *     deliberately. recordResolution already exists to OBSERVE a resolution
 *     without granting authority; this function must not treat a resolved-
 *     and-still-assigned conversation as newly human-held, which would make
 *     the sweeper's idle clock eligible to act on a thread nobody expects it
 *     to touch. (Chatwoot's own `resolved` clears `waiting_since`, but does
 *     NOT clear the assignee — the two are independent, confirmed from
 *     `Conversation#handle_resolved_status_change`.)
 *
 * THE STATE-DEPENDENT PLAN, decided under the lock like every other transition
 * here, never from a value read before it:
 *   - AI_OWNED / AI_RESUMED: exactly the blind spot this function exists to
 *     close. Opens a NEW episode — this is a takeover with no prior
 *     escalation, the same shape `recordHumanReply`'s own "fromAi" branch
 *     already treats a human's first dashboard reply as.
 *   - HUMAN_REQUESTED: an escalation is already in flight and
 *     `confirmHumanOwnership` (allowedFrom: ["HUMAN_REQUESTED"]) is the
 *     function that legitimately completes it. Observing here instead of
 *     applying avoids two writers racing the SAME transition under two
 *     different operation ids — had this applied HUMAN_OWNED first, the
 *     escalation flow's own later confirmHumanOwnership call would find
 *     HUMAN_OWNED already there and be refused `illegal_transition` for an
 *     operation that should have succeeded.
 *   - HUMAN_OWNED / HANDING_BACK: already tracked, or mid-reconciliation.
 *     Nothing to add; observing only claims the operation id so a later
 *     redelivery of the SAME event is recognised as one.
 */
export function reconcileObservedAssignment(
  exec: SqlExecutor,
  input: {
    conversation: ConversationRef;
    operationId: string;
    hasAssignee: boolean;
    status: string | null;
  },
): Promise<TransitionOutcome | null> {
  if (!input.hasAssignee) return Promise.resolve(null);
  if (input.status === "resolved") return Promise.resolve(null);

  return applyOwnershipTransition(exec, {
    conversation: input.conversation,
    operationId: input.operationId,
    operationKind: "assignee_observed",
    reason: "assignee_observed_without_escalation",
    actorRef: "chatwoot:conversation_updated_assignee_observed",
    resolvePlan: (view) => {
      if (view.state === "AI_OWNED" || view.state === "AI_RESUMED") {
        return { kind: "apply", toState: "HUMAN_OWNED", startsNewEpisode: true };
      }
      // touchOwnershipChangedAt: false — GitHub Codex review of PR #135, final
      // pass. This branch runs on EVERY suppressed delivery for an
      // already-human-owned conversation, including an ordinary customer
      // message that merely re-confirms an assignee already on record. The
      // handback sweeper floors its idle clock against `ownership_changed_at`
      // specifically so a customer's own message cannot postpone their own
      // handback (handback.ts: "a customer chasing for an answer no longer
      // pushes their own handback away"). Bumping it here on every re-observed,
      // unchanged fact would defeat that floor through a different door.
      return { kind: "observe", touchOwnershipChangedAt: false };
    },
  });
}
