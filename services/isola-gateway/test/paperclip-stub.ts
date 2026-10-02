/**
 * A local STUB Paperclip HTTP server for the PaperclipAgentRuntime seam tests.
 *
 * THE STUB IS NOT EVIDENCE OF INSTALLED BEHAVIOUR (Law 5). Its routes and fields
 * follow what the Workspace lane OBSERVED in the installed Paperclip 0.3.1 build
 * (relayed by Lane A, 2026-10-02): issue create accepts `idempotencyKey` (1-255),
 * `externalRef`, `assigneeAgentId`; `GET /issues/:id/comments` takes
 * `after/afterCommentId/limit/order`; `POST /heartbeat-runs/:runId/cancel` exists.
 * UNVERIFIED against the installed build and modelled here only as an assumption:
 *   - the `/api` path prefix on the comments route;
 *   - the response shape of create ({id, executionRunId}) and of the comment list;
 *   - that replay by the same idempotencyKey returns the original issue
 *     (`honourReplay`; the schema text says it does, the behaviour is unexercised);
 *   - that the run id is discoverable from the issue (`executionRunId`).
 * Both branches of the replay assumption are modelled so nothing depends on it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubIssue {
  id: string;
  idempotencyKey: string | null;
  assigneeAgentId: string | null;
  title: string;
  description: string;
  runId: string | null;
  comments: Array<{ id: string; body: string; authorAgentId: string | null }>;
}

export interface LoggedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | null;
}

export type CreateMode = "ok" | "401_task_bridge" | "403" | "500" | "drop_after_create" | "hang";

export class StubPaperclip {
  readonly issues = new Map<string, StubIssue>();
  readonly log: LoggedRequest[] = [];
  readonly cancelCalls: string[] = [];

  honourReplay = true;
  createMode: CreateMode = "ok";
  cancelStatus = 200;
  /** The run id the stub reports on a created issue; null = the run id is not discoverable. */
  runId: string | null = "run-1";
  /** Called right after an issue is created; the 'employee' may post comments from here. */
  onCreate: ((issue: StubIssue) => void) | null = null;
  /** Called on every comments poll with the 1-based poll count for that issue. */
  onPoll: ((issue: StubIssue, pollNumber: number) => void) | null = null;

  private readonly pollCounts = new Map<string, number>();
  private readonly byKey = new Map<string, string>();
  private nextId = 1;
  private nextCommentId = 1;
  private readonly sockets = new Set<import("node:net").Socket>();
  private server: Server | null = null;
  url = "";

  get creates(): LoggedRequest[] {
    return this.log.filter((r) => r.method === "POST" && /\/issues$/.test(r.url));
  }
  get polls(): LoggedRequest[] {
    return this.log.filter((r) => r.method === "GET" && r.url.includes("/comments"));
  }

  /** `authorAgentId` defaults to the issue's ASSIGNEE: the employee itself is the commenter. */
  postComment(issueId: string, body: string, authorAgentId?: string | null): void {
    const issue = this.issues.get(issueId);
    if (issue === undefined) throw new Error("stub: no such issue");
    issue.comments.push({
      id: `c-${this.nextCommentId++}`,
      body,
      authorAgentId: authorAgentId === undefined ? issue.assigneeAgentId : authorAgentId,
    });
  }

  /** An 'employee' that answers with the result envelope as soon as the issue exists. */
  replyOnCreate(envelope: unknown): void {
    this.onCreate = (issue) =>
      this.postComment(issue.id, typeof envelope === "string" ? envelope : JSON.stringify(envelope));
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (chunks.length === 0) return null;
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "";
    const method = req.method ?? "GET";
    const body = method === "GET" ? null : await this.readBody(req);
    this.log.push({ method, url, headers: { ...req.headers }, body });

    if (method === "POST" && /^\/api\/companies\/[^/]+\/issues$/.test(url)) {
      return this.create(req, res, body ?? {});
    }
    const comments = /^\/api\/issues\/([^/?]+)\/comments(\?.*)?$/.exec(url);
    if (method === "GET" && comments !== null) {
      const issue = this.issues.get(decodeURIComponent(comments[1]!));
      if (issue === undefined) return this.json(res, 404, { error: "not found" });
      const n = (this.pollCounts.get(issue.id) ?? 0) + 1;
      this.pollCounts.set(issue.id, n);
      this.onPoll?.(issue, n);
      const after = new URLSearchParams(comments[2] ?? "").get("after");
      let list = issue.comments;
      if (after !== null) {
        const idx = list.findIndex((c) => c.id === after);
        list = idx === -1 ? list : list.slice(idx + 1);
      }
      return this.json(res, 200, { comments: list });
    }
    const cancel = /^\/api\/heartbeat-runs\/([^/]+)\/cancel$/.exec(url);
    if (method === "POST" && cancel !== null) {
      this.cancelCalls.push(decodeURIComponent(cancel[1]!));
      return this.json(res, this.cancelStatus, { ok: this.cancelStatus < 300 });
    }
    return this.json(res, 404, { error: "stub: unknown route" });
  }

  private create(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): void {
    const mode = this.createMode;
    if (mode === "401_task_bridge") {
      return this.json(res, 401, { error: "Task bridge key cannot use this API action" });
    }
    if (mode === "403") return this.json(res, 403, { error: "forbidden" });
    if (mode === "500") return this.json(res, 500, { error: "boom" });
    if (mode === "hang") return; // never answers

    const key = typeof body["idempotencyKey"] === "string" ? (body["idempotencyKey"] as string) : null;
    let issue: StubIssue | undefined;
    if (key !== null && this.honourReplay && this.byKey.has(key)) {
      issue = this.issues.get(this.byKey.get(key)!);
    }
    const isNew = issue === undefined;
    if (issue === undefined) {
      issue = {
        id: `iss-${this.nextId++}`,
        idempotencyKey: key,
        assigneeAgentId: typeof body["assigneeAgentId"] === "string" ? (body["assigneeAgentId"] as string) : null,
        title: String(body["title"] ?? ""),
        description: String(body["description"] ?? ""),
        runId: this.runId,
        comments: [],
      };
      this.issues.set(issue.id, issue);
      if (key !== null) this.byKey.set(key, issue.id);
    }
    if (mode === "drop_after_create") {
      if (isNew) this.onCreate?.(issue);
      req.socket.destroy(); // the issue exists; the caller never learns it
      return;
    }
    if (isNew) this.onCreate?.(issue);
    this.json(res, 201, { id: issue.id, title: issue.title, executionRunId: issue.runId });
  }
}
