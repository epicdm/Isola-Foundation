/**
 * Test harness. Every test builds its own app from an explicit env record, so
 * no test depends on the ambient process environment.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApp, type AppDeps } from "../src/app.js";
import { loadConfig, type EnvRecord, type RuntimeConfig } from "../src/config.js";
import { createLogger, type Logger } from "../src/log.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../src/model.js";
import type { RunOutcome, RunRecorder } from "../src/recorder.js";

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

export interface TestServer {
  url: string;
  close(): Promise<void>;
}

export async function startServer(deps: AppDeps): Promise<TestServer> {
  const server: Server = createServer(createApp(deps));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
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
