/**
 * tools.ts
 *
 * The 10 read-only MCP tools exposed by this server. Every tool follows
 * the same pipeline:
 *
 *   read-only PortClient call -> allowlist filter -> redaction
 *     -> audit log write -> paginate/size-cap -> return
 *
 * Every tool handles a Port outage gracefully (never throws) by
 * returning { status: "port_unavailable_or_stale", detail: ... }.
 */

import { PortClient, type PortOutageResult } from "./portClient.js";
import { sanitizeEntities, sanitizeEntity, isAllowlistedBlueprint, ALLOWLISTED_BLUEPRINTS } from "./redact.js";
import { clampPagination, capResponseSize, type PaginationInput } from "./auth.js";
import { hashParams, type AuditLogger } from "./audit.js";
import { RELEASE_TRAIN_01, findGate, type GateDefinition } from "./releaseTrain01.js";

export function isOutage(x: unknown): x is PortOutageResult {
  return Boolean(x && typeof x === "object" && (x as Record<string, unknown>).status === "port_unavailable_or_stale");
}

const STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function isStale(updatedAt: unknown): boolean {
  if (typeof updatedAt !== "string") return true;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > STALE_MS;
}

export interface ToolContext {
  client: PortClient;
  audit: AuditLogger;
  callerRef: string;
}

export async function withAudit<T>(
  ctx: ToolContext,
  toolName: string,
  params: unknown,
  fn: () => Promise<T>
): Promise<T> {
  let ok = true;
  let resultCount = 0;
  try {
    const result = await fn();
    if (Array.isArray((result as any)?.rows)) resultCount = (result as any).rows.length;
    else if (Array.isArray((result as any)?.items)) resultCount = (result as any).items.length;
    else if (Array.isArray(result)) resultCount = (result as unknown[]).length;
    else resultCount = result ? 1 : 0;
    return result;
  } catch (err) {
    ok = false;
    throw err;
  } finally {
    await ctx.audit.record({
      tool: toolName,
      callerRef: ctx.callerRef,
      paramsHash: hashParams(params),
      resultCount,
      ok
    });
  }
}

export function extractEntityArray(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    const rec = json as Record<string, unknown>;
    if (Array.isArray(rec.entities)) return rec.entities;
    if (Array.isArray(rec.entity)) return rec.entity;
    if (rec.entity && typeof rec.entity === "object") return [rec.entity];
  }
  return [];
}

// ---------------------------------------------------------------------
// get_release_board
// ---------------------------------------------------------------------
export interface ReleaseBoardRow {
  gate: string;
  status: string;
  owner: string;
  evidenceRefs: string[];
  blocker: string | null;
  nextAction: string;
}

async function lookupEntityStatus(client: PortClient, ref: { id: string; blueprint: string }): Promise<Record<string, unknown> | PortOutageResult> {
  const result = await client.getEntity(ref.blueprint, ref.id);
  if (isOutage(result)) return result;
  const entity = (result.data as Record<string, unknown> | null) ?? null;
  const arr = extractEntityArray(entity ?? result.data);
  const found = arr.length ? arr[0] : (result.data as Record<string, unknown> | null);
  const sanitized = found ? sanitizeEntity(found) : null;
  return sanitized ?? { status: "unknown" };
}

function deriveGateStatus(entityStates: Record<string, unknown>[]): string {
  if (!entityStates.length) return "unknown";
  const statuses = entityStates.map((e) => String((e as any).status ?? (e as any).properties?.status ?? "unknown").toLowerCase());
  if (statuses.some((s) => s === "blocked")) return "blocked";
  if (statuses.every((s) => s === "done" || s === "verified" || s === "closed")) return "green";
  if (statuses.some((s) => s === "backlog" || s === "todo" || s === "open")) return "open";
  return "in_progress";
}

export async function getReleaseBoard(ctx: ToolContext): Promise<{ rows: ReleaseBoardRow[] } | PortOutageResult> {
  return withAudit(ctx, "get_release_board", {}, async () => {
    const rows: ReleaseBoardRow[] = [];
    let anyOutage = false;

    for (const gate of RELEASE_TRAIN_01) {
      if (gate.entities.length === 0) {
        rows.push({
          gate: gate.gateName,
          status: "unknown",
          owner: "unassigned",
          evidenceRefs: [],
          blocker: gate.note ?? null,
          nextAction: "Create a tracking entity in Port for this gate."
        });
        continue;
      }
      const states: Record<string, unknown>[] = [];
      for (const ref of gate.entities) {
        const st = await lookupEntityStatus(ctx.client, ref);
        if (isOutage(st)) {
          anyOutage = true;
          continue;
        }
        states.push(st);
      }
      const status = deriveGateStatus(states);
      const blockerEntity = states.find((s) => String((s as any).status ?? "").toLowerCase() === "blocked");
      rows.push({
        gate: gate.gateName,
        status,
        owner: "unassigned",
        evidenceRefs: gate.entities.map((e) => e.id),
        blocker: blockerEntity ? String((blockerEntity as any).identifier ?? (blockerEntity as any).$identifier ?? "blocked") : null,
        nextAction: status === "green" ? "None — gate satisfied." : `Progress ${gate.entities.map((e) => e.id).join(", ")}.`
      });
    }

    if (anyOutage && !ctx.client.hasCredentials()) {
      // No live creds at all in this environment — every lookup was an
      // outage. Return the board built purely from static definitions
      // plus an outage marker per spec, rather than pretending we have
      // live status.
      return {
        status: "port_unavailable_or_stale",
        detail: "Port API unreachable; data unavailable"
      } as PortOutageResult;
    }

    return { rows };
  });
}

// ---------------------------------------------------------------------
// list_open_gates
// ---------------------------------------------------------------------
export async function listOpenGates(ctx: ToolContext): Promise<{ rows: (ReleaseBoardRow & { dependencyNote: string })[] } | PortOutageResult> {
  return withAudit(ctx, "list_open_gates", {}, async () => {
    const board = await getReleaseBoard(ctx);
    if (isOutage(board)) return board;
    const rows = board.rows
      .filter((r) => r.status !== "green")
      .map((r) => ({
        ...r,
        dependencyNote: r.evidenceRefs.length
          ? `Depends on Port entities: ${r.evidenceRefs.join(", ")}`
          : "No Port entity tracks this gate yet."
      }));
    return { rows };
  });
}

// ---------------------------------------------------------------------
// get_gate_evidence
// ---------------------------------------------------------------------
export interface GateEvidenceItem {
  id: string;
  blueprint: string;
  description: string | null;
  evidenceType: string | null;
  updatedAt: string | null;
  stale: boolean;
}

export async function getGateEvidence(ctx: ToolContext, gateId: string): Promise<{ gate: string; evidence: GateEvidenceItem[]; note?: string } | PortOutageResult | { error: string }> {
  return withAudit(ctx, "get_gate_evidence", { gateId }, async () => {
    const gate = findGate(gateId);
    if (!gate) {
      return { error: `Unknown gate id: ${gateId}` };
    }
    if (gate.entities.length === 0) {
      return { gate: gate.gateName, evidence: [], note: gate.note ?? "No Port entity tracks this gate yet." };
    }
    const evidence: GateEvidenceItem[] = [];
    let anyOutage = false;
    for (const ref of gate.entities) {
      const result = await ctx.client.getEntity(ref.blueprint, ref.id);
      if (isOutage(result)) {
        anyOutage = true;
        continue;
      }
      const arr = extractEntityArray(result.data);
      const raw = arr.length ? arr[0] : result.data;
      const sanitized = raw ? sanitizeEntity(raw) : null;
      if (!sanitized) continue;
      const props = (sanitized.properties as Record<string, unknown>) ?? {};
      const updatedAt = (sanitized.$updatedAt as string) ?? (sanitized.updatedAt as string) ?? null;
      evidence.push({
        id: ref.id,
        blueprint: ref.blueprint,
        description: (props.description as string) ?? (sanitized.description as string) ?? null,
        evidenceType: (props.evidence_type as string) ?? null,
        updatedAt,
        stale: isStale(updatedAt)
      });
    }
    if (anyOutage && evidence.length === 0 && !ctx.client.hasCredentials()) {
      return { status: "port_unavailable_or_stale", detail: "Port API unreachable; data unavailable" } as PortOutageResult;
    }
    return { gate: gate.gateName, evidence };
  });
}

// ---------------------------------------------------------------------
// list_open_blockers
// ---------------------------------------------------------------------
const BLOCKER_RANK_PREFIXES = [
  "bt-release-control",
  "bt-device-b",
  "bt-clawith",
  "bt-pr22",
  "bt-pilot-consent"
];

function rankBlocker(id: string): number {
  const idx = BLOCKER_RANK_PREFIXES.findIndex((p) => id.startsWith(p));
  return idx === -1 ? BLOCKER_RANK_PREFIXES.length : idx;
}

export async function listOpenBlockers(ctx: ToolContext, pagination?: PaginationInput): Promise<{ rows: Record<string, unknown>[] } | PortOutageResult> {
  return withAudit(ctx, "list_open_blockers", pagination, async () => {
    const clamped = clampPagination(pagination);

    const defectsResult = await ctx.client.listEntities("defect", { limit: clamped.limit });
    const tasksResult = await ctx.client.listEntities("build_task", { limit: clamped.limit });

    if (isOutage(defectsResult) && isOutage(tasksResult)) {
      return { status: "port_unavailable_or_stale", detail: "Port API unreachable; data unavailable" } as PortOutageResult;
    }

    const rows: Record<string, unknown>[] = [];

    if (!isOutage(defectsResult)) {
      const defects = sanitizeEntities(extractEntityArray(defectsResult.data)).filter(
        (e) => String((e.properties as any)?.status ?? e.status ?? "").toLowerCase() === "open"
      );
      rows.push(...defects);
    }
    if (!isOutage(tasksResult)) {
      const tasks = sanitizeEntities(extractEntityArray(tasksResult.data)).filter((e) => {
        const props = (e.properties as Record<string, unknown>) ?? {};
        const status = String(props.status ?? e.status ?? "").toLowerCase();
        const priority = String(props.priority ?? e.priority ?? "");
        return status === "backlog" && priority === "P0-MVP";
      });
      rows.push(...tasks);
    }

    rows.sort((a, b) => {
      const idA = String(a.identifier ?? a.$identifier ?? "");
      const idB = String(b.identifier ?? b.$identifier ?? "");
      return rankBlocker(idA) - rankBlocker(idB);
    });

    return { rows: rows.slice(0, clamped.limit) };
  });
}

// ---------------------------------------------------------------------
// list_decisions
// ---------------------------------------------------------------------
export async function listDecisions(ctx: ToolContext, pagination?: PaginationInput): Promise<{ rows: Record<string, unknown>[] } | PortOutageResult> {
  return withAudit(ctx, "list_decisions", pagination, async () => {
    const clamped = clampPagination(pagination);
    const result = await ctx.client.listEntities("decision", { limit: clamped.limit, offset: clamped.offset });
    if (isOutage(result)) return result;
    const rows = sanitizeEntities(extractEntityArray(result.data));
    rows.sort((a, b) => {
      const da = String((a.properties as any)?.decided_at ?? a.$updatedAt ?? "");
      const db = String((b.properties as any)?.decided_at ?? b.$updatedAt ?? "");
      return db.localeCompare(da);
    });
    return { rows: rows.slice(0, clamped.limit) };
  });
}

// ---------------------------------------------------------------------
// list_release_tasks
// ---------------------------------------------------------------------
export async function listReleaseTasks(ctx: ToolContext, pagination?: PaginationInput): Promise<{ rows: Record<string, unknown>[] } | PortOutageResult> {
  return withAudit(ctx, "list_release_tasks", pagination, async () => {
    const clamped = clampPagination(pagination);
    const result = await ctx.client.listEntities("build_task", { limit: clamped.limit, offset: clamped.offset });
    if (isOutage(result)) return result;
    const rows = sanitizeEntities(extractEntityArray(result.data)).filter((e) => {
      const status = String((e.properties as any)?.status ?? e.status ?? "").toLowerCase();
      return status !== "done";
    });
    return { rows: rows.slice(0, clamped.limit) };
  });
}

// ---------------------------------------------------------------------
// list_pilot_readiness
// ---------------------------------------------------------------------
export async function listPilotReadiness(ctx: ToolContext): Promise<Record<string, unknown> | PortOutageResult> {
  return withAudit(ctx, "list_pilot_readiness", {}, async () => {
    const result = await ctx.client.getEntity("build_task", "bt-pilot-consent-execution");
    if (isOutage(result)) return result;
    const arr = extractEntityArray(result.data);
    const raw = arr.length ? arr[0] : result.data;
    const sanitized = raw ? sanitizeEntity(raw) : null;
    return {
      consentExecutionStatus: sanitized ? (sanitized.properties as any)?.status ?? sanitized.status ?? "unknown" : "unknown",
      candidates: [],
      note: "Pilot candidates are not yet named anywhere in Port. This tool never includes customer content; candidates is intentionally always an empty structured list until named entities exist."
    };
  });
}

// ---------------------------------------------------------------------
// list_recent_port_activity
// ---------------------------------------------------------------------
export interface ActivityItem {
  entity: string;
  change: "updated";
  actor: "unavailable";
  timestamp: string;
}

export async function listRecentPortActivity(ctx: ToolContext): Promise<{ rows: ActivityItem[]; source: string } | PortOutageResult> {
  return withAudit(ctx, "list_recent_port_activity", {}, async () => {
    const auditResult = await ctx.client.getAuditLog(50);
    if (!isOutage(auditResult)) {
      const arr = extractEntityArray(auditResult.data);
      if (arr.length) {
        const rows: ActivityItem[] = arr.slice(0, 50).map((e) => {
          const rec = e as Record<string, unknown>;
          return {
            entity: String(rec.identifier ?? rec.entity ?? "unknown"),
            change: "updated",
            actor: "unavailable",
            timestamp: String(rec.timestamp ?? rec.$updatedAt ?? "")
          };
        });
        return { rows, source: "audit-log" };
      }
    }

    // Fallback: pull allowlisted blueprints, sort by $updatedAt desc, cap 50.
    const combined: Record<string, unknown>[] = [];
    let anySuccess = false;
    for (const bp of ALLOWLISTED_BLUEPRINTS) {
      const r = await ctx.client.listEntities(bp, { limit: 50 });
      if (isOutage(r)) continue;
      anySuccess = true;
      combined.push(...sanitizeEntities(extractEntityArray(r.data)));
    }
    if (!anySuccess) {
      return { status: "port_unavailable_or_stale", detail: "Port API unreachable; data unavailable" } as PortOutageResult;
    }
    combined.sort((a, b) => String(b.$updatedAt ?? "").localeCompare(String(a.$updatedAt ?? "")));
    const rows: ActivityItem[] = combined.slice(0, 50).map((e) => ({
      entity: String(e.identifier ?? e.$identifier ?? "unknown"),
      change: "updated",
      actor: "unavailable",
      timestamp: String(e.$updatedAt ?? "")
    }));
    return { rows, source: "entities-fallback" };
  });
}

// ---------------------------------------------------------------------
// get_entity
// ---------------------------------------------------------------------
export async function getEntity(ctx: ToolContext, id: string, blueprint: string): Promise<Record<string, unknown> | PortOutageResult | { error: string }> {
  return withAudit(ctx, "get_entity", { id, blueprint }, async () => {
    if (!isAllowlistedBlueprint(blueprint)) {
      return { error: `Blueprint '${blueprint}' is not in the allowlist.` };
    }
    if (!id || typeof id !== "string") {
      return { error: "Invalid entity id." };
    }
    const result = await ctx.client.getEntity(blueprint, id);
    if (isOutage(result)) return result;
    const arr = extractEntityArray(result.data);
    const raw = arr.length ? arr[0] : result.data;
    if (!raw) return { error: `Entity not found: ${blueprint}/${id}` };
    const sanitized = sanitizeEntity(raw);
    if (!sanitized) return { error: `Entity blueprint not allowlisted or entity malformed.` };
    // Governance-metadata fields only, post-redaction.
    return {
      identifier: sanitized.identifier ?? sanitized.$identifier ?? id,
      blueprint: sanitized.blueprint ?? blueprint,
      status: (sanitized.properties as any)?.status ?? sanitized.status ?? null,
      updatedAt: sanitized.$updatedAt ?? sanitized.updatedAt ?? null,
      createdAt: sanitized.$createdAt ?? sanitized.createdAt ?? null,
      properties: sanitized.properties ?? null
    };
  });
}

// ---------------------------------------------------------------------
// search_port
// ---------------------------------------------------------------------
export async function searchPort(ctx: ToolContext, query: string, pagination?: PaginationInput): Promise<{ rows: Record<string, unknown>[] } | PortOutageResult | { error: string }> {
  return withAudit(ctx, "search_port", { query, ...pagination }, async () => {
    if (!query || typeof query !== "string" || !query.trim()) {
      return { error: "query must be a non-empty string" };
    }
    const clamped = clampPagination(pagination);

    const searchBody = {
      combinator: "and",
      rules: [
        {
          combinator: "or",
          rules: [
            { property: "$identifier", operator: "contains", value: query },
            { property: "$title", operator: "contains", value: query }
          ]
        }
      ]
    };

    const result = await ctx.client.searchEntities(searchBody);
    if (isOutage(result)) return result;

    const arr = extractEntityArray(result.data);
    // Restrict server-side to allowlisted blueprints regardless of what
    // Port's search endpoint returns.
    const rows = sanitizeEntities(arr).slice(0, clamped.limit).map(clipLongText);
    return { rows };
  });
}

const SEARCH_TEXT_CLIP = 500;
/** search_port rows stay small: long prose is clipped and points at read_record. */
function clipLongText(row: Record<string, unknown>): Record<string, unknown> {
  const props = row.properties;
  if (!props || typeof props !== "object") return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    out[k] = typeof v === "string" && v.length > SEARCH_TEXT_CLIP ? v.slice(0, SEARCH_TEXT_CLIP) + "...[clipped; use read_record]" : v;
  }
  return { ...row, properties: out };
}

export function capIfOversized<T>(payload: T): T | { truncated: true; note: string; partial: string } {
  const cap = capResponseSize(payload);
  if (!cap.truncated) return payload;
  return JSON.parse(cap.body);
}

