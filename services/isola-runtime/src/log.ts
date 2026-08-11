/**
 * Structured JSON logging. One line per event.
 *
 * No secret may ever be logged. Two defences:
 *  1. Call sites pass categories, not values.
 *  2. `redact()` below strips any key whose name looks credential-bearing, and
 *     any string value that looks like a bearer token.
 *
 * The model's answer is treated the same way. No call site logs `answerText`,
 * and `redact()` strips any field named that regardless — customer-facing reply
 * text has no business in an operational log line.
 */
import { SERVICE_NAME, SERVICE_VERSION } from "./version.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  event: string;
  correlationId?: string | null;
  runId?: string | null;
  agentId?: string | null;
  templateId?: string | null;
  outcome?: string | null;
  durationMs?: number | null;
  [key: string]: unknown;
}

export type Sink = (line: string) => void;

const SECRET_KEY_PATTERN =
  /(secret|password|passwd|api[_-]?key|apikey|authorization|auth[_-]?header|bearer|token|credential|answer[_-]?text)/i;

const BEARER_VALUE_PATTERN = /^(bearer\s+\S+|sk-[A-Za-z0-9_-]{8,})$/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return BEARER_VALUE_PATTERN.test(value.trim()) ? "[redacted]" : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export interface Logger {
  log(level: LogLevel, fields: LogFields): void;
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

export function createLogger(
  sink: Sink = (line) => process.stdout.write(line + "\n"),
  now: () => Date = () => new Date(),
): Logger {
  const emit = (level: LogLevel, fields: LogFields): void => {
    const base = {
      ts: now().toISOString(),
      level,
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      correlationId: null,
      runId: null,
      agentId: null,
      templateId: null,
      outcome: null,
      durationMs: null,
    };
    const merged = { ...base, ...(redact(fields) as Record<string, unknown>) };
    let line: string;
    try {
      line = JSON.stringify(merged);
    } catch {
      line = JSON.stringify({ ...base, event: "log_serialisation_failed" });
    }
    sink(line);
  };

  return {
    log: emit,
    info: (fields) => emit("info", fields),
    warn: (fields) => emit("warn", fields),
    error: (fields) => emit("error", fields),
  };
}
