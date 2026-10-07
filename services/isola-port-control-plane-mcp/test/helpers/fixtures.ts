/**
 * Deterministic fixtures. All "secrets" are FAKE and assembled from pieces
 * at runtime so no secret-shaped literal sits in the repository.
 */
import type { MockEntity } from "./mockPort.js";

export const UPDATED = "2026-10-07T12:34:56.000Z";

export const FAKE = {
  bearer: "Bearer " + "abcDEF123456" + "ghiJKL789012",
  sk: "sk-" + "proj" + "-" + "A1b2C3d4E5f6G7h8I9j0",
  jwt: ["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJ" + "zdWIiOiJ0ZXN0In0", "c2lnbmF0dXJl" + "cGFydA"].join("."),
  pem: ["-----BEGIN " + "RSA PRIVATE KEY-----", "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu", "-----END " + "RSA PRIVATE KEY-----"].join("\n"),
  pwAssign: ["pass", "word"].join("") + "=" + "hunter2" + "-fake-value",
  conn: "post" + "gres://svc_user:s3cretpw@db.internal:5432/app",
  phonePlus: "+1 767 818 0001",
  phoneCompact: "+17678180001",
  phoneDashed: "767-818-0001"
};

export const SURVIVORS = {
  ts: "2026-10-07T12:34:56.000Z",
  date: "2026-10-07",
  version: "v0.21.5",
  uuid: "123e4567-e89b-12d3-a456-426614174000",
  sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  commit: "5384908c1f2e3d4b5a69788796a5b4c3d2e1f001",
  entityId: "dec-owner-pl-launch-ladder-included-minutes-2026-09-27",
  pct: "99.5%",
  amount: "$1,234.56"
};

export function seededDescription(): string {
  return [
    `Authorization: ${FAKE.bearer}`,
    `key ${FAKE.sk}`,
    `jwt ${FAKE.jwt}`,
    FAKE.pem,
    FAKE.pwAssign,
    `conn ${FAKE.conn}`,
    `call ${FAKE.phonePlus} or ${FAKE.phoneDashed} or ${FAKE.phoneCompact}`,
    `ts ${SURVIVORS.ts} date ${SURVIVORS.date} version ${SURVIVORS.version} uuid ${SURVIVORS.uuid}`,
    `sha256: ${SURVIVORS.sha256} commit ${SURVIVORS.commit}`,
    `entity ${SURVIVORS.entityId} pct ${SURVIVORS.pct} amount ${SURVIVORS.amount}`,
    `mail eric@epic.dm`
  ].join("\n");
}

/** ~30k chars of deterministic prose */
export function longPlan(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 600; i++) lines.push(`Step ${i}: reconcile packet ${i} against the register and record evidence.`);
  return lines.join("\n");
}

function ent(blueprint: string, identifier: string, title: string, updatedAt: string, properties: Record<string, unknown>): MockEntity {
  return { blueprint, identifier, title, updatedAt, properties };
}

export function seedEntities(): MockEntity[] {
  return [
    ent("execution_plan", "plan-internal-agent", "Internal agent plan", UPDATED, {
      status: "Active", version: "v0.21.5", plan: longPlan(), current_state: "Building the adapter.", next_gate: "Review",
      api_token: "should-never-appear", body: "chat body", text: "chat text", transcript: "t"
    }),
    ent("execution_plan", "plan-older", "Older plan", "2026-09-01T00:00:00.000Z", { status: "Done", plan: "old" }),
    ent("execution_packet", "pkt-scrub", "Scrub packet", UPDATED, { status: "Open", description: seededDescription(), last_reviewed: "2026-10-07" }),
    ent("isola_launch_gate", "gate-a", "Gate A", "2026-10-05T00:00:00.000Z", { status: "Open", launch_criticality: "P0", current_state: "x" }),
    ent("isola_component", "comp-a", "Component A", "2026-10-04T00:00:00.000Z", { status: "Live", version: "1.2.3" }),
    ent("agent_contract", "contract-a", "Agent contract A", "2026-10-03T00:00:00.000Z", { status: "Ratified", contract: "Agent may read." }),
    ent("decision", "dec-1", "Decision one", "2026-10-02T00:00:00.000Z", { decided_at: "2026-10-02", decision_text: "We decided.", rationale: "Because." }),
    ent("defect", "defect-1", "Defect one", "2026-10-01T00:00:00.000Z", { status: "Open", severity: "high", root_cause: "Bug." }),
    ent("build_task", "bt-release-control-implementation", "BT release control", "2026-09-30T00:00:00.000Z", { status: "Backlog", priority: "P0-MVP" }),
    // Not allowlisted: the mock WILL serve these, so refusal is the server's doing.
    ent("customer", "cust-1", "Customer One", UPDATED, { phone: "+17678183742" }),
    ent("contract", "k-1", "A contract", UPDATED, { terms: "secret terms" })
  ];
}
