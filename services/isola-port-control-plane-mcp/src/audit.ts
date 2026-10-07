/**
 * audit.ts
 *
 * Append-only JSONL audit log at data/audit.log. One line per tool
 * invocation. Never writes secrets or full response bodies — only a
 * sha256 hash of the request params and a result count.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface AuditEntry {
  timestamp: string;
  tool: string;
  callerRef: string;
  paramsHash: string;
  resultCount: number;
  ok: boolean;
}

export function hashParams(params: unknown): string {
  const json = JSON.stringify(params ?? {});
  return createHash("sha256").update(json).digest("hex");
}

export interface AuditLogger {
  record(entry: Omit<AuditEntry, "timestamp">): Promise<void>;
}

export class JsonlAuditLogger implements AuditLogger {
  constructor(private filePath: string) {}

  async record(entry: Omit<AuditEntry, "timestamp">): Promise<void> {
    const full: AuditEntry = { timestamp: new Date().toISOString(), ...entry };
    const line = JSON.stringify(full) + "\n";
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, line, "utf8");
    } catch {
      // Audit logging must never crash a tool call. Swallow write errors
      // (e.g. read-only filesystem in some deploy) — the tool response
      // itself is unaffected.
    }
  }
}

/** callerRef must be a stable, NON-secret reference — never the raw bearer token. */
export function callerRefFromToken(token: string | undefined, sessionId?: string): string {
  if (sessionId) return `session:${sessionId}`;
  if (!token) return "anonymous";
  const hash = createHash("sha256").update(token).digest("hex").slice(0, 12);
  return `token:${hash}`;
}

