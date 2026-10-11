// host03 STAGING ONLY (zzemit): connect the staging workspace's Personal Line integration through the APP'S OWN functions
// (storeSecret -> workspace_secrets, writePersonalLineRecord -> organizations.integrations.personalLine), acting as the workspace
// owner. Only the EVENTS key is stored (this slice delivers events; the summary read is not exercised). The key value is read from a
// Swarm secret file in-process and never printed.
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import { storeSecret, listSecrets } from "@/lib/secrets";
import { PL_SECRET_EVENTS, writePersonalLineRecord } from "@/lib/personal-line/integration";

async function main() {
  const orgId = String(process.env.ORG);
  const [org] = await db.select({ ownerId: organizations.ownerId, slug: organizations.slug }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org?.ownerId) throw new Error("no owner");
  if (!/^syntheticsignup/.test(org.slug)) throw new Error("refusing: not a synthetic staging workspace");
  const rd = (p: string) => readFileSync(p, "utf8").replace(/\r?\n$/, "");
  await storeSecret({ workspaceId: orgId, serviceName: PL_SECRET_EVENTS, value: rd("/run/secrets/pl_sf_events_key"), actorUserId: org.ownerId });
  await writePersonalLineRecord(orgId, { connected: true, baseUrl: "http://zzemit-plsvc:3005/", eventsKeyId: "ev1", summaryKeyId: "sf1" });
  const rows = await listSecrets({ workspaceId: orgId, actorUserId: org.ownerId });
  for (const r of rows.filter((x) => x.serviceName.startsWith("personal-line-"))) console.log(`SECRET ${r.serviceName} v${r.keyVersion} fp=${r.fingerprint.slice(0, 4)}…`);
  const [after] = await db.select({ integrations: organizations.integrations }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  console.log(`RECORD ${JSON.stringify(after?.integrations?.personalLine)}`);
  process.exit(0);
}
main().catch((e) => { console.error(`PROVISION_FAILED ${e instanceof Error ? e.message : e}`); process.exit(1); });
