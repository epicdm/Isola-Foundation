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

  private async request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body: unknown,
    call: PaperclipCall,
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
    if (call.runId !== null && call.runId.length > 0) {
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

    if (method === "GET") {
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
}

export function createPaperclipApi(args: {
  baseUrl: string | null;
  safeFetch: SafeFetch;
}): PaperclipApi | null {
  if (args.baseUrl === null) return null;
  return new HttpPaperclipApi({ baseUrl: args.baseUrl, safeFetch: args.safeFetch });
}
