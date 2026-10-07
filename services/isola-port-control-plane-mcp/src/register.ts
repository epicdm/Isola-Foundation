/**
 * register.ts
 *
 * Single place where the MCP tool set is defined. Used by BOTH transports
 * (HTTP server.ts and stdio.ts) so the tool set is identical.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  getReleaseBoard,
  listOpenGates,
  getGateEvidence,
  listOpenBlockers,
  listDecisions,
  listReleaseTasks,
  listPilotReadiness,
  listRecentPortActivity,
  getEntity,
  searchPort,
  capIfOversized,
  type ToolContext
} from "./tools.js";
import { readRecord, listRecords } from "./records.js";
import { ALLOWLISTED_BLUEPRINTS } from "./redact.js";
import { hashParams } from "./audit.js";

const paginationShape = {
  limit: z.number().int().min(1).max(1000).optional(),
  cursor: z.string().optional(),
  offset: z.number().int().min(0).optional()
};

export function toToolResult(payload: unknown) {
  const capped = capIfOversized(payload);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(capped, null, 2) }]
  };
}

export interface BuildOptions {
  /**
   * stdio mode: when true and the client has no credentials, every data tool
   * returns {status:'unavailable', reason:'credentials_not_configured'}
   * (tools/list still works). Default false (HTTP behaviour unchanged).
   */
  unavailableWithoutCredentials?: boolean;
}

export const TOOL_NAMES = [
  "read_record",
  "list_records",
  "search_port",
  "get_entity",
  "list_decisions",
  "list_open_blockers",
  "list_recent_port_activity",
  "get_release_board",
  "list_open_gates",
  "get_gate_evidence",
  "list_release_tasks",
  "list_pilot_readiness"
] as const;

export function buildMcpServer(ctx: ToolContext, opts: BuildOptions = {}): McpServer {
  const server = new McpServer({ name: "isola-port-control-plane-mcp", version: "1.1.0" });

  // Wrap every data tool so the credentials gate is uniform and audited.
  const gated =
    <A extends unknown[]>(name: string, fn: (...a: A) => Promise<unknown>, hasInput = true) =>
    async (...a: A) => {
      if (opts.unavailableWithoutCredentials && !ctx.client.hasCredentials()) {
        await ctx.audit.record({
          tool: name,
          callerRef: ctx.callerRef,
          paramsHash: hashParams(hasInput ? a[0] : {}),
          resultCount: 0,
          ok: false
        });
        return toToolResult({ status: "unavailable", reason: "credentials_not_configured" });
      }
      return toToolResult(await fn(...a));
    };

  server.registerTool(
    "read_record",
    {
      description:
        "Read ONE allowlisted record (plan/packet/decision/evidence/defect/gate/component/agent contract) including its free-text content, paged. Blueprints: " +
        ALLOWLISTED_BLUEPRINTS.join(", ") +
        ". Free-text fields (description, plan, current_state, next_action, rationale, objective, acceptance, evidence_needed, rollback, root_cause, resolution, contract, ...) come back under `texts` with offset/next_offset/total_chars; call again with offset=next_offset for the next page. Secrets, tokens, keys, emails and phone numbers are scrubbed. Conversation fields (body/message/transcript/content/text) are never returned.",
      inputSchema: {
        blueprint: z.string().describe("Blueprint identifier, must be in the allowlist"),
        id: z.string().describe("Entity identifier"),
        offset: z.number().int().min(0).optional().describe("Character offset into each text field (default 0)"),
        max_chars: z.number().int().optional().describe("Max characters per text field per call (default 12000, hard cap 20000)")
      }
    },
    gated("read_record", async ({ blueprint, id, offset, max_chars }: { blueprint: string; id: string; offset?: number; max_chars?: number }) =>
      readRecord(ctx, blueprint, id, offset ?? 0, max_chars ?? 12000)
    )
  );

  server.registerTool(
    "list_records",
    {
      description:
        "List records of one allowlisted blueprint (identifier, title, updatedAt and a few scalar properties such as status/version/severity/launch_criticality/last_reviewed/captured_at/decided_at; no long text). Limit hard-capped at 50. Use read_record for content.",
      inputSchema: {
        blueprint: z.string().describe("Blueprint identifier, must be in the allowlist"),
        status: z.string().optional().describe("Exact (case-insensitive) match on the status property"),
        title_contains: z.string().optional().describe("Case-insensitive substring match on the title or the identifier"),
        sort: z.enum(["updated_desc", "updated_asc", "title_asc"]).optional().describe("Default updated_desc"),
        limit: z.number().int().optional().describe("Default 25, hard cap 50"),
        offset: z.number().int().min(0).optional()
      }
    },
    gated("list_records", async ({ blueprint, ...rest }: { blueprint: string; status?: string; title_contains?: string; sort?: string; limit?: number; offset?: number }) =>
      listRecords(ctx, blueprint, rest)
    )
  );

  server.registerTool(
    "search_port",
    {
      description: `Contains-match search against $identifier/$title across allowlisted blueprints only (${ALLOWLISTED_BLUEPRINTS.join(", ")}), via Port's POST /v1/entities/search. Long text properties are clipped; use read_record for full content.`,
      inputSchema: { query: z.string().describe("Search text"), ...paginationShape }
    },
    gated("search_port", async ({ query, ...pagination }: { query: string; limit?: number; cursor?: string; offset?: number }) =>
      searchPort(ctx, query, pagination)
    )
  );

  server.registerTool(
    "get_entity",
    {
      description: `Fetch a single entity by id + blueprint. Blueprint must be one of: ${ALLOWLISTED_BLUEPRINTS.join(", ")}. Returns governance-metadata fields only, post-redaction.`,
      inputSchema: {
        id: z.string().describe("Entity identifier, e.g. bt-release-control-implementation"),
        blueprint: z.string().describe("Blueprint identifier, must be in the allowlist")
      }
    },
    gated("get_entity", async ({ id, blueprint }: { id: string; blueprint: string }) => getEntity(ctx, id, blueprint))
  );

  server.registerTool(
    "list_decisions",
    {
      description: "List all `decision` blueprint entities, newest first by decided_at/$updatedAt, paginated.",
      inputSchema: paginationShape
    },
    gated("list_decisions", async (args: { limit?: number; cursor?: string; offset?: number }) => listDecisions(ctx, args))
  );

  server.registerTool(
    "list_open_blockers",
    {
      description: "List open defects + P0-MVP backlog build_tasks, ranked release-control > device-b > clawith > pr22 > consent > other.",
      inputSchema: paginationShape
    },
    gated("list_open_blockers", async (args: { limit?: number; cursor?: string; offset?: number }) => listOpenBlockers(ctx, args))
  );

  server.registerTool(
    "list_recent_port_activity",
    {
      description:
        "Recent Port activity. Tries GET /v1/audit-log first; falls back to allowlisted-blueprint entities sorted by $updatedAt desc, capped at 50."
    },
    gated("list_recent_port_activity", async () => listRecentPortActivity(ctx), false)
  );

  // ---- LEGACY: Release Train 01 tools (kept for compatibility) ----
  server.registerTool(
    "get_release_board",
    {
      description:
        "LEGACY (Release Train 01). Return the derived Release Train 01 board (composed from build_task/requirement/defect/epic_project entities)."
    },
    gated("get_release_board", async () => getReleaseBoard(ctx), false)
  );

  server.registerTool(
    "list_open_gates",
    { description: "LEGACY (Release Train 01). List release-board gates that are not yet green/done, with dependency notes and evidence refs." },
    gated("list_open_gates", async () => listOpenGates(ctx), false)
  );

  server.registerTool(
    "get_gate_evidence",
    {
      description: "LEGACY (Release Train 01). Fetch evidence (description/evidence-type/$updatedAt + staleness flag) for a named Release Train 01 gate.",
      inputSchema: { gate_id: z.string().describe("Gate id or gate name, e.g. gate-2-device-b-external-p8 or 'Device B external P8'") }
    },
    gated("get_gate_evidence", async ({ gate_id }: { gate_id: string }) => getGateEvidence(ctx, gate_id))
  );

  server.registerTool(
    "list_release_tasks",
    {
      description: "LEGACY (Release Train 01). List build_task entities where status != Done, paginated.",
      inputSchema: paginationShape
    },
    gated("list_release_tasks", async (args: { limit?: number; cursor?: string; offset?: number }) => listReleaseTasks(ctx, args))
  );

  server.registerTool(
    "list_pilot_readiness",
    {
      description:
        "LEGACY (Release Train 01). Pilot-readiness state: bt-pilot-consent-execution status plus an always-empty structured candidates list. Never includes customer content."
    },
    gated("list_pilot_readiness", async () => listPilotReadiness(ctx), false)
  );

  return server;
}
