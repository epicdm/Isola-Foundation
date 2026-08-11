/**
 * The Paperclip REST client.
 *
 * Every call goes through the injected `SafeFetch`, so the Paperclip host has
 * to be on the egress allowlist like any other. Nothing here calls the platform
 * network primitive directly.
 *
 * VERIFIED CONTRACTS (deployed Paperclip commit 8af38fb)
 * ------------------------------------------------------
 *  - Auth is the **employee's own agent API key**, `Authorization: Bearer <key>`.
 *    Agent actors are company-scoped and a cost event is rejected with 403
 *    unless its `agentId` equals the calling agent. Agent API keys never expire.
 *  - `X-Paperclip-Run-Id: <runId>` is a real header, read by Paperclip's auth
 *    middleware. It is sent on every call this client makes.
 *  - Issue transition: PATCH /api/issues/{issueId}  body {"status": "<status>"}
 *  - Comment:          POST  /api/issues/{issueId}/comments  body {"body": md}
 *  - Cost event:       POST  /api/companies/{companyId}/cost-events -> 201
 *  - Budget read:      GET   /api/agents/{agentId}
 *                      GET   /api/companies/{companyId}/budgets/overview
 *  - Pause:            POST  /api/agents/{agentId}/pause
 *  - Issue create:     POST  /api/companies/{companyId}/issues -> 201, the issue
 *  - Issue list:       GET   /api/companies/{companyId}/issues -> array
 *
 * `createIssueSchema` (packages/shared/src/validators/issue.ts) accepts
 * title / description / status / priority / assigneeAgentId and a set of uuid
 * relations. It has NO free-form `metadata` field, so an external key can only
 * be carried in the title — see `src/conversation.ts` for the marker it uses and
 * why the title is the only place it can live.
 */
import type { SafeFetch } from "./egress.js";
import { EgressBlockedError, PaperclipApiError } from "./errors.js";
import type { CostEventPayload } from "./state.js";

/** The statuses Paperclip accepts on PATCH /api/issues/{id}. */
export const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
] as const;

export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export function isIssueStatus(value: unknown): value is IssueStatus {
  return typeof value === "string" && (ISSUE_STATUSES as readonly string[]).includes(value);
}

/** The priorities Paperclip accepts on POST /api/companies/{id}/issues. */
export const ISSUE_PRIORITIES = ["critical", "high", "medium", "low"] as const;

export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

/** The subset of an issue this service reads back. Never the whole record. */
export interface IssueSummary {
  id: string;
  title: string;
  status: string | null;
}

/**
 * What this service is allowed to put on a new issue.
 *
 * Deliberately narrow: no assignee of any kind, because an assigned actionable
 * issue is exactly what makes Paperclip re-schedule the employee. `assigneeAgentId`
 * exists in the API and is not offered here.
 */
export interface CreateIssueInput {
  title: string;
  description: string;
  status: IssueStatus;
  priority: IssuePriority;
}

export interface ListIssuesQuery {
  /** Free-text search. Paperclip matches it against the title, among others. */
  q?: string;
  /** Comma-separated status filter, e.g. "backlog". */
  status?: string;
  limit?: number;
}

/** Per-call identity: which agent key to present, and which run to attribute. */
export interface PaperclipCall {
  apiKey: string;
  runId: string | null;
}

export interface AgentBudget {
  budgetMonthlyCents: number | null;
  spentMonthlyCents: number;
}

export interface PaperclipApi {
  postComment(issueId: string, body: string, call: PaperclipCall): Promise<void>;
  patchIssueStatus(
    issueId: string,
    status: IssueStatus,
    call: PaperclipCall,
    extra?: Record<string, unknown>,
  ): Promise<void>;
  postCostEvent(
    companyId: string,
    event: CostEventPayload,
    call: PaperclipCall,
  ): Promise<void>;
  getAgentBudget(agentId: string, call: PaperclipCall): Promise<AgentBudget>;
  pauseAgent(agentId: string, call: PaperclipCall): Promise<void>;
  listIssues(
    companyId: string,
    query: ListIssuesQuery,
    call: PaperclipCall,
  ): Promise<IssueSummary[]>;
  createIssue(
    companyId: string,
    input: CreateIssueInput,
    call: PaperclipCall,
  ): Promise<IssueSummary>;
}

export interface HttpPaperclipApiOptions {
  baseUrl: string;
  safeFetch: SafeFetch;
  timeoutMs?: number;
}

const DEFAULT_CALL_TIMEOUT_MS = 15_000;

/** 5xx, 408 and 429 can succeed later. Everything else in 4xx cannot. */
export function isRetryableStatus(status: number): boolean {
  if (status >= 500) return true;
  return status === 408 || status === 429;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class HttpPaperclipApi implements PaperclipApi {
  private readonly baseUrl: string;
  private readonly safeFetch: SafeFetch;
  private readonly timeoutMs: number;

  constructor(options: HttpPaperclipApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.safeFetch = options.safeFetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  /**
   * Paperclip returns a bare 500 whenever `X-Paperclip-Run-Id` names a run it cannot
   * resolve — verified live: no header => 201, non-UUID => 500, well-formed but unknown
   * UUID => 500. In normal operation Paperclip hands us a real run id and this never
   * fires, but a stale or replayed run id would otherwise destroy the employee's output
   * on every callback. Losing the work is far worse than losing the run attribution, so
   * a 500 on a run-id-bearing call is retried once without the header.
   */
  private async request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body: unknown,
    call: PaperclipCall,
    /** Parse and return the response body. Implied for GET. */
    wantsJson = false,
  ): Promise<unknown> {
    try {
      return await this.attempt(method, path, body, call, true, wantsJson);
    } catch (err) {
      const retryWithoutRunId =
        err instanceof PaperclipApiError &&
        err.status === 500 &&
        call.runId !== null &&
        call.runId.length > 0;
      if (!retryWithoutRunId) throw err;
      return await this.attempt(method, path, body, call, false, wantsJson);
    }
  }

  private async attempt(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body: unknown,
    call: PaperclipCall,
    includeRunId: boolean,
    wantsJson = false,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${call.apiKey}`,
    };
    // Paperclip's own agent guidance is to send this on every mutating call.
    // Sending it on reads too costs nothing and keeps the audit trail complete.
    if (includeRunId && call.runId !== null && call.runId.length > 0) {
      headers["x-paperclip-run-id"] = call.runId;
    }
    if (body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await this.safeFetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut) throw new PaperclipApiError("call timed out", null, true);
      if (err instanceof EgressBlockedError) {
        throw new PaperclipApiError(
          "paperclip host is not on the egress allowlist",
          null,
          false,
        );
      }
      const name = err instanceof Error ? err.name : "unknown";
      throw new PaperclipApiError(`transport failure (${name})`, null, true);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Status class only. The body can echo the request content.
      throw new PaperclipApiError(
        `returned HTTP ${response.status}`,
        response.status,
        isRetryableStatus(response.status),
      );
    }

    if (method === "GET" || wantsJson) {
      try {
        return await response.json();
      } catch {
        throw new PaperclipApiError("returned a non-JSON body", response.status, true);
      }
    }
    return null;
  }

  async postComment(issueId: string, body: string, call: PaperclipCall): Promise<void> {
    await this.request(
      "POST",
      `/api/issues/${encodeURIComponent(issueId)}/comments`,
      { body },
      call,
    );
  }

  async patchIssueStatus(
    issueId: string,
    status: IssueStatus,
    call: PaperclipCall,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    await this.request(
      "PATCH",
      `/api/issues/${encodeURIComponent(issueId)}`,
      { status, ...(extra ?? {}) },
      call,
    );
  }

  async postCostEvent(
    companyId: string,
    event: CostEventPayload,
    call: PaperclipCall,
  ): Promise<void> {
    await this.request(
      "POST",
      `/api/companies/${encodeURIComponent(companyId)}/cost-events`,
      event,
      call,
    );
  }

  async getAgentBudget(agentId: string, call: PaperclipCall): Promise<AgentBudget> {
    const payload = await this.request(
      "GET",
      `/api/agents/${encodeURIComponent(agentId)}`,
      undefined,
      call,
    );
    const record =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)
        : {};
    // Paperclip has returned the agent either bare or wrapped; accept both
    // rather than mis-reading a budget as "unlimited".
    const inner =
      typeof record["agent"] === "object" && record["agent"] !== null
        ? (record["agent"] as Record<string, unknown>)
        : record;
    return {
      budgetMonthlyCents: numberOrNull(inner["budgetMonthlyCents"]),
      spentMonthlyCents: numberOrNull(inner["spentMonthlyCents"]) ?? 0,
    };
  }

  async pauseAgent(agentId: string, call: PaperclipCall): Promise<void> {
    await this.request(
      "POST",
      `/api/agents/${encodeURIComponent(agentId)}/pause`,
      {},
      call,
    );
  }

  async listIssues(
    companyId: string,
    query: ListIssuesQuery,
    call: PaperclipCall,
  ): Promise<IssueSummary[]> {
    const params = new URLSearchParams();
    if (query.q !== undefined && query.q.length > 0) params.set("q", query.q);
    if (query.status !== undefined && query.status.length > 0) {
      params.set("status", query.status);
    }
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    const queryString = params.toString();
    const suffix = queryString.length > 0 ? `?${queryString}` : "";
    const payload = await this.request(
      "GET",
      `/api/companies/${encodeURIComponent(companyId)}/issues${suffix}`,
      undefined,
      call,
    );
    return parseIssueList(payload);
  }

  async createIssue(
    companyId: string,
    input: CreateIssueInput,
    call: PaperclipCall,
  ): Promise<IssueSummary> {
    const payload = await this.request(
      "POST",
      `/api/companies/${encodeURIComponent(companyId)}/issues`,
      {
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
      },
      call,
      true,
    );
    const issue = parseIssueSummary(payload);
    if (issue === null) {
      // A 2xx with no readable issue id is worse than an error: the caller
      // would have to guess which issue it just made. Refuse instead.
      throw new PaperclipApiError(
        "issue create returned no readable issue id",
        null,
        false,
      );
    }
    return issue;
  }
}

/**
 * Read one issue out of a Paperclip payload.
 *
 * Tolerant about the envelope (bare object, or wrapped in `issue`/`data`) and
 * strict about the one field that matters: without a non-empty string `id` this
 * returns null and the caller fails loudly rather than acting on a guess.
 */
export function parseIssueSummary(payload: unknown): IssueSummary | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const inner =
    typeof record["issue"] === "object" && record["issue"] !== null
      ? (record["issue"] as Record<string, unknown>)
      : typeof record["data"] === "object" && record["data"] !== null
        ? (record["data"] as Record<string, unknown>)
        : record;
  const id = inner["id"];
  if (typeof id !== "string" || id.length === 0) return null;
  return {
    id,
    title: typeof inner["title"] === "string" ? inner["title"] : "",
    status: typeof inner["status"] === "string" ? inner["status"] : null,
  };
}

/** The list endpoint returns a bare array; accept the common envelopes too. */
export function parseIssueList(payload: unknown): IssueSummary[] {
  const array = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null
      ? (() => {
          const record = payload as Record<string, unknown>;
          for (const key of ["issues", "data", "items", "results"]) {
            const value = record[key];
            if (Array.isArray(value)) return value;
          }
          return null;
        })()
      : null;
  if (array === null) return [];
  const out: IssueSummary[] = [];
  for (const entry of array) {
    const issue = parseIssueSummary(entry);
    if (issue !== null) out.push(issue);
  }
  return out;
}

export function createPaperclipApi(args: {
  baseUrl: string | null;
  safeFetch: SafeFetch;
}): PaperclipApi | null {
  if (args.baseUrl === null) return null;
  return new HttpPaperclipApi({ baseUrl: args.baseUrl, safeFetch: args.safeFetch });
}
