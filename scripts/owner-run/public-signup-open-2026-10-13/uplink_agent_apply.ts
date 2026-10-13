// uplink_agent_apply.ts - ONE validated updateAgentBlueprint on a PL agent: patch ONLY {customSkillMd, faq, pricingFacts, greeting} from a config JSON.
// Everything else in the blueprint (enabled tools, model, etc.) is untouched and PROVEN untouched by a hash of the rest before/after.
// Run inside the Uplink app container: ORG=.. AGENT=.. CONFIG=/tmp/cfg.json NOTE=".." MODE=dry|apply npx tsx zz_apply.ts
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { updateAgentBlueprint } from "@/lib/agents/store";
import { and, eq } from "drizzle-orm";
const ORG = process.env.ORG!, AGENT = process.env.AGENT!, CONFIG = process.env.CONFIG!, NOTE = process.env.NOTE ?? "", MODE = process.env.MODE ?? "dry";
const KEYS = ["customSkillMd", "faq", "pricingFacts", "greeting"] as const;
const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 12);
const rest = (bp: any) => { const o: any = {}; for (const k of Object.keys(bp ?? {}).sort()) if (!(KEYS as readonly string[]).includes(k)) o[k] = bp[k]; return o; };
async function read() {
  const [a] = await db.select({ bp: agents.blueprint, v: agents.currentVersion, status: agents.status }).from(agents).where(and(eq(agents.id, AGENT), eq(agents.orgId, ORG))).limit(1);
  if (!a) throw new Error("agent_not_found");
  return a;
}
async function main() {
  const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
  for (const k of KEYS) if (!(k in cfg)) throw new Error("config missing " + k);
  const a = await read();
  const bp: any = a.bp;
  console.log(`BEFORE v${a.v} status=${a.status} tools=${JSON.stringify(bp.enabledTools ?? bp.tools ?? null)} skillSha=${sha(bp.customSkillMd)} faqSha=${sha(bp.faq)} restSha=${sha(rest(bp))}`);
  console.log(`CONFIG skillSha=${sha(cfg.customSkillMd)} faqSha=${sha(cfg.faq)} changes: skill=${sha(cfg.customSkillMd) !== sha(bp.customSkillMd)} faq=${sha(cfg.faq) !== sha(bp.faq)} pricing=${sha(cfg.pricingFacts) !== sha(bp.pricingFacts)} greeting=${sha(cfg.greeting) !== sha(bp.greeting)}`);
  if (MODE !== "apply") { console.log("DRY RUN - nothing written"); return; }
  const patch: any = {}; for (const k of KEYS) patch[k] = cfg[k];
  const r = await updateAgentBlueprint({ agentId: AGENT, orgId: ORG, patch, publishNotes: NOTE } as any);
  console.log("updateAgentBlueprint:", JSON.stringify(r));
  const b = await read(); const nb: any = b.bp;
  console.log(`AFTER  v${b.v} status=${b.status} skillSha=${sha(nb.customSkillMd)} faqSha=${sha(nb.faq)} restSha=${sha(rest(nb))}`);
  console.log("READBACK matches config:", KEYS.every((k) => sha(nb[k]) === sha(cfg[k])), "| rest of blueprint unchanged:", sha(rest(nb)) === sha(rest(bp)), "| status unchanged:", b.status === a.status);
}
main().then(() => process.exit(0), (e) => { console.error("ERROR", e?.message ?? e); process.exit(1); });
