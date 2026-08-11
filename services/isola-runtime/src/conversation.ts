/**
 * Conversation-scoped persistence.
 *
 * THE DEFECT THIS FIXES
 * ---------------------
 * The runtime persists a run's output with `PAPERCLIP_RECORD_PATH`, which is
 * `/api/issues/{issueId}/comments`. That is right for INTERNAL work, which is
 * issue-driven. A Chatwoot customer conversation has no Paperclip issue, so the
 * PUBLIC path could never persist, could never reach `completed`, and therefore
 * never returned `answerText` — the model answered, tokens were spent, and the
 * gateway escalated to a human instead of replying. Observed live as
 * `recorder_failed` -> `persistence_failed`, 502, `issueId: null`.
 *
 * THE FIX, AND WHY IT IS HERE AND NOT IN THE GATEWAY
 * --------------------------------------------------
 * When a run carries a conversation reference but no issue id, this module
 * creates-or-gets a Paperclip issue that represents that conversation, and the
 * existing write-back path is then used unchanged. Paperclip is the AI Company
 * OS and is meant to hold the employee's work, so a customer conversation
 * becoming a tracked issue is the natural mapping and gives operators a real
 * trace. The gateway is the only publicly-exposed component and is deliberately
 * NOT given Paperclip write access.
 *
 * WHAT IS NOT WEAKENED
 * --------------------
 * `completed` still means Paperclip accepted the output. If the issue cannot be
 * resolved, the run is `persistence_failed` with `answerText: null` — never a
 * silent success.
 *
 * WHAT MUST NOT HAPPEN
 * --------------------
 *  - These issues must never become actionable work. Paperclip re-schedules an
 *    employee that has an actionable assigned issue (`todo`/`in_progress` with an
 *    assignee) — that is the defect that produced 53 runs from one wakeup. So
 *    they are created in `backlog`, with no assignee of any kind, and the
 *    success/failure status transitions are NOT applied to them.
 *  - Two messages arriving close together in one conversation must not create
 *    two issues. Create-or-get is serialised per conversation key and re-checks
 *    the durable store after acquiring.
 *  - No customer content ever reaches the issue title or description.
 */
import { PaperclipApiError } from "./errors.js";
import type { Logger } from "./log.js";
import type {
  CreateIssueInput,
  IssuePriority,
  IssueStatus,
  PaperclipApi,
  PaperclipCall,
} from "./paperclip.js";
import type { StateStore } from "./state.js";

// ---------------------------------------------------------------------------
// Reading the run context
// ---------------------------------------------------------------------------

/**
 * Coerce a context value to a non-empty trimmed string. Numbers are accepted
 * because a Chatwoot conversation id arrives as a JSON number about as often as
 * it arrives as a string. Nothing else is.
 */
export function asContextString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Read one explicit dotted path out of the run context. No wildcards, ever. */
export function readContextPath(
  context: unknown,
  path: readonly string[],
): string | null {
  let cursor: unknown = context;
  for (const key of path.slice(0, -1)) {
    if (typeof cursor !== "object" || cursor === null) return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  if (typeof cursor !== "object" || cursor === null) return null;
  const last = path[path.length - 1];
  if (last === undefined) return null;
  return asContextString((cursor as Record<string, unknown>)[last]);
}

/**
 * Where a conversation reference may appear. Explicit and closed, for the same
 * reason `ISSUE_ID_PATHS` is: commenting on the wrong conversation's issue is
 * worse than commenting on none, so there is no "any key that looks like a
 * conversation" rule. A run with no match is left exactly as it is today.
 */
/**
 * Accepted locations for the conversation reference.
 *
 * `chatwoot.conversationDisplayId` is the one isola-gateway actually sends, and
 * its name is the accurate one: Chatwoot's conversation API is addressed by
 * `display_id`, not by the row's primary key. It is listed first so the precise
 * field wins when a caller supplies several.
 *
 * A live end-to-end run failed on exactly this — the runtime accepted
 * `chatwoot.conversationId`, the gateway sent `chatwoot.conversationDisplayId`,
 * nothing resolved, and every PUBLIC run died as `persistence_failed`. Widening
 * the accepted set is the fix; renaming the gateway's field would have made it
 * less accurate.
 */
const CONVERSATION_ID_PATHS: readonly (readonly string[])[] = [
  ["chatwoot", "conversationDisplayId"],
  ["conversationDisplayId"],
  ["conversationRef"],
  ["conversationId"],
  ["chatwootConversationId"],
  ["conversation", "id"],
  ["conversation", "display_id"],
  ["chatwoot", "conversationId"],
];

const ACCOUNT_ID_PATHS: readonly (readonly string[])[] = [
  ["chatwootAccountId"],
  ["account", "id"],
  ["chatwoot", "accountId"],
];

const TENANT_ID_PATHS: readonly (readonly string[])[] = [
  ["tenantId"],
  ["tenant_id"],
  ["tenant", "id"],
];

function firstOf(
  context: unknown,
  paths: readonly (readonly string[])[],
): string | null {
  for (const path of paths) {
    const value = readContextPath(context, path);
    if (value !== null) return value;
  }
  return null;
}

/** The channel prefix. Only Chatwoot conversations exist today. */
export const CONVERSATION_CHANNEL = "chatwoot";

/** Used in the key when the caller supplied no account id. Never invented. */
export const NO_ACCOUNT = "none";

export interface ConversationRef {
  /** The conversation id as the caller supplied it. */
  conversationId: string;
  /** The account id, or null when the caller supplied none. */
  accountId: string | null;
  /** `chatwoot:<accountId|none>:<conversationId>` — the stable external key. */
  key: string;
}

/** A reference already in `chatwoot:<account>:<id>` form, supplied verbatim. */
const PREFORMED_KEY = new RegExp(`^${CONVERSATION_CHANNEL}:([^:]*):(.+)$`, "i");

export function conversationKey(
  accountId: string | null,
  conversationId: string,
): string {
  return `${CONVERSATION_CHANNEL}:${accountId ?? NO_ACCOUNT}:${conversationId}`;
}

/**
 * Resolve the conversation reference from the run context.
 *
 * Returns null when nothing explicit is present — the caller then behaves
 * exactly as it does today (`no_issue_context`, nothing transitioned, nothing
 * created). A reference is never guessed.
 */
export function extractConversationRef(context: unknown): ConversationRef | null {
  if (typeof context !== "object" || context === null) return null;
  const raw = firstOf(context, CONVERSATION_ID_PATHS);
  if (raw === null) return null;

  // A caller that already holds the full external reference passes it straight
  // through, rather than having it nested inside a second copy of itself.
  const preformed = PREFORMED_KEY.exec(raw);
  if (preformed !== null) {
    const account = (preformed[1] ?? "").trim();
    const conversationId = (preformed[2] ?? "").trim();
    if (conversationId.length === 0) return null;
    const accountId =
      account.length === 0 || account.toLowerCase() === NO_ACCOUNT ? null : account;
    return { conversationId, accountId, key: conversationKey(accountId, conversationId) };
  }

  const accountId = firstOf(context, ACCOUNT_ID_PATHS);
  return { conversationId: raw, accountId, key: conversationKey(accountId, raw) };
}

/** The tenant, when the caller named one. Used in the description, never guessed. */
export function extractTenantId(context: unknown): string | null {
  if (typeof context !== "object" || context === null) return null;
  return firstOf(context, TENANT_ID_PATHS);
}

// ---------------------------------------------------------------------------
// What the issue looks like
// ---------------------------------------------------------------------------

/**
 * `createIssueSchema` has no free-form `metadata` field — verified against the
 * vendored source, `packages/shared/src/validators/issue.ts`. The title is
 * therefore the only place on create that can carry the external key, so it is
 * appended in a bracketed marker that is easy to search for and unambiguous to
 * match on.
 */
export const CONVERSATION_KEY_MARKER = "isola-conv";

export function conversationKeyMarker(key: string): string {
  return `[${CONVERSATION_KEY_MARKER}:${key}]`;
}

/**
 * The issue title.
 *
 * Recognisable to a human, and machine-matchable through the trailing marker.
 * It carries the conversation reference and NOTHING from the customer: no
 * message body, no subject line, no contact name.
 */
export function conversationIssueTitle(ref: ConversationRef): string {
  return `Chatwoot conversation #${ref.conversationId} (account ${ref.accountId ?? "unknown"}) ${conversationKeyMarker(ref.key)}`;
}

/**
 * The issue description.
 *
 * States the tenant (when the caller named one), the conversation reference, and
 * that this is an AI-handled customer conversation. Nothing else — in particular
 * no customer message content, which lives only in the comments the runtime
 * writes back, exactly as it does for an issue-driven run.
 */
export function conversationIssueDescription(args: {
  ref: ConversationRef;
  tenantId: string | null;
}): string {
  const lines = [
    "This issue represents an AI-handled customer conversation. It was opened by the Isola runtime so the employee's replies have somewhere to be recorded.",
    "",
    "- Channel: Chatwoot",
    `- Conversation reference: \`${args.ref.key}\``,
  ];
  if (args.tenantId !== null) lines.push(`- Tenant: \`${args.tenantId}\``);
  lines.push(
    "",
    "Each reply the employee sends is added to this issue as a comment. No customer message content is stored in this title or description.",
    "",
    `This issue is deliberately left in \`${CONVERSATION_ISSUE_STATUS}\` with no assignee. It is a record of work, not a work item: an actionable assigned issue would make the scheduler wake the employee again, and this runtime never transitions it.`,
  );
  return lines.join("\n");
}

/**
 * `backlog`, and no assignee — the combination Paperclip's scheduler does not
 * pick up (it looks for `todo`/`in_progress`, see server/src/services/heartbeat.ts).
 */
export const CONVERSATION_ISSUE_STATUS: IssueStatus = "backlog";

/** Lowest priority: this is a trace, not a queue item competing for attention. */
export const CONVERSATION_ISSUE_PRIORITY: IssuePriority = "low";

export function buildConversationIssue(args: {
  ref: ConversationRef;
  tenantId: string | null;
}): CreateIssueInput {
  return {
    title: conversationIssueTitle(args.ref),
    description: conversationIssueDescription(args),
    status: CONVERSATION_ISSUE_STATUS,
    priority: CONVERSATION_ISSUE_PRIORITY,
  };
}

/** True when this title carries exactly this conversation's key marker. */
export function titleMatchesKey(title: string, key: string): boolean {
  return title.includes(conversationKeyMarker(key));
}

// ---------------------------------------------------------------------------
// Create-or-get
// ---------------------------------------------------------------------------

/** How many issues to pull back when searching for an existing conversation issue. */
export const CONVERSATION_LOOKUP_LIMIT = 50;

export type ConversationIssueResolution =
  /** An issue for this conversation is in hand. */
  | { kind: "resolved"; issueId: string; created: boolean; cached: boolean }
  /**
   * Nothing was attempted and nothing failed: the feature is off, or Paperclip
   * is not configured, or no company owns the issue. The caller behaves exactly
   * as it did before this module existed.
   */
  | { kind: "not_attempted"; detail: string }
  /**
   * Paperclip refused. The caller must report `persistence_failed` — the answer
   * has nowhere to live, and handing it out anyway would mean replying to a
   * customer with text no record anywhere contains.
   */
  | { kind: "failed"; detail: string };

export interface ConversationIssuesDeps {
  api: PaperclipApi | null;
  store: StateStore;
  logger: Logger;
  now: () => number;
  /** RUNTIME_CONVERSATION_ISSUES. Off restores the previous behaviour exactly. */
  enabled: boolean;
}

export interface ResolveArgs {
  ref: ConversationRef;
  companyId: string | null;
  call: PaperclipCall | null;
  tenantId: string | null;
  correlationId: string;
  runId: string | null;
  agentId: string | null;
}

/**
 * Create-or-get, serialised per conversation key.
 *
 * The lock is a per-key promise chain rather than a durable lease because the
 * state store is a single-process store (whole-file atomic rewrite — it is not
 * safe across processes to begin with), so in-process serialisation is the
 * honest boundary. Inside the critical section the durable store is re-read, so
 * the loser of a race takes the winner's issue instead of creating a second one.
 */
export class ConversationIssues {
  private readonly d: ConversationIssuesDeps;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(deps: ConversationIssuesDeps) {
    this.d = deps;
  }

  async resolve(args: ResolveArgs): Promise<ConversationIssueResolution> {
    if (!this.d.enabled) {
      return { kind: "not_attempted", detail: "RUNTIME_CONVERSATION_ISSUES is off" };
    }
    if (this.d.api === null || args.call === null) {
      return {
        kind: "not_attempted",
        detail: "no Paperclip API or employee agent key is configured",
      };
    }
    const companyId = args.companyId;
    if (companyId === null || companyId.length === 0) {
      this.d.logger.warn({
        event: "conversation_issue",
        outcome: "conversation_issue_no_company",
        correlationId: args.correlationId,
        runId: args.runId,
        agentId: args.agentId,
        conversationKey: args.ref.key,
        detail:
          "no company id could be resolved for this run, so no conversation issue could be addressed; nothing was created",
      });
      return { kind: "not_attempted", detail: "no company context" };
    }

    // Fast path: the conversation already has an issue. No lock, no round trip.
    const cached = await this.cachedIssueId(args.ref.key, companyId);
    if (cached !== null) {
      return { kind: "resolved", issueId: cached, created: false, cached: true };
    }

    return this.withKeyLock(args.ref.key, async () => {
      // Re-check after acquiring: a concurrent run for the same conversation may
      // have created the issue while this one was queued.
      const settled = await this.cachedIssueId(args.ref.key, companyId);
      if (settled !== null) {
        return { kind: "resolved", issueId: settled, created: false, cached: true };
      }
      return this.createOrGet({ ...args, companyId });
    });
  }

  /** The durable cache read. Scoped by company: a foreign issue is never reused. */
  private async cachedIssueId(key: string, companyId: string): Promise<string | null> {
    const state = await this.d.store.read();
    const record = state.conversationIssues[key];
    if (record === undefined) return null;
    if (record.companyId !== companyId) return null;
    return record.issueId;
  }

  private async remember(args: {
    key: string;
    companyId: string;
    issueId: string;
    created: boolean;
  }): Promise<void> {
    await this.d.store.transact((draft) => {
      // Keyed insert. A record already present wins, so a late writer can never
      // repoint a conversation at a second issue.
      if (draft.conversationIssues[args.key] !== undefined) return;
      draft.conversationIssues[args.key] = {
        key: args.key,
        companyId: args.companyId,
        issueId: args.issueId,
        created: args.created,
        createdAtMs: this.d.now(),
      };
    });
  }

  private async createOrGet(
    args: ResolveArgs & { companyId: string },
  ): Promise<ConversationIssueResolution> {
    const api = this.d.api;
    const call = args.call;
    if (api === null || call === null) {
      return { kind: "not_attempted", detail: "no Paperclip API configured" };
    }

    const marker = conversationKeyMarker(args.ref.key);

    // 1. Look before creating. A lookup that FAILS is not treated as "absent":
    //    creating on an unproven absence is how a conversation ends up with two
    //    issues, which is precisely what this must not do.
    let existingId: string | null = null;
    try {
      const found = await api.listIssues(
        args.companyId,
        { q: marker, limit: CONVERSATION_LOOKUP_LIMIT },
        call,
      );
      const match = found.find((issue) => titleMatchesKey(issue.title, args.ref.key));
      existingId = match?.id ?? null;
    } catch (err) {
      const detail =
        err instanceof PaperclipApiError ? err.detail : "conversation issue lookup failed";
      this.d.logger.error({
        event: "conversation_issue",
        outcome: "conversation_issue_lookup_failed",
        correlationId: args.correlationId,
        runId: args.runId,
        agentId: args.agentId,
        conversationKey: args.ref.key,
        failureCategory: detail,
        detail:
          "Paperclip could not be searched for this conversation's issue; no issue was created, because creating on an unproven absence would duplicate it",
      });
      return { kind: "failed", detail: `conversation issue lookup failed: ${detail}` };
    }

    if (existingId !== null) {
      await this.remember({
        key: args.ref.key,
        companyId: args.companyId,
        issueId: existingId,
        created: false,
      });
      this.d.logger.info({
        event: "conversation_issue",
        outcome: "conversation_issue_adopted",
        correlationId: args.correlationId,
        runId: args.runId,
        agentId: args.agentId,
        conversationKey: args.ref.key,
        issueId: existingId,
        detail: "an existing Paperclip issue already represented this conversation",
      });
      return { kind: "resolved", issueId: existingId, created: false, cached: false };
    }

    // 2. Create it. Backlog, no assignee, low priority: not schedulable work.
    try {
      const issue = await api.createIssue(
        args.companyId,
        buildConversationIssue({ ref: args.ref, tenantId: args.tenantId }),
        call,
      );
      await this.remember({
        key: args.ref.key,
        companyId: args.companyId,
        issueId: issue.id,
        created: true,
      });
      this.d.logger.info({
        event: "conversation_issue",
        outcome: "conversation_issue_created",
        correlationId: args.correlationId,
        runId: args.runId,
        agentId: args.agentId,
        conversationKey: args.ref.key,
        issueId: issue.id,
        issueStatus: CONVERSATION_ISSUE_STATUS,
        detail:
          "created a Paperclip issue to hold this customer conversation; it is unassigned and in backlog so the scheduler will not pick it up",
      });
      return { kind: "resolved", issueId: issue.id, created: true, cached: false };
    } catch (err) {
      const detail =
        err instanceof PaperclipApiError ? err.detail : "conversation issue create failed";
      this.d.logger.error({
        event: "conversation_issue",
        outcome: "conversation_issue_create_failed",
        correlationId: args.correlationId,
        runId: args.runId,
        agentId: args.agentId,
        conversationKey: args.ref.key,
        failureCategory: detail,
        detail:
          "Paperclip would not create an issue for this conversation, so the answer has nowhere to be persisted",
      });
      return { kind: "failed", detail: `conversation issue create failed: ${detail}` };
    }
  }

  /**
   * Serialise per key. The chain runs the next task whether the previous one
   * resolved or rejected, so one failure never wedges a conversation.
   */
  private withKeyLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    const run = prior.then(task, task);
    const settled: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, settled);
    void settled.then(() => {
      // Only the last waiter clears the slot, so a queue behind it is not lost.
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return run;
  }
}
