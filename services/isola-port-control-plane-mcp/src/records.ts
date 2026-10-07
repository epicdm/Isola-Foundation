/**
 * records.ts
 *
 * Internal-agent tools: read_record and list_records. Same pipeline as the
 * rest of tools.ts (read-only client -> allowlist -> scrub -> audit -> cap).
 */
import type { PortOutageResult } from "./portClient.js";
import { isAllowlistedBlueprint, redactValue, redactFreeText, isFreeTextKey } from "./redact.js";
import { withAudit, isOutage, extractEntityArray, type ToolContext } from "./tools.js";

// ---------------------------------------------------------------------
// read_record
// ---------------------------------------------------------------------
export const READ_RECORD_DEFAULT_MAX_CHARS = 12_000;
export const READ_RECORD_HARD_MAX_CHARS = 20_000;

export interface PagedText {
  text: string;
  offset: number;
  next_offset: number | null;
  total_chars: number;
  truncated: boolean;
}

export function pageText(full: string, offset: number, maxChars: number): PagedText {
  const total = full.length;
  const start = Math.min(Math.max(0, offset), total);
  let end = Math.min(start + maxChars, total);
  // never split a surrogate pair
  if (end < total && end > start) {
    const c = full.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  }
  return {
    text: full.slice(start, end),
    offset: start,
    next_offset: end < total ? end : null,
    total_chars: total,
    truncated: end < total
  };
}

function strOrNull(x: unknown): string | null {
  return typeof x === "string" ? x : null;
}

const SAFE_TS_RE = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;
function safeTimestamp(x: unknown): string | null {
  return typeof x === "string" && SAFE_TS_RE.test(x) ? x : null;
}

export async function readRecord(
  ctx: ToolContext,
  blueprint: string,
  id: string,
  offset = 0,
  maxChars = READ_RECORD_DEFAULT_MAX_CHARS
): Promise<Record<string, unknown> | PortOutageResult | { error: string }> {
  return withAudit(ctx, "read_record", { blueprint, id, offset, maxChars }, async () => {
    if (!isAllowlistedBlueprint(blueprint)) {
      return { error: `Blueprint '${String(blueprint).slice(0, 64)}' is not in the allowlist.` };
    }
    if (!id || typeof id !== "string" || id.length > 200) {
      return { error: "Invalid entity id." };
    }
    const off = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const mc = Number.isFinite(maxChars)
      ? Math.min(Math.max(1, Math.floor(maxChars)), READ_RECORD_HARD_MAX_CHARS)
      : READ_RECORD_DEFAULT_MAX_CHARS;

    const result = await ctx.client.getEntity(blueprint, id);
    if (isOutage(result)) return result;
    const arr = extractEntityArray(result.data);
    const raw = (arr.length ? arr[0] : null) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return { error: `Entity not found: ${blueprint}/${id}` };
    const rawBp = raw.blueprint ?? raw.$blueprint ?? blueprint;
    if (rawBp !== blueprint) {
      return { error: "Entity blueprint mismatch." };
    }

    const rawProps = (raw.properties && typeof raw.properties === "object" ? raw.properties : {}) as Record<string, unknown>;
    const structured: Record<string, unknown> = {};
    const texts: Record<string, PagedText> = {};
    for (const [k, v] of Object.entries(rawProps)) {
      if (isFreeTextKey(blueprint, k)) {
        let s: string | null = null;
        if (typeof v === "string") s = v;
        else if (v !== null && v !== undefined && typeof v === "object") s = JSON.stringify(redactValue(v));
        if (s === null) continue;
        // Scrub the WHOLE field first, then page, so a secret straddling a
        // page boundary can never leak. total_chars/offsets refer to the
        // scrubbed text.
        texts[k] = pageText(redactFreeText(s, k), off, mc);
      } else {
        structured[k] = redactValue(v, k);
      }
    }

    const title = strOrNull(raw.title ?? raw.$title);
    return {
      identifier: redactFreeText(String(raw.identifier ?? raw.$identifier ?? id)),
      title: title === null ? null : redactFreeText(title),
      blueprint,
      updatedAt: safeTimestamp(raw.updatedAt ?? raw.$updatedAt),
      properties: structured,
      texts
    };
  });
}

// ---------------------------------------------------------------------
// list_records
// ---------------------------------------------------------------------
export const LIST_RECORDS_MAX_LIMIT = 50;
export const LIST_RECORDS_SCAN_CAP = 1000;
const LIST_SCALAR_PROPS = [
  "status", "version", "severity", "launch_criticality", "criticality", "priority",
  "last_reviewed", "captured_at", "decided_at"
];

export async function listRecords(
  ctx: ToolContext,
  blueprint: string,
  opts: { status?: string; title_contains?: string; sort?: string; limit?: number; offset?: number } = {}
): Promise<Record<string, unknown> | PortOutageResult | { error: string }> {
  return withAudit(ctx, "list_records", { blueprint, ...opts }, async () => {
    if (!isAllowlistedBlueprint(blueprint)) {
      return { error: `Blueprint '${String(blueprint).slice(0, 64)}' is not in the allowlist.` };
    }
    const sort = opts.sort === "updated_asc" || opts.sort === "title_asc" ? opts.sort : "updated_desc";
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 25)), LIST_RECORDS_MAX_LIMIT);
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));

    const rules: Record<string, unknown>[] = [{ property: "$blueprint", operator: "=", value: blueprint }];
    if (opts.status) rules.push({ property: "status", operator: "=", value: opts.status });
    if (opts.title_contains) rules.push({ property: "$title", operator: "contains", value: opts.title_contains });

    const result = await ctx.client.searchEntities({ combinator: "and", rules });
    if (isOutage(result)) return result;

    // Port's search body has no sort/limit, so filter again server-side
    // (never trust the remote filter), sort and page here. Only the first
    // LIST_RECORDS_SCAN_CAP matches are considered.
    let all = extractEntityArray(result.data).filter(
      (e) => e && typeof e === "object" && ((e as any).blueprint ?? (e as any).$blueprint) === blueprint
    ) as Record<string, unknown>[];
    const scanTruncated = all.length > LIST_RECORDS_SCAN_CAP;
    all = all.slice(0, LIST_RECORDS_SCAN_CAP);
    const wantStatus = opts.status?.toLowerCase();
    const wantTitle = opts.title_contains?.toLowerCase();
    all = all.filter((e) => {
      const props = (e.properties ?? {}) as Record<string, unknown>;
      if (wantStatus && String(props.status ?? "").toLowerCase() !== wantStatus) return false;
      if (wantTitle && !String(e.title ?? e.$title ?? "").toLowerCase().includes(wantTitle)) return false;
      return true;
    });
    const upd = (e: Record<string, unknown>) => String(e.updatedAt ?? e.$updatedAt ?? "");
    const ttl = (e: Record<string, unknown>) => String(e.title ?? e.$title ?? "");
    all.sort((a, b) =>
      sort === "updated_asc" ? upd(a).localeCompare(upd(b))
      : sort === "title_asc" ? ttl(a).localeCompare(ttl(b))
      : upd(b).localeCompare(upd(a))
    );

    const page = all.slice(offset, offset + limit);
    const items = page.map((e) => {
      const props = (e.properties ?? {}) as Record<string, unknown>;
      const small: Record<string, unknown> = {};
      for (const k of LIST_SCALAR_PROPS) {
        const v = props[k];
        if ((typeof v === "string" && v.length <= 120) || typeof v === "number" || typeof v === "boolean") {
          small[k] = redactValue(v, k);
        }
      }
      const title = strOrNull(e.title ?? e.$title);
      return {
        identifier: redactFreeText(String(e.identifier ?? e.$identifier ?? "")),
        title: title === null ? null : redactFreeText(title),
        updatedAt: safeTimestamp(e.updatedAt ?? e.$updatedAt),
        properties: small
      };
    });
    return {
      blueprint,
      total_matched: all.length,
      offset,
      limit,
      next_offset: offset + limit < all.length ? offset + limit : null,
      scan_truncated: scanTruncated,
      items
    };
  });
}
