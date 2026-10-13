// zz_faq_patch.ts - one validated updateAgentBlueprint on the web-chat agent a5e7235d: FAQ wording only (owner clarification 2026-10-13). Run inside the Uplink app container.
import { db } from "@/db";
import { agents } from "@/db/schema";
import { updateAgentBlueprint } from "@/lib/agents/store";
import { and, eq } from "drizzle-orm";
const ORG = process.env.ORG!, AGENT = process.env.AGENT!;
const NOBUY = " Paid plans are not available to buy yet.";
async function main() {
  const [a] = await db.select({ bp: agents.blueprint, v: agents.currentVersion, status: agents.status }).from(agents).where(and(eq(agents.id, AGENT), eq(agents.orgId, ORG))).limit(1);
  if (!a) throw new Error("agent_not_found");
  const faq = JSON.parse(JSON.stringify((a.bp as any).faq)) as { q: string; a: string }[];
  const expectQ: Record<number, string> = { 2: "What plans and prices are there?", 3: "What happens after my included minutes run out?", 5: "How do I get my number?", 6: "What if I pay and the number cannot be given to me?", 13: "Are incoming calls free?", 16: "How do I top up my wallet?", 17: "Which plan should I choose?", 18: "What is the difference between Personal Line and Plus?", 19: "Which plan includes US and Canada calls?", 20: "Is there a cheap way to try it?" };
  for (const [i, q] of Object.entries(expectQ)) if (faq[Number(i)]?.q !== q) throw new Error("faq index/question mismatch at " + i);
  const wa = "message EPIC on WhatsApp at +1 767 818 0001";
  for (const i of [2, 17, 18, 19, 20]) faq[i].a = faq[i].a.trimEnd() + NOBUY;
  faq[3].a = "The free trial includes 60 minutes of outgoing calls to Dominica numbers. Paid plans and top-ups are not available to buy yet. For questions about your balance, " + wa + ".";
  faq[5].a = "To start the free trial, " + wa + ". Paid plans are not available to buy yet.";
  faq[6].a = "Paid plans are not available to buy yet, so there is nothing to pay for right now. If something goes wrong with your free trial number, " + wa + ".";
  faq[13].a = "Yes. Incoming calls to your number work and are free while your balance is positive. The 60 free trial minutes are for outgoing calls to Dominica numbers. If you have a question about a zero balance or your trial credit, " + wa + ".";
  faq[16].a = "Top-ups are not available yet. For questions about your balance, " + wa + ".";
  console.log("PLAN web-chat agent v" + a.v + " status=" + a.status + " faq entries=" + faq.length + " changed=2,3,5,6,13,16,17,18,19,20");
  if (process.env.MODE !== "apply") { console.log("DRY RUN - nothing written"); return; }
  const r = await updateAgentBlueprint({ agentId: AGENT, orgId: ORG, patch: { faq } as any, publishNotes: "FAQ wording: incoming calls work and are free with a positive balance; paid plans/top-ups not available yet (owner via PM 2026-10-13)" });
  console.log("updateAgentBlueprint:", JSON.stringify(r));
  const [b] = await db.select({ v: agents.currentVersion, status: agents.status, bp: agents.blueprint }).from(agents).where(eq(agents.id, AGENT)).limit(1);
  console.log("READBACK v" + b.v + " status=" + b.status + " faq13=" + String(((b.bp as any).faq[13]).a).slice(0, 60));
}
main().then(() => process.exit(0), (e) => { console.error("ERROR", e?.message ?? e); process.exit(1); });
