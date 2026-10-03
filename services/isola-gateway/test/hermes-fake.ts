/**
 * A FAKE Hermes `/v1/runs` service for the direct-runtime tests: an in-process `SafeFetch`,
 * NO SOCKET. It models what lane 59's contract file says the service does, read from the
 * running service's own code (Hermes Agent v0.16.0 api_server.py), NOT yet exercised end to
 * end (Step B):
 *
 *   POST /v1/runs                  202 {"run_id","status":"started"}; 401 wrong key; 400 no input;
 *                                  429 when the concurrency cap is reached. A run counts against
 *                                  the cap from creation until its SSE stream is READ TO THE END
 *                                  (a client that cancels the stream does NOT free it; the real
 *                                  service sweeps after 300 s, which this fake does not model).
 *   GET  /v1/runs/{id}             the pollable status object; 404 for an unknown or "lost" run.
 *   GET  /v1/runs/{id}/events      SSE: `data: {json}\n\n`, `: keepalive`, ends `: stream closed`.
 *   POST /v1/runs/{id}/stop        200 {"run_id","status":"stopping"} for an active run; 404 else.
 *   /v1/runs ignores Idempotency-Key (code says so): a replay would start a SECOND run, which
 *   is exactly what the tests assert the adapter never causes.
 *
 * THE FAKE IS NOT EVIDENCE OF INSTALLED BEHAVIOUR (Law 5).
 */
import type { SafeFetch } from "../src/egress.js";

export interface LoggedRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  at: number;
}

const CLOSE = Symbol("close");
const BREAK = Symbol("break");
type Chunk = string | typeof CLOSE | typeof BREAK;

export type CreatePlan =
  | number // an HTTP status for the create: 429, 500, 401, 403, 404, 400
  | "drop" // the run IS created, then the connection dies before any response
  | "no_run_id" // 202 with no run_id
  | "hang" // never answers
  | "redirect" // a 307
  | "big"; // a 202 whose body exceeds the byte cap

const enc = new TextEncoder();

export class FakeRun {
  status: "queued" | "running" | "waiting_for_approval" | "stopping" | "completed" | "failed" | "cancelled" = "queued";
  output: string | null = null;
  error: string | null = null;
  lost = false;
  drained = false;
  streamAttached = 0;
  streamCancelled = false;
  readonly stopCalls: number[] = [];
  private readonly queue: Chunk[] = [];
  private wake: (() => void) | null = null;

  constructor(
    readonly id: string,
    readonly body: Record<string, unknown>,
    readonly headers: Record<string, string>,
  ) {}

  get terminal(): boolean {
    return this.status === "completed" || this.status === "failed" || this.status === "cancelled";
  }

  push(chunk: Chunk): void {
    this.queue.push(chunk);
    this.wake?.();
  }

  event(name: string, extra: Record<string, unknown> = {}): void {
    this.push(`data: ${JSON.stringify({ event: name, run_id: this.id, timestamp: 1, ...extra })}\n\n`);
  }

  running(): void {
    this.status = "running";
  }

  delta(text: string): void {
    this.event("message.delta", { delta: text });
  }

  /** Complete the run: status + (optionally) the run.completed event + the clean stream close. */
  complete(output: string, opts: { statusOutput?: boolean; eventOutput?: string; closeStream?: boolean } = {}): void {
    this.status = "completed";
    this.output = opts.statusOutput === false ? "" : output;
    this.event("run.completed", { output: opts.eventOutput ?? output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    if (opts.closeStream !== false) this.push(": stream closed\n\n"), this.push(CLOSE);
  }

  /** Close the stream cleanly (after a terminal status that was set without its events). */
  finishStream(): void {
    this.push(": stream closed\n\n");
    this.push(CLOSE);
  }

  fail(error: string): void {
    this.status = "failed";
    this.error = error;
    this.event("run.failed", { error });
    this.push(": stream closed\n\n");
    this.push(CLOSE);
  }

  cancel(): void {
    this.status = "cancelled";
    this.event("run.cancelled");
    this.push(": stream closed\n\n");
    this.push(CLOSE);
  }

  /** Close the stream cleanly WITHOUT any terminal event (an anomaly). */
  closeWithoutTerminal(): void {
    this.push(": stream closed\n\n");
    this.push(CLOSE);
  }

  /** An ORDINARY end of the stream (EOF) with no terminal event and no `: stream closed` comment (Codex DH5). */
  eof(): void {
    this.push(CLOSE);
  }

  /** The connection dies mid-stream. */
  breakStream(): void {
    this.push(BREAK);
  }

  statusObject(): Record<string, unknown> {
    return {
      object: "hermes.run",
      run_id: this.id,
      status: this.status,
      created_at: 1,
      updated_at: 2,
      session_id: this.body["session_id"] ?? this.id,
      last_event: null,
      ...(this.status === "completed" ? { output: this.output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } : {}),
      ...(this.status === "failed" ? { error: this.error } : {}),
    };
  }

  /** A readable SSE body that follows this run's queue. Reading it to the end marks the run drained. */
  streamBody(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
    this.streamAttached += 1;
    const self = this;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          if (signal?.aborted === true) {
            self.streamCancelled = true;
            controller.error(new DOMException("aborted", "AbortError"));
            return;
          }
          const next = self.queue.shift();
          if (next === undefined) {
            await new Promise<void>((resolve) => {
              self.wake = resolve;
              signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            self.wake = null;
            continue;
          }
          if (next === CLOSE) {
            self.drained = true;
            controller.close();
            return;
          }
          if (next === BREAK) {
            controller.error(new Error("stream broke"));
            return;
          }
          controller.enqueue(enc.encode(next));
          return;
        }
      },
      cancel() {
        self.streamCancelled = true; // a cancelled stream does NOT free the cap slot (contract s.5)
      },
    });
  }
}

export class FakeHermes {
  readonly log: LoggedRequest[] = [];
  readonly runs = new Map<string, FakeRun>();
  bearer = "not-a-real-hermes-key-0000000000000000";
  cap = 10;
  createDelayMs = 0;
  createPlan: CreatePlan[] = [];
  /** Consumed per GET /v1/runs/{id}: a forced status, an oversized body, or a hang. */
  pollPlan: Array<number | "big" | "hang"> = [];
  /** Consumed per GET /v1/runs/{id}/events: a forced HTTP status (404, 401, 500) instead of a stream (Codex DH5). */
  eventsPlan: number[] = [];
  /** When set, every status object reports THIS run id (a non-current run). */
  statusRunIdOverride: string | null = null;
  stopStatus = 200;
  stopDelayMs = 5;
  /** Scripts a run right after it is created (the "employee"). */
  onRun: ((run: FakeRun) => void) | null = null;
  /** Observed by tests: the run id of the most recent create. */
  private counter = 0;

  get creates(): LoggedRequest[] {
    return this.log.filter((r) => r.method === "POST" && r.path === "/v1/runs");
  }
  get stops(): LoggedRequest[] {
    return this.log.filter((r) => r.method === "POST" && /^\/v1\/runs\/[^/]+\/stop$/.test(r.path));
  }
  get polls(): LoggedRequest[] {
    return this.log.filter((r) => r.method === "GET" && /^\/v1\/runs\/[^/]+$/.test(r.path));
  }
  get streams(): LoggedRequest[] {
    return this.log.filter((r) => r.method === "GET" && /^\/v1\/runs\/[^/]+\/events$/.test(r.path));
  }
  /** Runs still counted against the concurrency cap. */
  get counted(): number {
    return [...this.runs.values()].filter((r) => !r.drained).length;
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  readonly fetch: SafeFetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const u = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    this.log.push({ method, url, path: u.pathname, headers, body, at: Date.now() });
    const signal = init?.signal ?? undefined;
    if (signal?.aborted === true) throw new DOMException("aborted", "AbortError");

    if (headers["authorization"] !== `Bearer ${this.bearer}`) {
      return this.json(401, { error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" } });
    }

    if (method === "POST" && u.pathname === "/v1/runs") return this.create(body, headers, signal);

    const status = /^\/v1\/runs\/([^/]+)$/.exec(u.pathname);
    if (method === "GET" && status !== null) {
      const run = this.runs.get(status[1]!);
      const plan = this.pollPlan.shift();
      if (plan === "big") return new Response("x".repeat(1024 * 1024 + 10), { status: 200, headers: { "content-type": "application/json" } });
      if (plan === "hang") {
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      if (typeof plan === "number") return this.json(plan, { error: { message: `fake: forced ${plan}` } });
      if (run === undefined || run.lost) return this.json(404, { error: { message: `Run not found: ${status[1]}`, code: "run_not_found" } });
      const object = run.statusObject();
      if (this.statusRunIdOverride !== null) object["run_id"] = this.statusRunIdOverride;
      return this.json(200, object);
    }
    const events = /^\/v1\/runs\/([^/]+)\/events$/.exec(u.pathname);
    if (method === "GET" && events !== null) {
      const run = this.runs.get(events[1]!);
      const forced = this.eventsPlan.shift();
      if (typeof forced === "number") return this.json(forced, { error: { message: `fake: events forced ${forced}` } });
      if (run === undefined) return this.json(404, { error: { message: "Run not found", code: "run_not_found" } });
      return new Response(run.streamBody(signal), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const stop = /^\/v1\/runs\/([^/]+)\/stop$/.exec(u.pathname);
    if (method === "POST" && stop !== null) {
      const run = this.runs.get(stop[1]!);
      run?.stopCalls.push(Date.now());
      if (this.stopStatus !== 200) return this.json(this.stopStatus, { error: { message: "stub forced status" } });
      if (run === undefined || run.terminal) return this.json(404, { error: { message: "Run not found", code: "run_not_found" } });
      run.status = "stopping";
      setTimeout(() => run.cancel(), this.stopDelayMs);
      return this.json(200, { run_id: run.id, status: "stopping" });
    }
    return this.json(404, { error: { message: "fake: unknown route" } });
  };

  private async create(body: Record<string, unknown> | null, headers: Record<string, string>, signal: AbortSignal | undefined): Promise<Response> {
    if (this.createDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.createDelayMs));
    if (body === null || (typeof body["input"] !== "string" && !Array.isArray(body["input"]))) {
      return this.json(400, { error: { message: "Missing 'input' field", type: "invalid_request_error" } });
    }
    const plan = this.createPlan.shift();
    if (typeof plan === "number") return this.json(plan, { error: { message: `fake: forced ${plan}`, code: plan === 429 ? "rate_limit_exceeded" : "forced" } });
    if (plan === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    if (plan === "redirect") return new Response(null, { status: 307, headers: { location: "https://elsewhere.example.test/v1/runs" } });
    if (this.counted >= this.cap) {
      return this.json(429, { error: { message: `Too many concurrent runs (max ${this.cap})`, type: "rate_limit_error", code: "rate_limit_exceeded" } });
    }
    this.counter += 1;
    const id = `run_${this.counter.toString(16).padStart(32, "0")}`;
    const run = new FakeRun(id, body, headers);
    this.runs.set(id, run);
    queueMicrotask(() => this.onRun?.(run));
    if (plan === "drop") throw new TypeError("fetch failed");
    if (plan === "no_run_id") return this.json(202, { status: "started" });
    if (plan === "big") return new Response("x".repeat(1024 * 1024 + 10), { status: 202, headers: { "content-type": "application/json" } });
    return this.json(202, { run_id: id, status: "started" });
  }
}
