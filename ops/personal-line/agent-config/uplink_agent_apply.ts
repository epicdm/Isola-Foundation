// uplink_agent_apply.ts - apply a NATIVE agent configuration through Uplink's own functions (run INSIDE an Uplink app container, cwd
// /app/packages/crm, `npx tsx`). Reusable recipe tool: env ORG, AGENT, CONFIG (json file with any of customSkillMd/faq/pricingFacts/greeting),
// CONNECTOR (MCP connector id), ENABLED (comma list of tools to enable). One validated updateAgentBlueprint (version bump + agent_versions
// row, NO eval run), then a readback. MODE=dry prints the plan only. Nothing secret is printed (the connector key is read in-process).
import fs from "node:fs";
import { getSecretValue } from "@/lib/secrets";
import { updateAgentBlueprint } from "@/lib/agents/store";
import { createMcpClient } from "@/lib/agents/mcp/client";
import { withRediscoveredTools, mergeConnectorBinding } from "@/lib/agents/mcp/bind";
import { resolveConnectorEndpoint } from "@/lib/agents/mcp/connectors";
import { db } from "@/db";
import { agents, type AgentBlueprint } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import crypto from "node:crypto";

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing ${k}`); return v; };
const ORG = need("ORG"), AGENT = need("AGENT"), CONNECTOR = process.env.CONNECTOR || "pl-action-adapter";
const ENABLED = need("ENABLED").split(",").map((s) => s.trim()).filter(Boolean);
const cfg = JSON.parse(fs.readFileSync(need("CONFIG"), "utf8")) as Record<string, unknown>;
const KEYS = ["customSkillMd", "faq", "pricingFacts", "greeting"];
const h = (v: unknown) => crypto.createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex").slice(0, 12);

async function main() {
  const [agent] = await db.select({ blueprint: agents.blueprint, v: agents.currentVersion, status: agents.status, slug: agents.slug }).from(agents).where(and(eq(agents.id, AGENT), eq(agents.orgId, ORG))).limit(1);
  if (!agent) throw new Error("agent_not_found");
  const bp = (agent.blueprint ?? {}) as AgentBlueprint & Record<string, unknown>;
  const existing = bp.connectors ?? [];
  const binding = existing.find((b) => b.id === CONNECTOR);
  if (!binding) throw new Error("connector_not_bound");
  const endpoint = resolveConnectorEndpoint(binding);
  const bearer = await getSecretValue({ workspaceId: ORG, serviceName: binding.serviceName, skipAccessCheck: true });
  if (!bearer) throw new Error("connector_key_missing");
  const tools = await createMcpClient({ endpoint, bearer }).listTools();
  const names = tools.map((t) => t.name);
  const missing = ENABLED.filter((n) => !names.includes(n));
  console.log(`agent ${agent.slug} v${agent.v} status=${agent.status} | discovered ${names.length}: ${names.join(",")}`);
  console.log(`BEFORE enabled=${JSON.stringify(binding.enabledTools)} ` + KEYS.map((k) => `${k}#${h(bp[k])}`).join(" "));
  if (missing.length) throw new Error("not offered by the connector: " + missing.join(","));
  const refreshed = withRediscoveredTools(binding, tools, ENABLED);
  const patch: Record<string, unknown> = { connectors: mergeConnectorBinding(existing, refreshed) };
  for (const k of KEYS) if (k in cfg) patch[k] = cfg[k];
  console.log(`PLAN   enabled=${JSON.stringify(refreshed.enabledTools)} ` + KEYS.filter((k) => k in cfg).map((k) => `${k}#${h(cfg[k])}`).join(" "));
  if (process.env.MODE !== "apply") { console.log("DRY RUN - nothing written"); return; }
  const r = await updateAgentBlueprint({ agentId: AGENT, orgId: ORG, patch: patch as any, publishNotes: process.env.NOTE || "native configuration apply" });
  console.log("updateAgentBlueprint:", JSON.stringify(r));
  const [after] = await db.select({ v: agents.currentVersion, status: agents.status, blueprint: agents.blueprint }).from(agents).where(eq(agents.id, AGENT)).limit(1);
  const b2 = after.blueprint as any;
  const c2 = (b2.connectors ?? []).find((b: any) => b.id === CONNECTOR);
  console.log(`READBACK v${after.v} status=${after.status} enabled=${JSON.stringify(c2?.enabledTools)} ` + KEYS.filter((k) => k in cfg).map((k) => `${k}:${JSON.stringify(b2[k]) === JSON.stringify(cfg[k]) ? "match" : "MISMATCH"}`).join(" "));
}
main().then(() => process.exit(0), (e) => { console.error("ERROR", e?.message ?? e); process.exit(1); });
