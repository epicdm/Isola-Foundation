// request-matrix.ts - READ-ONLY. Assembles the ACTUAL public-pilot model requests (runtime code path: composeSystemPrompt + getToolsForCapabilities + the runtime's history rebuild with
// serializeToolResultCapped) for realistic multi-tool, multi-turn Personal Line conversations and reports every size against the 32,768 B cap. Tool results and message sizes are taken from
// REAL stored turns of this agent (all conversations incl. evals), not guessed. Nothing is written. Run in the Uplink app container: ORG=.. AGENT=.. npx tsx zz_matrix.ts
import { db } from "@/db";
import { agents, agentTurns, agentConversations, organizations } from "@/db/schema";
import { composeSystemPrompt, applyDeploymentPersona } from "@/lib/agents/prompt";
import { getToolsForCapabilities } from "@/lib/agents/tools";
import { serializeToolResultCapped } from "@/lib/agents/turn-token-economy";
import { MAX_PUBLIC_PILOT_INPUT_BYTES_PER_REQUEST as CAP } from "@/lib/agents/public-pilot-controls";
import { and, asc, eq, sql } from "drizzle-orm";
const ORG = process.env.ORG!, AGENT = process.env.AGENT!;
const bytes = (x: unknown) => Buffer.byteLength(JSON.stringify(x), "utf8");
const pct = (a: number[], p: number) => a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0;
async function main() {
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, AGENT), eq(agents.orgId, ORG))).limit(1);
  const [orgRow] = await db.select({ name: organizations.name, soul: organizations.soul, timezone: organizations.timezone }).from(organizations).where(eq(organizations.id, ORG)).limit(1);
  const bp: any = agent.blueprint ?? {};
  const { blueprint, soul } = applyDeploymentPersona({ blueprint: bp, soul: (orgRow.soul as any) ?? null, persona: null });
  const system = await composeSystemPrompt({ orgName: orgRow.name, soul, blueprint, archetype: agent.archetype, testMode: false, now: new Date(), timezone: orgRow.timezone ?? "UTC", greetingPrefix: null, voiceProfileNote: null } as any);
  const tools = (await getToolsForCapabilities(blueprint.capabilities, { orgId: ORG, connectors: blueprint.connectors } as any)).map((t: any) => ({ name: t.name, description: t.description, input_schema: t.jsonSchema }));
  const base = bytes({ model: "deepseek-flash", max_tokens: 1024, system, tools, messages: [] });
  console.log(`BASE (system + tools + envelope, no messages): ${base} B  [system ${bytes(system)}, tools ${bytes(tools)} (${tools.length} tools)]  CAP ${CAP} B  => room for messages: ${CAP - base} B`);
  // ---- real stored turns for this agent
  const rows = await db.select({ conv: agentTurns.conversationId, idx: agentTurns.turnIndex, role: agentTurns.role, content: agentTurns.content, toolCalls: agentTurns.toolCalls, toolResults: agentTurns.toolResults, ev: sql<string>`${agentConversations.channelMeta}->>'eval_run'` })
    .from(agentTurns).innerJoin(agentConversations, eq(agentConversations.id, agentTurns.conversationId)).where(eq(agentConversations.agentId, AGENT)).orderBy(asc(agentTurns.conversationId), asc(agentTurns.turnIndex));
  const perTool: Record<string, number[]> = {}; const callsPerTurn: number[] = []; const asstText: number[] = []; const userMsg: number[] = []; const toolUseBytes: Record<string, number[]> = {};
  for (const r of rows) {
    if (r.role === "user") userMsg.push(Buffer.byteLength(r.content ?? "", "utf8"));
    if (r.role !== "assistant") continue;
    asstText.push(Buffer.byteLength(r.content ?? "", "utf8"));
    const calls = (r.toolCalls as any[]) ?? []; const res = (r.toolResults as any[]) ?? [];
    callsPerTurn.push(calls.length);
    for (const c of calls) { const rr = res.find((x) => x.toolCallId === c.id); const n = String(c.name); (toolUseBytes[n] ??= []).push(bytes({ type: "tool_use", id: c.id, name: c.name, input: c.input })); if (rr) (perTool[n] ??= []).push(bytes({ type: "tool_result", tool_use_id: rr.toolCallId, content: rr.ok ? serializeToolResultCapped(rr.output) : "Error", is_error: !rr.ok })); }
  }
  console.log(`REAL DATA: ${rows.length} turns; assistant turns ${callsPerTurn.length}; tools per assistant turn: ` + [0, 1, 2, 3, 4].map((k) => `${k}:${callsPerTurn.filter((c) => c === k).length}`).join(" ") + ` (max ${Math.max(0, ...callsPerTurn)})`);
  console.log(`user msg bytes p50/max ${pct(userMsg, 50)}/${Math.max(0, ...userMsg)}; assistant text bytes p50/max ${pct(asstText, 50)}/${Math.max(0, ...asstText)}`);
  console.log("tool_result block bytes in a request (as the runtime re-sends them): tool | n | p50 | p90 | max");
  for (const [n, a] of Object.entries(perTool)) console.log(`  ${n} | ${a.length} | ${pct(a, 50)} | ${pct(a, 90)} | ${Math.max(...a)}`);
  const W = Object.fromEntries(Object.entries(perTool).map(([n, a]) => [n, Math.max(...a)]));
  const U = Object.fromEntries(Object.entries(toolUseBytes).map(([n, a]) => [n, Math.max(...a)]));
  // ---- REPLAY of every REAL (non-eval) conversation: exact request size at each model request point (round structure approximated as ONE parallel round per assistant turn = a LOWER bound)
  const byConv = new Map<string, any[]>(); for (const r of rows) { if (r.ev === "true") continue; (byConv.get(r.conv) ?? byConv.set(r.conv, []).get(r.conv)!).push(r); }
  const pts: { conv: string; at: string; size: number }[] = [];
  for (const [conv, turns] of byConv) {
    const msgs: any[] = [];
    for (let i = 0; i < turns.length; i++) {
      const t = turns[i];
      if (t.role === "user") { msgs.push({ role: "user", content: t.content ?? "" }); continue; }
      if (t.role !== "assistant") continue;
      const req1 = bytes({ model: "deepseek-flash", max_tokens: 1024, system, tools, messages: msgs });
      pts.push({ conv: conv.slice(0, 8), at: `turn ${t.idx} req1`, size: req1 });
      const calls = (t.toolCalls as any[]) ?? [], res = (t.toolResults as any[]) ?? [];
      const blocks: any[] = []; if (t.content) blocks.push({ type: "text", text: t.content });
      for (const c of calls) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      if (calls.length) {
        const toolMsg = { role: "user", content: res.map((tr: any) => ({ type: "tool_result", tool_use_id: tr.toolCallId, content: tr.ok ? serializeToolResultCapped(tr.output) : "Error", is_error: !tr.ok })) };
        pts.push({ conv: conv.slice(0, 8), at: `turn ${t.idx} req2 (${calls.length} tools)`, size: bytes({ model: "deepseek-flash", max_tokens: 1024, system, tools, messages: [...msgs, { role: "assistant", content: blocks }, toolMsg] }) });
        msgs.push({ role: "assistant", content: blocks }); msgs.push(toolMsg);
      } else msgs.push({ role: "assistant", content: blocks });
    }
  }
  pts.sort((a, b) => b.size - a.size);
  console.log(`
REAL REPLAY (system+tools of the CURRENT blueprint v${agent.currentVersion}): ${byConv.size} real conversations, ${pts.length} request points; over cap: ${pts.filter((p) => p.size > CAP).length}; closest to the cap:`);
  for (const p of pts.slice(0, 8)) console.log(`  conv ${p.conv} ${p.at}: ${p.size} B (margin ${CAP - p.size >= 0 ? "+" : ""}${CAP - p.size})`);
  // ---- scenarios built from the REAL worst-case blocks
  const userB = 60, asstB = Math.max(300, pct(asstText, 90)), wrapU = 60;     // wrapper bytes per message object (role/content keys)
  const names = Object.keys(W).sort((a, b) => W[b] - W[a]);
  console.log("tools ranked by worst result bytes:", names.map((n) => `${n.split("__")[1] ?? n}=${W[n]}`).join(", "));
  const pick = (k: number) => names.slice(0, k);   // k heaviest distinct tools in one parallel round
  const roundBytes = (ts: string[]) => bytes({ role: "assistant", content: ts.map((n) => ({ type: "tool_use", id: "x".repeat(32), name: n, input: {} })) }) + 40 + ts.reduce((a, n) => a + W[n] + 70, 0);
  const rows2: string[] = []; let worst = { margin: 1e9, label: "" }; let overCount = 0, total = 0;
  for (const prior of [0, 1, 2, 3, 4, 5]) for (const kPrior of [0, 1, 2, 3]) for (const kNew of [1, 2, 3]) {
    if (prior === 0 && kPrior !== 0) continue; if (prior > 0 && kPrior === 0 && false) continue;
    const histPerTurn = userB + wrapU + asstB + wrapU + (kPrior ? roundBytes(pick(kPrior)) : 0);
    const hist = prior * histPerTurn;
    const call1 = base + hist + userB + wrapU;                 // request 1 of the new turn
    const call2 = call1 + roundBytes(pick(kNew));              // request 2: after the first parallel tool round
    const call3 = call2 + asstB + 40 + roundBytes(pick(Math.min(kNew, 2))); // request 3: a second round (e.g. send-message tool) if the agent chains
    for (const [lab, v] of [["req1", call1], ["req2", call2], ["req3", call3]] as const) {
      total++; const margin = CAP - v; if (margin < 0) overCount++;
      if (margin < worst.margin) worst = { margin, label: `${prior} prior msgs x ${kPrior} tools/turn, new turn ${kNew} tools, ${lab}` };
      if (lab === "req2" || lab === "req3") rows2.push(`${prior} prior x ${kPrior}t | new ${kNew}t | ${lab} | ${v} B | margin ${margin >= 0 ? "+" : ""}${margin}`);
    }
  }
  console.log("\nSCENARIO TABLE (worst-case blocks from real data; negative margin = OVER the cap)");
  for (const l of rows2) console.log("  " + l);
  console.log(`\n${total} request points, ${overCount} over the cap. WORST margin ${worst.margin} B at: ${worst.label}`);
  // ---- fresh rotated conversation (carry-over <= 6 messages, ~1.2 KB) with the same tool loads
  const carry = 1400;
  console.log("\nROTATED (fresh Uplink conversation + carry-over ~" + carry + " B): request sizes");
  for (const kNew of [1, 2, 3]) { const c1 = base + carry + userB + wrapU, c2 = c1 + roundBytes(pick(kNew)), c3 = c2 + asstB + 40 + roundBytes(pick(Math.min(kNew, 2))); console.log(`  new turn with ${kNew} tools: req1 ${c1} (margin ${CAP - c1}), req2 ${c2} (margin ${CAP - c2}), req3 ${c3} (margin ${CAP - c3})`); }
}
main().then(() => process.exit(0), (e) => { console.error("ERROR", e?.message ?? e); process.exit(1); });
