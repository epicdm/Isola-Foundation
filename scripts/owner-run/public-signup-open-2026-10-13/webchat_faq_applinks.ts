// webchat_faq_applinks.ts - one validated updateAgentBlueprint on the web-chat agent a5e7235d: FAQ[1] only (setup / first call). A website visitor has no app yet, so the install links belong here.
// Owner rule 2026-10-13: every surface points the customer to the calling app; links only where the customer needs to install. Run inside the Uplink app container:
//   ORG=.. AGENT=a5e7235d-... MODE=dry|apply npx tsx zz_webfaq.ts       Rollback: ROLLBACK=1 (writes the previous FAQ[1] text recorded below).
import { createHash } from "node:crypto";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { updateAgentBlueprint } from "@/lib/agents/store";
import { and, eq } from "drizzle-orm";
const ORG = process.env.ORG!, AGENT = process.env.AGENT!, MODE = process.env.MODE ?? "dry", ROLLBACK = process.env.ROLLBACK === "1";
const IOS = "https://apps.apple.com/us/app/cloud-softphone/id567475545";
const AND = "https://play.google.com/store/apps/details?id=cz.acrobits.softphone.cloudphone";
const Q = "How do I set up my Personal Line and make my first call?";
const OLD = "To start, message EPIC on WhatsApp at +1 767 818 0001. EPIC sends you, in WhatsApp, a link to install the Isola Cloud Softphone and your setup link. Open that link on your phone to finish provisioning, then make your first call. Personal Line is voice calling only: no SMS and no emergency calling.";
const NEW = `To start, message EPIC on WhatsApp at +1 767 818 0001 and sign up for the free trial. Then install the free Cloud Softphone app: iPhone ${IOS} and Android ${AND} (each link opens the app page: Open if you already have it, Install if not). EPIC also sends you the install link and your one-tap setup link in WhatsApp. Open the setup link on your phone to finish, then open Cloud Softphone and make your first call. Personal Line is voice calling only: no SMS and no emergency calling.`;
const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 12);
async function read() {
  const [a] = await db.select({ bp: agents.blueprint, v: agents.currentVersion, status: agents.status }).from(agents).where(and(eq(agents.id, AGENT), eq(agents.orgId, ORG))).limit(1);
  if (!a) throw new Error("agent_not_found");
  return a;
}
async function main() {
  const a = await read(); const faq = JSON.parse(JSON.stringify((a.bp as any).faq)) as { q: string; a: string }[];
  if (faq[1]?.q !== Q) throw new Error("faq index/question mismatch at 1");
  const want = ROLLBACK ? OLD : NEW, expectCurrent = ROLLBACK ? NEW : OLD;
  if (faq[1].a !== expectCurrent) throw new Error("FAQ[1] is not in the expected current state; refusing (someone changed it)");
  const before = sha(faq), rest = (f: any[]) => sha(f.filter((_, i) => i !== 1));
  console.log(`BEFORE v${a.v} status=${a.status} faqSha=${before} restOfFaqSha=${rest(faq)} -> ${ROLLBACK ? "ROLLBACK" : "APPLY"} FAQ[1] only`);
  if (MODE !== "apply") { console.log("DRY RUN - nothing written"); return; }
  faq[1].a = want;
  const r = await updateAgentBlueprint({ agentId: AGENT, orgId: ORG, patch: { faq } as any, publishNotes: ROLLBACK ? "rollback FAQ[1] app links" : "FAQ[1]: install links for website visitors (app guidance rule 2026-10-13)" } as any);
  console.log("updateAgentBlueprint:", JSON.stringify(r));
  const b = await read(); const nf = (b.bp as any).faq;
  console.log(`AFTER v${b.v} status=${b.status} faq[1] matches=${nf[1].a === want} restOfFaq unchanged=${rest(nf) === rest(JSON.parse(JSON.stringify((a.bp as any).faq)))} rest of blueprint unchanged=${sha({ ...(b.bp as any), faq: 0 }) === sha({ ...(a.bp as any), faq: 0 })}`);
}
main().then(() => process.exit(0), (e) => { console.error("ERROR", e?.message ?? e); process.exit(1); });
