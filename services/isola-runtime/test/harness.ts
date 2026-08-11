/**
 * Test harness. Every test builds its own app from an explicit env record, so
 * no test depends on the ambient process environment.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp, createRuntime, type AppDeps, type Runtime } from "../src/app.js";
import { loadConfig, type EnvRecord, type RuntimeConfig } from "../src/config.js";
import { PaperclipApiError } from "../src/errors.js";
import { createLogger, type Logger } from "../src/log.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../src/model.js";
import type {
  AgentBudget,
  IssueStatus,
  PaperclipApi,
  PaperclipCall,
} from "../src/paperclip.js";
import type { RunOutcome, RunRecorder } from "../src/recorder.js";
import type { CostEventPayload } from "../src/state.js";

/**
 * Test-only placeholder credentials. Built at runtime rather than written as
 * string literals so no scanner ever has to decide whether they are real.
 * None of these values exists in any environment.
 */
const placeholder = (label: string): string =>
  ["not", "a", "real", "credential", label].join("-") + "-" + "0".repeat(16);

export const INTERNAL_SECRET = placeholder("internal");
export const PUBLIC_SECRET = placeholder("public");

export const INTERNAL_TEMPLATE = "epic-staff-operations-coordinator@v1";
export const PUBLIC_TEMPLATE = "isola-ai-sales-front-desk-agent@v1";

export const BASE_ENV: EnvRecord = {
  RUNTIME_SECRET_INTERNAL: INTERNAL_SECRET,
  RUNTIME_SECRET_PUBLIC: PUBLIC_SECRET,
  MODEL_BASE_URL: "https://api.deepseek.com",
  MODEL_API_KEY: placeholder("model"),
  PAPERCLIP_BASE_URL: "https://paperclip.example.test",
  PAPERCLIP_API_KEY: placeholder("paperclip"),
  // No test may write to a real state directory or depend on one left behind by
  // another test. Tests that exercise the file backend build their own store.
  RUNTIME_STATE_BACKEND: "memory",
};

export function envConfig(overrides: EnvRecord = {}): RuntimeConfig {
  return loadConfig({ ...BASE_ENV, ...overrides });
}

/** Collects every emitted log line, parsed. */
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

export class StubModelClient implements ModelClient {
  readonly calls: ModelRequest[] = [];
  constructor(private readonly impl: (req: ModelRequest) => Promise<ModelResponse>) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    return this.impl(request);
  }

  static returning(content: string): StubModelClient {
    return new StubModelClient(async () => ({
      content,
      model: "stub-model",
      finishReason: "stop",
      usage: null,
    }));
  }

  static throwing(err: Error): StubModelClient {
    return new StubModelClient(async () => {
      throw err;
    });
  }
}

export class RecordingRecorder implements RunRecorder {
  readonly kind = "recording";
  readonly outcomes: RunOutcome[] = [];
  constructor(private readonly failWith: Error | null = null) {}

  async record(outcome: RunOutcome): Promise<void> {
    this.outcomes.push(outcome);
    if (this.failWith) throw this.failWith;
  }
}

/**
 * A Paperclip API double.
 *
 * Every call is recorded with the bearer and the run-id header it was made
 * with, so the tests can assert the callback contract (agent key, not board
 * key; `X-Paperclip-Run-Id` on every call) as well as the sequence.
 *
 * No test ever opens a socket to Paperclip: `startServer` injects one of these
 * whenever the caller has not supplied its own.
 */
export interface RecordedCall {
  kind: "comment" | "transition" | "cost_event" | "budget_read" | "pause";
  issueId?: string;
  body?: string;
  status?: IssueStatus;
  companyId?: string;
  event?: CostEventPayload;
  agentId?: string;
  apiKey: string;
  runId: string | null;
}

export class StubPaperclipApi implements PaperclipApi {
  readonly calls: RecordedCall[] = [];
  budget: AgentBudget = { budgetMonthlyCents: null, spentMonthlyCents: 0 };

  /** Queue of failures, consumed one per cost-event delivery attempt. */
  costEventFailures: Array<PaperclipApiError | null> = [];
  commentFailure: PaperclipApiError | null = null;
  transitionFailure: PaperclipApiError | null = null;
  budgetFailure: PaperclipApiError | null = null;
  pauseFailure: PaperclipApiError | null = null;

  get comments(): RecordedCall[] {
    return this.calls.filter((c) => c.kind === "comment");
  }
  get transitions(): RecordedCall[] {
    return this.calls.filter((c) => c.kind === "transition");
  }
  get costEvents(): CostEventPayload[] {
    return this.calls
      .filter((c) => c.kind === "cost_event")
      .map((c) => c.event as CostEventPayload);
  }
  get pauses(): RecordedCall[] {
    return this.calls.filter((c) => c.kind === "pause");
  }

  async postComment(issueId: string, body: string, call: PaperclipCall): Promise<void> {
    this.calls.push({ kind: "comment", issueId, body, apiKey: call.apiKey, runId: call.runId });
    if (this.commentFailure) throw this.commentFailure;
  }

  async patchIssueStatus(
    issueId: string,
    status: IssueStatus,
    call: PaperclipCall,
  ): Promise<void> {
    this.calls.push({
      kind: "transition",
      issueId,
      status,
      apiKey: call.apiKey,
      runId: call.runId,
    });
    if (this.transitionFailure) throw this.transitionFailure;
  }

  async postCostEvent(
    companyId: string,
    event: CostEventPayload,
    call: PaperclipCall,
  ): Promise<void> {
    this.calls.push({
      kind: "cost_event",
      companyId,
      event,
      apiKey: call.apiKey,
      runId: call.runId,
    });
    const failure = this.costEventFailures.shift();
    if (failure) throw failure;
  }

  async getAgentBudget(agentId: string, call: PaperclipCall): Promise<AgentBudget> {
    this.calls.push({
      kind: "budget_read",
      agentId,
      apiKey: call.apiKey,
      runId: call.runId,
    });
    if (this.budgetFailure) throw this.budgetFailure;
    return { ...this.budget };
  }

  async pauseAgent(agentId: string, call: PaperclipCall): Promise<void> {
    this.calls.push({ kind: "pause", agentId, apiKey: call.apiKey, runId: call.runId });
    if (this.pauseFailure) throw this.pauseFailure;
  }
}

export interface TestServer {
  url: string;
  close(): Promise<void>;
  runtime: Runtime;
  paperclip: StubPaperclipApi | null;
}

export async function startServer(deps: AppDeps): Promise<TestServer> {
  // No test is ever allowed to reach a real Paperclip host.
  const stub = deps.paperclipApi === undefined ? new StubPaperclipApi() : null;
  const runtime = createRuntime(
    stub === null ? deps : { ...deps, paperclipApi: stub },
  );
  const server: Server = createServer(runtime.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    runtime,
    paperclip: stub ?? (deps.paperclipApi as StubPaperclipApi | null),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/** Kept so any caller that only wants a handler still has one. */
export function buildHandler(deps: AppDeps) {
  return createApp(deps);
}

export interface InvokeArgs {
  bearer?: string | null;
  body?: unknown;
  rawBody?: string;
}

export interface HttpResult {
  status: number;
  correlationHeader: string | null;
  json: Record<string, unknown>;
  text: string;
}

async function request(
  url: string,
  init: RequestInit & { method: string },
): Promise<HttpResult> {
  const res = await fetch(url, init);
  const text = await res.text();
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
  };
}

export function invoke(base: string, args: InvokeArgs): Promise<HttpResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (args.bearer !== null && args.bearer !== undefined) {
    headers["authorization"] = `Bearer ${args.bearer}`;
  }
  return request(`${base}/v1/invoke`, {
    method: "POST",
    headers,
    body: args.rawBody ?? JSON.stringify(args.body ?? {}),
  });
}

export function get(base: string, path: string, bearer?: string): Promise<HttpResult> {
  const headers: Record<string, string> = {};
  if (bearer) headers["authorization"] = `Bearer ${bearer}`;
  return request(`${base}${path}`, { method: "GET", headers });
}

export const OVERDUE_FIXTURE = {
  issueId: "ISSUE-4821",
  fixture: "overdue-invoices",
  invoices: [
    { account: "ACC-1001", customer: "Northwind Freight", balance: "USD 4,120.00", dueDate: "2026-06-01" },
    { account: "ACC-1044", customer: "Brent Symes", balance: "USD 348.00", dueDate: "2026-07-15" },
  ],
};
