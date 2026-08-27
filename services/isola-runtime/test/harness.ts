/**
 * Test harness. Every test builds its own app from an explicit env record, so
 * no test depends on the ambient process environment.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp, createRuntime, type AppDeps, type Runtime } from "../src/app.js";
import { AGENTOS_ALLOWED_TENANT } from "../src/agentos-allowlist.js";
import { loadConfig, type EnvRecord, type RuntimeConfig } from "../src/config.js";
import { PaperclipApiError } from "../src/errors.js";
import { createDirectModelExecutionProvider } from "../src/execution-provider.js";
import { createLogger, type Logger } from "../src/log.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../src/model.js";
import type {
  AgentBudget,
  CreateIssueInput,
  IssueStatus,
  IssueSummary,
  ListIssuesQuery,
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
export const placeholder = (label: string): string =>
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
  // REQUIRED IN PRODUCTION, so required here. The ceiling applied to any agent
  // Paperclip has no budget for — which is every agent in this harness. Adding
  // it made thirteen tests go from red to green, and that is the point: without
  // it the runtime REFUSES rather than permitting, which is the whole change.
  // A harness that supplied a permissive default would have hidden exactly the
  // behaviour these tests now depend on.
  RUNTIME_BUDGET_FALLBACK_CENTS: "5000",
  // REQUIRED IN PRODUCTION (see config.ts's bootErrors), so required here for
  // the same reason as RUNTIME_BUDGET_FALLBACK_CENTS above: without these two,
  // epic-staff-operations-coordinator@v1 has no fallback and every eligible
  // request would 503 forever. `startServer` in this file separately wires a
  // per-test `agentOsProvider` default from whatever `modelClient` a test
  // supplies, so these two only need to be NON-EMPTY for bootErrors to read
  // clean — no test depends on this exact URL or secret being dialled.
  // The suite exercises the AgentOS path, so the harness turns the master
  // switch ON. Production is the opposite (deploy/isola-rt-stack.yml pins it
  // off) — `agentos-allowlist.test.ts` covers the disabled behaviour, and
  // `agentos-routing.test.ts` covers a disabled runtime over HTTP.
  AGENTOS_ENABLED: "true",
  AGENTOS_BASE_URL: "https://agentos-sidecar.internal.example.test",
  AGENTOS_SHARED_SECRET: placeholder("agentos"),
  // The SERVER-SIDE tenant authority. Set to the expected constant, which is
  // what a real deployment sets it to — the request body can no longer choose
  // a tenant, so the fixtures' `tenantId` is only ever an echo of this.
  AGENTOS_TENANT_ID: AGENTOS_ALLOWED_TENANT,
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
  kind:
    | "comment"
    | "transition"
    | "cost_event"
    | "budget_read"
    | "pause"
    | "issue_list"
    | "issue_create";
  issueId?: string;
  body?: string;
  status?: IssueStatus;
  companyId?: string;
  event?: CostEventPayload;
  agentId?: string;
  apiKey: string;
  runId: string | null;
  /** Extra PATCH fields sent alongside a transition, e.g. the review assignee. */
  extra?: Record<string, unknown> | null;
  /** Issue list query, and issue create payload. */
  query?: ListIssuesQuery;
  input?: CreateIssueInput;
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
  listIssuesFailure: PaperclipApiError | null = null;
  createIssueFailure: PaperclipApiError | null = null;

  /**
   * Issues this stub holds, as `listIssues` would return them. `companyId` is
   * how the real API scopes the list; an entry seeded without one is visible to
   * every company, which keeps the simple fixtures short.
   */
  readonly issues: Array<IssueSummary & { companyId?: string }> = [];
  /** Bodies of the issues this stub created, for content assertions. */
  readonly createdIssues: CreateIssueInput[] = [];
  /**
   * Awaited inside `createIssue` before the issue is minted. Lets a test hold a
   * creation open long enough for a genuine concurrent second run to arrive.
   */
  beforeCreateIssue: (() => Promise<void>) | null = null;
  private issueSeq = 0;

  get comments(): RecordedCall[] {
    return this.calls.filter((c) => c.kind === "comment");
  }
  get transitions(): RecordedCall[] {
    return this.calls.filter((c) => c.kind === "transition");
  }
  get issueLists(): RecordedCall[] {
    return this.calls.filter((c) => c.kind === "issue_list");
  }
  get issueCreates(): RecordedCall[] {
    return this.calls.filter((c) => c.kind === "issue_create");
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
    extra?: Record<string, unknown>,
  ): Promise<void> {
    this.calls.push({
      kind: "transition",
      issueId,
      status,
      apiKey: call.apiKey,
      runId: call.runId,
      extra: extra ?? null,
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

  async listIssues(
    companyId: string,
    query: ListIssuesQuery,
    call: PaperclipCall,
  ): Promise<IssueSummary[]> {
    this.calls.push({
      kind: "issue_list",
      companyId,
      query,
      apiKey: call.apiKey,
      runId: call.runId,
    });
    if (this.listIssuesFailure) throw this.listIssuesFailure;
    // Mirrors Paperclip: `q` is a case-insensitive title CONTAINS match.
    const needle = (query.q ?? "").toLowerCase();
    return this.issues
      .filter((issue) => (issue.companyId ?? companyId) === companyId)
      .filter((issue) => issue.title.toLowerCase().includes(needle))
      .map(({ id, title, status }) => ({ id, title, status }))
      .slice(0, query.limit ?? this.issues.length);
  }

  async createIssue(
    companyId: string,
    input: CreateIssueInput,
    call: PaperclipCall,
  ): Promise<IssueSummary> {
    this.calls.push({
      kind: "issue_create",
      companyId,
      input,
      apiKey: call.apiKey,
      runId: call.runId,
    });
    if (this.beforeCreateIssue) await this.beforeCreateIssue();
    if (this.createIssueFailure) throw this.createIssueFailure;
    this.issueSeq += 1;
    const issue: IssueSummary = {
      id: `issue-${this.issueSeq}`,
      title: input.title,
      status: input.status,
    };
    this.issues.push({ ...issue, companyId });
    this.createdIssues.push(input);
    return issue;
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
  const withPaperclip = stub === null ? deps : { ...deps, paperclipApi: stub };
  // Most existing tests were written before the AgentOS execution provider
  // existed and inject only `modelClient` — they are testing budget, metering,
  // exposure resolution, the callback loop, and so on, NOT the AgentOS HTTP
  // boundary itself. Rather than force every one of those tests to also stub
  // out a sidecar, a test that supplies a `modelClient` but no explicit
  // `agentOsProvider` gets one built from that SAME stub client, so an
  // AgentOS-eligible run (epic-staff-operations-coordinator@v1, tenant
  // AGENTOS_ALLOWED_TENANT, exposure INTERNAL — see OVERDUE_FIXTURE below)
  // observes byte-for-byte the same stub behaviour it always has. A test that
  // wants to exercise the real sidecar boundary (timeouts, malformed bodies,
  // auth failures, ...) passes its own `agentOsProvider` explicitly, which
  // this never overrides.
  const withAgentOs: AppDeps =
    withPaperclip.agentOsProvider !== undefined || withPaperclip.modelClient === undefined
      ? withPaperclip
      : { ...withPaperclip, agentOsProvider: createDirectModelExecutionProvider(withPaperclip.modelClient) };
  const runtime = createRuntime(withAgentOs);
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

/**
 * Carries `tenantId: AGENTOS_ALLOWED_TENANT` so every pre-existing test that
 * uses this fixture with `INTERNAL_TEMPLATE` (epic-staff-operations-
 * coordinator@v1) continues to clear the AgentOS allowlist gate exactly as it
 * did before that gate existed. See `startServer`'s `agentOsProvider` default
 * above for the other half of that guarantee.
 */
export const OVERDUE_FIXTURE = {
  issueId: "ISSUE-4821",
  tenantId: AGENTOS_ALLOWED_TENANT,
  fixture: "overdue-invoices",
  invoices: [
    { account: "ACC-1001", customer: "Northwind Freight", balance: "USD 4,120.00", dueDate: "2026-06-01" },
    { account: "ACC-1044", customer: "Brent Symes", balance: "USD 348.00", dueDate: "2026-07-15" },
  ],
};
