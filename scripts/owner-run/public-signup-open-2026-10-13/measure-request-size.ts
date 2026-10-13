// measure-request-size.ts - READ-ONLY. Reproduces the model request the Uplink runtime builds for a conversation (system prompt + tools + rebuilt history) and reports its serialized
// size against the public-pilot cap (32,768 bytes). Mirrors runtime.ts steps 4-5. Nothing is written. Run in the Uplink app container: ORG=.. AGENT=.. CONV=<uuid prefix> npx tsx zz_measure.ts
import { db } from "@/db";
import { agents, agentTurns, agentConversations, organizations } from "@/db/schema";
import { composeSystemPrompt, applyDeploymentPersona } from "@/lib/agents/prompt";
import { getToolsForCapabilities } from "@/lib/agents/tools";
import { buildTurnMessages } from "@/lib/agents/turn-messages";
import { serializeToolResultCapped, capErrorText } from "@/lib/agents/turn-token-economy";
import { MAX_PUBLIC_PILOT_INPUT_BYTES_PER_REQUEST } from "@/lib/agents/public-pilot-controls";
import { and, asc, eq, sql } from "drizzle-orm";
const ORG = process.env.ORG!, AGENT = process.env.AGENT!, CONVP = process.env.CONV!;
const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x), "utf8");
async function main() {
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, AGENT), eq(agents.orgId, ORG))).limit(1);
  const [conv] = await db.select({ id: agentConversations.id }).from(agentConversations).where(and(eq(agentConversations.agentId, AGENT), sql`${agentConversations.id}::text like ${CONVP + "%"}`)).limit(1);
  const [orgRow] = await db.select({ name: organizations.name, soul: organizations.soul, timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, ORG)).limit(1);
  const history = await db.select({ role: agentTurns.role, content: agentTurns.content, toolCalls: agentTurns.toolCalls, toolResults: agentTurns.toolResults }).from(agentTurns).where(eq(agentTurns.conversationId, conv.id)).orderBy(asc(agentTurns.turnIndex));
  const hm: any[] = [];
  for (const turn of history) {
    if (turn.role === "user") hm.push({ role: "user", content: turn.content ?? "" });
    else if (turn.role === "assistant") {
      const blocks: any[] = []; if (turn.content) blocks.push({ type: "text", text: turn.content });
      for (const tc of (turn.toolCalls as any[]) ?? []) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
      hm.push({ role: "assistant", content: blocks });
      const trs = (turn.toolResults as any[]) ?? [];
      if (trs.length) hm.push({ role: "user", content: trs.map((tr) => ({ type: "tool_result", tool_use_id: tr.toolCallId, content: tr.ok ? serializeToolResultCapped(tr.output) : `Error: ${capErrorText(tr.error ?? "unknown")}`, is_error: !tr.ok })) });
    }
  }
  const messages = buildTurnMessages(hm as any, "(already in history)", true);
  const bp: any = agent.blueprint ?? {};
  const { blueprint, soul } = applyDeploymentPersona({ blueprint: bp, soul: (orgRow.soul as any) ?? null, persona: null });
  const prompt = async (b: any) => composeSystemPrompt({ orgName: orgRow.name, soul, blueprint: b, archetype: agent.archetype, testMode: false, now: new Date(), timezone: orgRow.timezone ?? "UTC", greetingPrefix: null, voiceProfileNote: null } as any);
  const system = await prompt(blueprint);
  const tools = (await getToolsForCapabilities(blueprint.capabilities, { orgId: ORG, connectors: blueprint.connectors } as any)).map((t: any) => ({ name: t.name, description: t.description, input_schema: t.jsonSchema }));
  const params = { model: "deepseek-flash", max_tokens: 1024, system, tools, messages };
  const total = bytes(params), cap = MAX_PUBLIC_PILOT_INPUT_BYTES_PER_REQUEST;
  console.log(`CONV ${conv.id.slice(0, 8)} history turns=${history.length} | system=${bytes(system)} B (skill ${Buffer.byteLength(bp.customSkillMd ?? "", "utf8")}, faq ${bytes(bp.faq)}) | tools=${bytes(tools)} B (${tools.length} tools) | messages=${bytes(messages)} B`);
  console.log(`TOTAL ${total} B vs cap ${cap} B -> ${total <= cap ? "WITHIN" : "OVER by " + (total - cap)} B   (max_tokens/model envelope are approximations: +/- ~30 B)`);
  const per = messages.map((m: any, i: number) => `${i}:${m.role}:${bytes(m)}`).join(" "); console.log("messages bytes:", per);
  // what-ifs (read-only, in memory): per-result boilerplate removal estimates
  const toolResultBytes = messages.filter((m: any) => m.role === "user" && Array.isArray(m.content)).reduce((a: number, m: any) => a + bytes(m), 0);
  console.log(`tool_result messages total: ${toolResultBytes} B (${((toolResultBytes / total) * 100).toFixed(1)}% of the request)`);
}
main().then(() => process.exit(0), (e) => { console.error("ERROR", e?.message ?? e); process.exit(1); });
