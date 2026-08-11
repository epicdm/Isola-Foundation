/**
 * Test harness. Every test builds its own gateway from an explicit env record,
 * so no test depends on the ambient process environment, and no test ever opens
 * a socket to Chatwoot or to isola-runtime.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createGateway, type Gateway, type GatewayDeps } from "../src/app.js";
import type { Binding } from "../src/bindings.js";
import type { ChatwootApi, ChatwootTarget } from "../src/chatwoot.js";
import { ChatwootApiError } from "../src/errors.js";
import { loadConfig, type EnvRecord, type GatewayConfig } from "../src/config.js";
import { createLogger, type Logger } from "../src/log.js";
import type { AgentRuntime, AgentRuntimeRequest, AgentRuntimeResult } from "../src/runtime.js";
import { computeSignature } from "../src/signature.js";

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
    status: "active",
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
  message_type?: unknown;
  private?: unknown;
  sender?: unknown;
  account?: unknown;
  inbox?: unknown;
  conversation?: unknown;
}

export function messageCreatedPayload(
  overrides: PayloadOverrides = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    event: "message_created",
    id: MESSAGE_ID,
    content: CUSTOMER_MESSAGE,
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
    | "toggle_status"
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
}

export class StubChatwootApi implements ChatwootApi {
  readonly calls: RecordedChatwootCall[] = [];

  labels: string[] = [];
  customAttributes: Record<string, unknown> = {};

  postMessageFailure: ChatwootApiError | null = null;
  labelReadFailure: ChatwootApiError | null = null;
  attributeReadFailure: ChatwootApiError | null = null;

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

  async postMessage(
    target: ChatwootTarget,
    content: string,
    isPrivate: boolean,
  ): Promise<void> {
    this.calls.push({
      kind: "message",
      accountId: target.accountId,
      conversationId: target.conversationId,
      accessToken: target.accessToken,
      content,
      private: isPrivate,
    });
    if (this.postMessageFailure && !isPrivate) throw this.postMessageFailure;
  }

  async openConversation(target: ChatwootTarget): Promise<void> {
    this.calls.push({
      kind: "toggle_status",
      accountId: target.accountId,
      conversationId: target.conversationId,
      accessToken: target.accessToken,
    });
  }

  async assignTeam(target: ChatwootTarget, teamId: number): Promise<void> {
    this.calls.push({
      kind: "assignment",
      accountId: target.accountId,
      conversationId: target.conversationId,
      accessToken: target.accessToken,
      teamId,
    });
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

export class StubAgentRuntime implements AgentRuntime {
  readonly requests: AgentRuntimeRequest[] = [];
  constructor(
    private readonly impl: (req: AgentRuntimeRequest) => Promise<AgentRuntimeResult>,
  ) {}

  async invoke(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    this.requests.push(request);
    return this.impl(request);
  }

  static answering(text: string): StubAgentRuntime {
    return new StubAgentRuntime(async () => ({
      text,
      outcome: "ok",
      correlationId: "runtime-correlation-id",
    }));
  }

  /** The open-contract case: success with no text. */
  static withoutText(): StubAgentRuntime {
    return new StubAgentRuntime(async () => ({
      text: null,
      outcome: "ok",
      correlationId: "runtime-correlation-id",
    }));
  }

  static failing(outcome: string): StubAgentRuntime {
    return new StubAgentRuntime(async () => ({
      text: null,
      outcome,
      correlationId: "runtime-correlation-id",
    }));
  }

  /** Blocks for `delayMs` so the ACK path can be proved non-blocking. */
  static slow(delayMs: number, text: string): StubAgentRuntime {
    return new StubAgentRuntime(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ text, outcome: "ok", correlationId: "runtime-correlation-id" }),
            delayMs,
          ),
        ),
    );
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface TestServer {
  url: string;
  gateway: Gateway;
  chatwoot: StubChatwootApi;
  runtime: AgentRuntime;
  close(): Promise<void>;
}

export interface StartArgs extends Partial<GatewayDeps> {
  config?: GatewayConfig;
}

export async function startServer(args: StartArgs = {}): Promise<TestServer> {
  const config = args.config ?? envConfig();
  // No test is ever allowed to reach a real Chatwoot or a real runtime.
  const chatwoot = (args.chatwoot as StubChatwootApi | undefined) ?? new StubChatwootApi();
  const runtime = args.runtime ?? StubAgentRuntime.answering("Here is your answer.");

  const gateway = createGateway({
    ...args,
    config,
    chatwoot,
    runtime,
  });

  const server: Server = createServer(gateway.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    gateway,
    chatwoot,
    runtime,
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
