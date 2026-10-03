/**
 * Test harness. Every test builds its own gateway from an explicit env record,
 * so no test depends on the ambient process environment, and no test ever opens
 * a socket to Chatwoot or to isola-runtime.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createGateway, type Gateway, type GatewayDeps } from "../src/app.js";
import type { Binding } from "../src/bindings.js";
import type { ChatwootApi, ChatwootTarget, ReconcileResult } from "../src/chatwoot.js";
import { DELIVERY_ACTION, type LedgerIdentity } from "../src/deliveryref.js";
import type { SafeFetch } from "../src/egress.js";
import { ChatwootApiError } from "../src/errors.js";
import {
  LedgerUnavailableError,
  type ClaimResult,
  type DeliveryState,
  type Ledger,
  type RecoverableDelivery,
  type ReserveArgs,
  type ReserveResult,
} from "../src/ledger.js";
import { loadConfig, type EnvRecord, type GatewayConfig } from "../src/config.js";
import { createLogger, type Logger } from "../src/log.js";
import type {
  AgentRuntime,
  AgentRuntimeRequest,
  AgentRuntimeResult,
  RuntimeCompletionState,
} from "../src/runtime.js";
import { computeSignature } from "../src/signature.js";
import {
  canTransition,
  conversationKey,
  DEFAULT_OWNERSHIP_STATE,
  type ConversationRef,
  type OwnershipGate,
  type OwnershipState,
  type OwnershipView,
  type TransitionOutcome,
} from "../src/ownership.js";

/**
 * An in-memory ownership gate for the unit suite.
 *
 * A REAL implementation of the rules, not a stub that says yes. It reuses the
 * same pure functions the Postgres store uses, so a test that passes here is
 * testing the same transition graph. What it deliberately does NOT reproduce is
 * concurrency: there is no lock and no unique index, because a Map cannot have
 * either. That is exactly why `test/ownership-store.pg.test.ts` exists and why
 * it refuses to pass without a real database — the guarantees this double
 * cannot make are proven there, against Postgres, or they are not proven.
 *
 * Default state is AI_OWNED, matching the store: a conversation with no history
 * is one the AI may answer.
 */
export class InMemoryOwnershipGate implements OwnershipGate {
  private readonly rows = new Map<
    string,
    {
      state: OwnershipState;
      episode: number;
      ack: number | null;
      ackRef: string | null;
      escalationOperationId: string | null;
    }
  >();
  private readonly claimed = new Set<string>();

  /** Test hook: put a conversation into a state without going through a transition. */
  seed(
    ref: ConversationRef,
    state: OwnershipState,
    episode = 1,
    seedOperationId?: string,
  ): void {
    this.rows.set(this.key(ref), {
      state,
      episode,
      ack: null,
      ackRef: null,
      escalationOperationId: seedOperationId ?? null,
    });
  }

  private key(ref: ConversationRef): string {
    return `${ref.tenantId}|${conversationKey(ref.chatwootAccountId, ref.chatwootConversationId)}`;
  }

  async read(ref: ConversationRef): Promise<OwnershipView> {
    const row = this.rows.get(this.key(ref));
    if (row === undefined) {
      return {
        state: DEFAULT_OWNERSHIP_STATE,
        episode: 0,
        handoverAckEpisode: null,
        escalationOperationId: null,
        diverged: false,
      };
    }
    return {
      state: row.state,
      episode: row.episode,
      handoverAckEpisode: row.ack,
      escalationOperationId: row.escalationOperationId,
      diverged: false,
    };
  }

  async requestHuman(input: {
    conversation: ConversationRef;
    operationId: string;
    expectedEpisode?: number | null;
  }): Promise<TransitionOutcome> {
    const key = this.key(input.conversation);
    const claimKey = `${key}|${input.operationId}`;
    const row =
      this.rows.get(key) ??
      {
        state: DEFAULT_OWNERSHIP_STATE as OwnershipState,
        episode: 0,
        ack: null,
        ackRef: null,
        escalationOperationId: null,
      };

    if (this.claimed.has(claimKey)) {
      return {
        ok: true,
        status: "duplicate",
        state: row.state,
        episode: row.episode,
        operationId: input.operationId,
        duplicateSource: "replay",
      };
    }
    // Same order as the store: replay, then the episode precondition, then legality.
    if (input.expectedEpisode !== undefined && input.expectedEpisode !== null && input.expectedEpisode !== row.episode) {
      return {
        ok: false,
        status: "stale_episode",
        state: row.state,
        episode: row.episode,
        operationId: input.operationId,
        duplicateSource: null,
      };
    }
    if (row.state !== "AI_OWNED" && row.state !== "AI_RESUMED") {
      return {
        ok: false,
        status: "illegal_transition",
        state: row.state,
        episode: row.episode,
        operationId: input.operationId,
        duplicateSource: null,
      };
    }
    if (!canTransition(row.state, "HUMAN_REQUESTED")) {
      return {
        ok: false,
        status: "illegal_transition",
        state: row.state,
        episode: row.episode,
        operationId: input.operationId,
        duplicateSource: null,
      };
    }

    this.claimed.add(claimKey);
    const next = {
      state: "HUMAN_REQUESTED" as const,
      episode: row.episode + 1,
      ack: row.ack,
      ackRef: row.ackRef,
      escalationOperationId: input.operationId,
    };
    this.rows.set(key, next);
    return {
      ok: true,
      status: "applied",
      state: next.state,
      episode: next.episode,
      operationId: input.operationId,
      duplicateSource: null,
    };
  }

  async claimAck(ref: ConversationRef, episode: number, claimantRef: string): Promise<boolean> {
    const key = this.key(ref);
    const row = this.rows.get(key);
    if (row === undefined || row.episode !== episode) return false;
    // The same claimant may re-enter its own claim; a different one may not.
    if (row.ack !== null && row.ack >= episode && row.ackRef !== claimantRef) return false;
    row.ack = episode;
    row.ackRef = claimantRef;
    return true;
  }
}

/** An ownership gate whose store is unreachable. Every call rejects, so a test
 *  can assert the reply path fails CLOSED rather than answering anyway. */
export class UnavailableOwnershipGate implements OwnershipGate {
  async read(): Promise<OwnershipView> {
    throw new Error("ownership store unavailable");
  }
  async requestHuman(): Promise<TransitionOutcome> {
    throw new Error("ownership store unavailable");
  }
  async claimAck(): Promise<boolean> {
    throw new Error("ownership store unavailable");
  }
}

/**
 * Test-only placeholder credentials. Built at runtime rather than written as
 * string literals so no scanner ever has to decide whether they are real.
 * None of these values exists in any environment.
 */
export const placeholder = (label: string): string =>
  ["not", "a", "real", "credential", label].join("-") + "-" + "0".repeat(16);

export const BOT_SECRET = placeholder("agent-bot-secret");
export const BOT_ACCESS_TOKEN = placeholder("agent-bot-token");
export const RUNTIME_SECRET = placeholder("runtime");
export const ADMIN_TOKEN = placeholder("admin");

export const ACCOUNT_ID = 1;
export const INBOX_ID = 7;
export const CONVERSATION_DISPLAY_ID = 42;
export const MESSAGE_ID = 9001;
export const TENANT_ID = "tenant-acme";
export const TEMPLATE_ID = "isola-ai-sales-front-desk-agent@v1";

/** The one string that must never appear in a log line. */
export const CUSTOMER_MESSAGE = "my invoice 348 says unpaid but I paid it on tuesday";

/**
 * Attachment material that must never be read, never be logged and never be
 * fetched. The host is deliberately NOT on any egress allowlist, so a request
 * for it would be blocked — but the tests assert it was never even attempted.
 */
export const ATTACHMENT_HOST = "attachments.chatwoot.example.test";
export const ATTACHMENT_URL = `https://${ATTACHMENT_HOST}/uploads/invoice-348-scan.pdf`;
export const ATTACHMENT_FILE_NAME = "invoice-348-scan.pdf";

/** A Chatwoot attachment node, complete with the fields we must ignore. */
export function attachment(fileType: string, id = 1): Record<string, unknown> {
  return {
    id,
    message_id: MESSAGE_ID,
    file_type: fileType,
    account_id: ACCOUNT_ID,
    extension: null,
    data_url: ATTACHMENT_URL,
    thumb_url: ATTACHMENT_URL,
    file_name: ATTACHMENT_FILE_NAME,
    file_size: 91_234,
  };
}

export function makeBinding(overrides: Partial<Binding> = {}): Binding {
  return {
    tenantId: TENANT_ID,
    chatwootAccountId: ACCOUNT_ID,
    chatwootInboxId: INBOX_ID,
    chatwootAgentBotId: 3,
    agentBotSecret: BOT_SECRET,
    agentBotAccessToken: BOT_ACCESS_TOKEN,
    paperclipCompanyId: "company-1",
    paperclipAgentId: "agent-1",
    templateId: TEMPLATE_ID,
    exposure: "PUBLIC",
    allowedSenders: [],
    status: "active",
    // A servable fixture must be `accepted`; lifecycle is a routing precondition,
    // not decoration. Tests that mean to exercise lifecycle override it explicitly
    // (see bindings-lifecycle.test.ts) — everything else asserts status/exposure
    // behaviour and needs this to be valid so lifecycle is not the reason it fails.
    lifecycle: "accepted",
    ...overrides,
  };
}

export function bindingsJson(bindings: Binding[]): string {
  return JSON.stringify(bindings);
}

export const BASE_ENV: EnvRecord = {
  CHATWOOT_BASE_URL: "https://chatwoot.example.test",
  RUNTIME_BASE_URL: "http://isola_isola-runtime:3000",
  RUNTIME_SECRET_PUBLIC: RUNTIME_SECRET,
  GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN,
  GATEWAY_BINDINGS_JSON: bindingsJson([makeBinding()]),
};

export function envConfig(overrides: EnvRecord = {}): GatewayConfig {
  return loadConfig({ ...BASE_ENV, ...overrides });
}

// ---------------------------------------------------------------------------
// Payloads and signing
// ---------------------------------------------------------------------------

export interface PayloadOverrides {
  event?: unknown;
  id?: unknown;
  content?: unknown;
  content_type?: unknown;
  attachments?: unknown;
  message_type?: unknown;
  private?: unknown;
  sender?: unknown;
  account?: unknown;
  inbox?: unknown;
  conversation?: unknown;
}

/**
 * An attachment-only inbound message: no text, one or more attachments, and the
 * `data_url` / `file_name` fields the gateway must never read.
 */
export function attachmentOnlyPayload(
  fileTypes: string[] = ["image"],
  overrides: PayloadOverrides = {},
): Record<string, unknown> {
  return messageCreatedPayload({
    content: null,
    attachments: fileTypes.map((type, index) => attachment(type, index + 1)),
    ...overrides,
  });
}

/** A truly empty inbound message: no text, no attachments, nothing. */
export function emptyMessagePayload(
  overrides: PayloadOverrides = {},
): Record<string, unknown> {
  return messageCreatedPayload({ content: "   ", ...overrides });
}

export function messageCreatedPayload(
  overrides: PayloadOverrides = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    event: "message_created",
    id: MESSAGE_ID,
    content: CUSTOMER_MESSAGE,
    content_type: "text",
    message_type: "incoming",
    private: false,
    sender: { type: "contact", id: 55 },
    account: { id: ACCOUNT_ID, name: "EPIC" },
    inbox: { id: INBOX_ID, name: "WhatsApp 3742" },
    conversation: {
      id: CONVERSATION_DISPLAY_ID,
      status: "pending",
      meta: { assignee: null },
      custom_attributes: {},
    },
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base;
}

export interface SignedRequest {
  raw: string;
  headers: Record<string, string>;
}

export interface SignArgs {
  body?: unknown;
  /** Exact bytes to send. When set, `body` is ignored. */
  rawBody?: string;
  secret?: string;
  /** Unix seconds. Defaults to now. */
  timestamp?: number;
  deliveryId?: string | null;
  /** Replace the computed signature header outright. */
  signatureHeader?: string | null;
  timestampHeader?: string | null;
  nowMs?: number;
}

export function signRequest(args: SignArgs = {}): SignedRequest {
  const raw = args.rawBody ?? JSON.stringify(args.body ?? messageCreatedPayload());
  const nowMs = args.nowMs ?? Date.now();
  const timestamp = String(args.timestamp ?? Math.floor(nowMs / 1000));
  const secret = args.secret ?? BOT_SECRET;
  const signature = `sha256=${computeSignature(secret, timestamp, Buffer.from(raw, "utf8"))}`;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (args.signatureHeader !== null) {
    headers["x-chatwoot-signature"] = args.signatureHeader ?? signature;
  }
  if (args.timestampHeader !== null) {
    headers["x-chatwoot-timestamp"] = args.timestampHeader ?? timestamp;
  }
  if (args.deliveryId !== null) {
    headers["x-chatwoot-delivery"] = args.deliveryId ?? "11111111-2222-3333-4444-555555555555";
  }
  return { raw, headers };
}

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

export class CapturingLogger {
  readonly lines: Array<Record<string, unknown>> = [];
  readonly raw: string[] = [];
  readonly logger: Logger;

  constructor() {
    this.logger = createLogger((line) => {
      this.raw.push(line);
      this.lines.push(JSON.parse(line) as Record<string, unknown>);
    });
  }

  withOutcome(outcome: string): Array<Record<string, unknown>> {
    return this.lines.filter((l) => l["outcome"] === outcome);
  }
}

export interface RecordedChatwootCall {
  kind:
    | "message"
    | "reconcile"
    | "conversation_read"
    | "toggle_status"
    | "toggle_status_pending"
    | "assignment"
    | "labels_read"
    | "labels_write"
    | "attributes_read"
    | "attributes_write";
  accountId: number;
  conversationId: number;
  accessToken: string;
  content?: string;
  private?: boolean;
  teamId?: number;
  labels?: string[];
  attributes?: Record<string, unknown>;
  deliveryRef?: string | null;
}

export class StubChatwootApi implements ChatwootApi {
  readonly calls: RecordedChatwootCall[] = [];

  labels: string[] = [];
  customAttributes: Record<string, unknown> = {};

  postMessageFailure: ChatwootApiError | null = null;
  /** Fails a PRIVATE note specifically. */
  privateNoteFailure: ChatwootApiError | null = null;
  openConversationFailure: ChatwootApiError | null = null;
  pendConversationFailure: ChatwootApiError | null = null;
  assignTeamFailure: ChatwootApiError | null = null;
  labelReadFailure: ChatwootApiError | null = null;
  attributeReadFailure: ChatwootApiError | null = null;

  /** Delay applied to every call, so the ACK path can be proved non-blocking. */
  callDelayMs = 0;

  private async pause(): Promise<void> {
    if (this.callDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.callDelayMs));
    }
  }

  get messages(): RecordedChatwootCall[] {
    return this.calls.filter((c) => c.kind === "message");
  }
  get customerMessages(): RecordedChatwootCall[] {
    return this.messages.filter((c) => c.private === false);
  }
  get privateNotes(): RecordedChatwootCall[] {
    return this.messages.filter((c) => c.private === true);
  }
  get statusToggles(): RecordedChatwootCall[] {
    return this.calls.filter((c) => c.kind === "toggle_status");
  }
  get assignments(): RecordedChatwootCall[] {
    return this.calls.filter((c) => c.kind === "assignment");
  }
  get labelWrites(): RecordedChatwootCall[] {
    return this.calls.filter((c) => c.kind === "labels_write");
  }
  get attributeWrites(): RecordedChatwootCall[] {
    return this.calls.filter((c) => c.kind === "attributes_write");
  }

  /**
   * Messages that Chatwoot actually holds, keyed by delivery ref. This is what
   * `reconcileDeliveryRef` reads, so a test can distinguish "the send threw but
   * Chatwoot committed" from "the send threw and nothing landed" — the exact
   * ambiguity the reconciliation path exists for.
   */
  readonly stored = new Map<string, { id: number; createdAt: number }>();
  /** Set to make reconciliation fail, forcing the fail-closed branch. */
  reconcileFailure: ChatwootApiError | null = null;
  /** Set to make reconciliation report that it could not prove absence. */
  reconcileInconclusive = false;
  /** When true, a throwing postMessage still commits the message in Chatwoot. */
  commitDespiteFailure = false;
  conversationRecord: unknown = null;

  private nextMessageId = 5000;

  async postMessage(
    target: ChatwootTarget,
    content: string,
    isPrivate: boolean,
    deliveryRef?: string,
  ): Promise<number | null> {
    await this.pause();
    this.calls.push({
      kind: "message",
      accountId: target.accountId,
      conversationId: target.conversationId,
      accessToken: target.accessToken,
      content,
      private: isPrivate,
      deliveryRef: deliveryRef ?? null,
    });
    const failing =
      (this.postMessageFailure && !isPrivate) || (this.privateNoteFailure && isPrivate);
    if (failing && !this.commitDespiteFailure) {
      throw (isPrivate ? this.privateNoteFailure : this.postMessageFailure) as ChatwootApiError;
    }
    const id = this.nextMessageId++;
    if (deliveryRef !== undefined) {
      this.stored.set(deliveryRef, { id, createdAt: Math.floor(Date.now() / 1000) });
    }
    if (failing) {
      throw (isPrivate ? this.privateNoteFailure : this.postMessageFailure) as ChatwootApiError;
    }
    return id;
  }

  async reconcileDeliveryRef(
    _target: ChatwootTarget,
    deliveryRef: string,
    _pivotMessageId: number | null,
  ): Promise<ReconcileResult> {
    this.calls.push({
      kind: "reconcile",
      accountId: _target.accountId,
      conversationId: _target.conversationId,
      accessToken: _target.accessToken,
      deliveryRef,
    });
    if (this.reconcileFailure) {
      return { kind: "inconclusive", detail: this.reconcileFailure.message };
    }
    if (this.reconcileInconclusive) {
      return { kind: "inconclusive", detail: "page budget exhausted" };
    }
    const found = this.stored.get(deliveryRef);
    return found === undefined
      ? { kind: "absent" }
      : { kind: "found", messageId: found.id };
  }

  async getConversationRecord(target: ChatwootTarget): Promise<unknown> {
    this.calls.push({
      kind: "conversation_read",
      accountId: target.accountId,
      conversationId: target.conversationId,
      accessToken: target.accessToken,
    });
    return this.conversationRecord;
  }

  async openConversation(target: ChatwootTarget): Promise<void> {
    await this.pause();
    this.calls.push({
      kind: "toggle_status",
      accountId: target.accountId,
      conversationId: target.conversationId,
      accessToken: target.accessToken,
    });
    if (this.openConversationFailure) throw this.openConversationFailure;
  }

  /** Handback's Chatwoot half. Recorded as its own call kind so a test can tell
   * a hand-BACK from a take-OVER — both are `toggle_status` on the wire. */
  async pendConversation(target: ChatwootTarget): Promise<void> {
    await this.pause();
    this.calls.push({
      kind: "toggle_status_pending",
      accountId: target.accountId,
      conversationId: target.conversationId,
      accessToken: target.accessToken,
    });
    if (this.pendConversationFailure) throw this.pendConversationFailure;
  }

  async assignTeam(target: ChatwootTarget, teamId: number): Promise<void> {
    await this.pause();
    this.calls.push({
      kind: "assignment",
      accountId: target.accountId,
      conversationId: target.conversationId,
      accessToken: target.accessToken,
      teamId,
    });
    if (this.assignTeamFailure) throw this.assignTeamFailure;
  }

  async getLabels(target: ChatwootTarget): Promise<string[]> {
    this.calls.push({
      kind: "labels_read",
      accountId: target.accountId,
      conversationId: target.conversationId,
      accessToken: target.accessToken,
    });
    if (this.labelReadFailure) throw this.labelReadFailure;
    return [...this.labels];
  }

  async setLabels(target: ChatwootTarget, labels: string[]): Promise<void> {
    this.calls.push({
      kind: "labels_write",
      accountId: target.accountId,
      conversationId: target.conversationId,
      accessToken: target.accessToken,
      labels: [...labels],
    });
    this.labels = [...labels];
  }

  async getCustomAttributes(target: ChatwootTarget): Promise<Record<string, unknown>> {
    this.calls.push({
      kind: "attributes_read",
      accountId: target.accountId,
      conversationId: target.conversationId,
      accessToken: target.accessToken,
    });
    if (this.attributeReadFailure) throw this.attributeReadFailure;
    return { ...this.customAttributes };
  }

  async setCustomAttributes(
    target: ChatwootTarget,
    attributes: Record<string, unknown>,
  ): Promise<void> {
    this.calls.push({
      kind: "attributes_write",
      accountId: target.accountId,
      conversationId: target.conversationId,
      accessToken: target.accessToken,
      attributes: { ...attributes },
    });
    this.customAttributes = { ...attributes };
  }
}

// ---------------------------------------------------------------------------
// Ledger double
// ---------------------------------------------------------------------------

interface FakeRow {
  digest: string;
  state: DeliveryState;
  attempts: number;
  leaseExpiresAt: number | null;
  conversationId: number | null;
  messageId: number | null;
  mode: string | null;
  correlationId: string;
  chatwootMessageId: number | null;
}

/**
 * An in-memory ledger that models the SQL semantics exactly: one row per
 * (identity, action), insert-or-take-over-on-expired-lease, digest conflict,
 * and terminal states that refuse a re-claim.
 *
 * `survivesRestart()` returns a fresh instance sharing the same row map, which
 * is how the tests simulate a container replacement: the process state is gone,
 * the ledger is not.
 */
export class FakeLedger implements Ledger {
  readonly rows: Map<string, FakeRow>;
  /** Set to make every operation fail, as an unreachable store would. */
  unavailable = false;
  migrated = 0;

  constructor(rows: Map<string, FakeRow> = new Map()) {
    this.rows = rows;
  }

  /** A new process against the same durable store. */
  survivesRestart(): FakeLedger {
    return new FakeLedger(this.rows);
  }

  private key(identity: LedgerIdentity, action: string): string {
    return [
      identity.tenantId,
      identity.bindingId,
      identity.chatwootAccountId,
      identity.chatwootInboxId,
      identity.eventId,
      action,
    ].join("|");
  }

  private guard(): void {
    if (this.unavailable) throw new LedgerUnavailableError("stub_unavailable");
  }

  async migrate(): Promise<void> {
    this.guard();
    this.migrated += 1;
  }

  async reserve(args: ReserveArgs): Promise<ReserveResult> {
    this.guard();
    const key = this.key(args.identity, DELIVERY_ACTION);
    const existing = this.rows.get(key);
    const now = Date.now();

    if (existing === undefined) {
      this.rows.set(key, {
        digest: args.digest,
        state: "reserved",
        attempts: 1,
        leaseExpiresAt: now + args.leaseMs,
        conversationId: args.conversationId,
        messageId: args.messageId,
        mode: args.mode,
        correlationId: args.correlationId,
        chatwootMessageId: null,
      });
      return { kind: "reserved", attempts: 1 };
    }

    if (existing.digest !== args.digest) {
      return { kind: "conflict", storedDigest: existing.digest };
    }
    if (existing.state === "completed" || existing.state === "failed") {
      return { kind: "duplicate", state: existing.state };
    }
    if (existing.leaseExpiresAt !== null && existing.leaseExpiresAt > now) {
      return { kind: "duplicate", state: existing.state };
    }
    existing.attempts += 1;
    existing.state = "reserved";
    existing.leaseExpiresAt = now + args.leaseMs;
    return { kind: "resumed", attempts: existing.attempts };
  }

  async claimAction(
    identity: LedgerIdentity,
    action: string,
    digest: string,
    correlationId: string,
    leaseMs: number,
  ): Promise<ClaimResult> {
    this.guard();
    const key = this.key(identity, action);
    const existing = this.rows.get(key);
    if (existing === undefined) {
      this.rows.set(key, {
        digest,
        state: "in_progress",
        attempts: 1,
        leaseExpiresAt: Date.now() + leaseMs,
        conversationId: null,
        messageId: null,
        mode: null,
        correlationId,
        chatwootMessageId: null,
      });
      return { kind: "claimed" };
    }
    if (existing.state === "completed") {
      return { kind: "completed", chatwootMessageId: existing.chatwootMessageId };
    }
    if (existing.state === "failed") return { kind: "completed", chatwootMessageId: null };
    existing.attempts += 1;
    return { kind: "ambiguous", attempts: existing.attempts };
  }

  async complete(
    identity: LedgerIdentity,
    action: string,
    chatwootMessageId: number | null,
  ): Promise<void> {
    this.guard();
    const row = this.rows.get(this.key(identity, action));
    if (row === undefined) return;
    row.state = "completed";
    row.leaseExpiresAt = null;
    if (chatwootMessageId !== null) row.chatwootMessageId = chatwootMessageId;
  }

  async fail(identity: LedgerIdentity, action: string): Promise<void> {
    this.guard();
    const row = this.rows.get(this.key(identity, action));
    if (row === undefined) return;
    row.state = "failed";
    row.leaseExpiresAt = null;
  }

  async release(identity: LedgerIdentity, action: string): Promise<void> {
    this.guard();
    const row = this.rows.get(this.key(identity, action));
    if (row === undefined || row.state !== "in_progress") return;
    row.leaseExpiresAt = 0;
  }

  async heartbeat(
    identity: LedgerIdentity,
    action: string,
    leaseMs: number,
  ): Promise<void> {
    this.guard();
    const row = this.rows.get(this.key(identity, action));
    if (row === undefined) return;
    row.state = "in_progress";
    row.leaseExpiresAt = Date.now() + leaseMs;
  }

  async dueForRecovery(limit: number): Promise<RecoverableDelivery[]> {
    this.guard();
    const now = Date.now();
    const out: RecoverableDelivery[] = [];
    for (const [key, row] of this.rows) {
      const parts = key.split("|");
      if (parts[5] !== DELIVERY_ACTION) continue;
      if (row.state !== "reserved" && row.state !== "in_progress") continue;
      if (row.leaseExpiresAt !== null && row.leaseExpiresAt > now) continue;
      out.push({
        tenantId: parts[0] as string,
        bindingId: parts[1] as string,
        chatwootAccountId: Number(parts[2]),
        chatwootInboxId: Number(parts[3]),
        eventId: parts[4] as string,
        payloadDigest: row.digest,
        correlationId: row.correlationId,
        conversationId: row.conversationId,
        messageId: row.messageId,
        mode: row.mode,
        state: row.state,
        attempts: row.attempts,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  async healthy(): Promise<boolean> {
    return !this.unavailable;
  }

  async close(): Promise<void> {
    /* nothing to close */
  }

  /** Force every live lease to look expired, as a restart effectively does. */
  expireAllLeases(): void {
    for (const row of this.rows.values()) row.leaseExpiresAt = 0;
  }
}

export class StubAgentRuntime implements AgentRuntime {
  readonly requests: AgentRuntimeRequest[] = [];
  constructor(
    private readonly impl: (req: AgentRuntimeRequest) => Promise<AgentRuntimeResult>,
  ) {}

  async invoke(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    this.requests.push(request);
    return this.impl(request);
  }

  /**
   * A pre-v2 runtime: it returns text and says NOTHING about escalation.
   * `action: null` is what keeps every pre-existing test exercising the legacy
   * phrase-heuristic path, which is exactly what they were written against.
   */
  static answering(text: string): StubAgentRuntime {
    return new StubAgentRuntime(async () => ({
      text,
      action: null,
      actionUnrecognised: false,
      actionReason: null,
      outcome: "ok",
      correlationId: "runtime-correlation-id",
      completionState: "completed",
      contractVersion: 1,
    }));
  }

  /** A v2 runtime returning an explicit structured action. */
  static answeringWithAction(
    text: string,
    action: "reply" | "request_human",
    actionReason: string | null = null,
  ): StubAgentRuntime {
    return new StubAgentRuntime(async () => ({
      text,
      action,
      actionUnrecognised: false,
      actionReason,
      outcome: "ok",
      correlationId: "runtime-correlation-id",
      completionState: "completed",
      contractVersion: 2,
    }));
  }

  /** The open-contract case: success with no text. */
  static withoutText(): StubAgentRuntime {
    return new StubAgentRuntime(async () => ({
      text: null,
      action: null,
      actionUnrecognised: false,
      actionReason: null,
      outcome: "ok",
      correlationId: "runtime-correlation-id",
      completionState: "completed",
      contractVersion: 1,
    }));
  }

  static failing(outcome: string): StubAgentRuntime {
    return new StubAgentRuntime(async () => ({
      text: null,
      action: null,
      actionUnrecognised: false,
      actionReason: null,
      outcome,
      correlationId: "runtime-correlation-id",
      completionState: null,
      contractVersion: null,
    }));
  }

  /**
   * A failure carrying the runtime's structured end state — the shape the
   * deployed runtime actually returns.
   */
  static failingWithState(
    completionState: RuntimeCompletionState,
    outcome: string,
  ): StubAgentRuntime {
    return new StubAgentRuntime(async () => ({
      text: null,
      action: null,
      actionUnrecognised: false,
      actionReason: null,
      outcome,
      correlationId: "runtime-correlation-id",
      completionState,
      contractVersion: 1,
    }));
  }

  /** Blocks for `delayMs` so the ACK path can be proved non-blocking. */
  static slow(delayMs: number, text: string): StubAgentRuntime {
    return new StubAgentRuntime(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                text,
                action: null,
                actionUnrecognised: false,
                actionReason: null,
                outcome: "ok",
                correlationId: "runtime-correlation-id",
                completionState: "completed",
                contractVersion: 1,
              }),
            delayMs,
          ),
        ),
    );
  }
}

// ---------------------------------------------------------------------------
// Egress recorder — for proving what was NEVER contacted
// ---------------------------------------------------------------------------

export interface EgressRecorder {
  /** Every hostname a real client asked for, in order. */
  readonly hosts: string[];
  /** Every full URL, so a test can assert on paths as well as hosts. */
  readonly urls: string[];
  safeFetch: SafeFetch;
}

/**
 * A `SafeFetch` that records and answers 200 `{}` instead of opening a socket.
 *
 * Deliberately NOT allowlist-enforcing: it records everything the service tries
 * to reach, so "the attachment host was never contacted" is proved by absence
 * from a complete list rather than by a block that might not have been hit.
 */
export function recordingEgress(): EgressRecorder {
  const hosts: string[] = [];
  const urls: string[] = [];
  return {
    hosts,
    urls,
    safeFetch: async (input) => {
      const raw = typeof input === "string" ? input : input.toString();
      urls.push(raw);
      try {
        hosts.push(new URL(raw).hostname.toLowerCase());
      } catch {
        hosts.push("<unparseable>");
      }
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface TestServer {
  url: string;
  gateway: Gateway;
  chatwoot: StubChatwootApi;
  runtime: AgentRuntime;
  ledger: FakeLedger;
  close(): Promise<void>;
}

export interface StartArgs extends Partial<GatewayDeps> {
  config?: GatewayConfig;
  ledger?: FakeLedger;
  ownership?: OwnershipGate;
}

export async function startServer(args: StartArgs = {}): Promise<TestServer> {
  const config = args.config ?? envConfig();
  // No test is ever allowed to reach a real Chatwoot or a real runtime.
  const chatwoot = (args.chatwoot as StubChatwootApi | undefined) ?? new StubChatwootApi();
  const runtime = args.runtime ?? StubAgentRuntime.answering("Here is your answer.");
  const ledger = args.ledger ?? new FakeLedger();
  const ownership = args.ownership ?? new InMemoryOwnershipGate();

  const gateway = createGateway({
    ...args,
    config,
    chatwoot,
    runtime,
    ledger,
    ownership,
  });

  const server: Server = createServer(gateway.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    gateway,
    chatwoot,
    runtime,
    ledger,
    close: async () => {
      await gateway.drain();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

export interface RealClientServer {
  url: string;
  gateway: Gateway;
  egress: EgressRecorder;
  ledger: FakeLedger;
  close(): Promise<void>;
}

/**
 * A gateway wired to the REAL Chatwoot and isola-runtime clients, over a
 * recording `SafeFetch`. No stubs stand between the pipeline and the network
 * primitive, so the recorded host list is the complete set of hosts this
 * service tried to reach for a delivery.
 */
export async function startRealClientServer(
  args: { config?: GatewayConfig; logger?: Logger; ledger?: FakeLedger; ownership?: OwnershipGate } = {},
): Promise<RealClientServer> {
  const egress = recordingEgress();
  const ledger = args.ledger ?? new FakeLedger();
  const gateway = createGateway({
    config: args.config ?? envConfig(),
    ...(args.logger === undefined ? {} : { logger: args.logger }),
    safeFetch: egress.safeFetch,
    ledger,
    ownership: args.ownership ?? new InMemoryOwnershipGate(),
  });
  const server: Server = createServer(gateway.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    gateway,
    egress,
    ledger,
    close: async () => {
      await gateway.drain();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

export interface HttpResult {
  status: number;
  correlationHeader: string | null;
  json: Record<string, unknown>;
  text: string;
  latencyMs: number;
}

async function request(
  url: string,
  init: RequestInit & { method: string },
): Promise<HttpResult> {
  const startedAt = Date.now();
  const res = await fetch(url, init);
  const text = await res.text();
  const latencyMs = Date.now() - startedAt;
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return {
    status: res.status,
    correlationHeader: res.headers.get("x-isola-correlation-id"),
    json,
    text,
    latencyMs,
  };
}

export function postWebhook(base: string, signed: SignedRequest): Promise<HttpResult> {
  return request(`${base}/v1/chatwoot/agent-bot`, {
    method: "POST",
    headers: signed.headers,
    body: signed.raw,
  });
}

export function get(base: string, path: string, bearer?: string): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (bearer) headers["authorization"] = `Bearer ${bearer}`;
  return request(`${base}${path}`, { method: "GET", headers });
}
