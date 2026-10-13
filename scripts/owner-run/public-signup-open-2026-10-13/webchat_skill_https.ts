// webchat_skill_https.ts - one validated updateAgentBlueprint on the web-chat agent a5e7235d: APPEND one sentence to customSkillMd (v16).
// Finding 2026-10-13: the stored FAQ[1] has full https:// links but the model re-writes them as bare domains in replies; the website widget linkifies only markdown [text](https://...).
// Apply: MODE=apply   Rollback: MODE=apply ROLLBACK=1 (removes exactly the appended suffix; refuses if the skill is not exactly old+suffix).
import { createHash } from "node:crypto";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { updateAgentBlueprint } from "@/lib/agents/store";
import { and, eq } from "drizzle-orm";
const ORG = process.env.ORG!, AGENT = process.env.AGENT!, MODE = process.env.MODE ?? "dry", ROLLBACK = process.env.ROLLBACK === "1";
const SUFFIX = "\n\nLINKS: write every link in full including https://, as markdown [text](url).";
const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 12);
async function read() {
  const [a] = await db.select({ bp: agents.blueprint, v: agents.currentVersion, status: agents.status }).from(agents).where(and(eq(agents.id, AGENT), eq(agents.orgId, ORG))).limit(1);
  if (!a) throw new Error("agent_not_found");
  return a;
}
async function main() {
  const a = await read(); const bp: any = a.bp; const cur: string = bp.customSkillMd ?? "";
  if (ROLLBACK) { if (!cur.endsWith(SUFFIX)) throw new Error("skill does not end with the appended suffix; refusing rollback"); }
  else if (cur.includes("LINKS: write every link in full")) throw new Error("suffix already present; refusing");
  const next = ROLLBACK ? cur.slice(0, cur.length - SUFFIX.length) : cur + SUFFIX;
  const rest = (b: any) => { const o: any = {}; for (const k of Object.keys(b).sort()) if (k !== "customSkillMd") o[k] = b[k]; return o; };
  console.log(`BEFORE v${a.v} status=${a.status} skillLen=${cur.length} skillSha=${sha(cur)} restSha=${sha(rest(bp))} -> ${ROLLBACK ? "ROLLBACK" : "APPEND"} (${SUFFIX.length} chars)`);
  if (MODE !== "apply") { console.log("DRY RUN - nothing written"); return; }
  const r = await updateAgentBlueprint({ agentId: AGENT, orgId: ORG, patch: { customSkillMd: next } as any, publishNotes: ROLLBACK ? "rollback: remove https links sentence" : "skill: write links in full with https:// as markdown (widget linkifies markdown only)" } as any);
  console.log("updateAgentBlueprint:", JSON.stringify(r));
  const b = await read(); const nb: any = b.bp;
  console.log(`AFTER v${b.v} status=${b.status} skill matches=${nb.customSkillMd === next} skillLen=${nb.customSkillMd.length} rest of blueprint unchanged=${sha(rest(nb)) === sha(rest(bp))} faq unchanged=${sha(nb.faq) === sha(bp.faq)}`);
}
main().then(() => process.exit(0), (e) => { console.error("ERROR", e?.message ?? e); process.exit(1); });
