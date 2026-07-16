// scripts/epic-operators-receptionist.ts
// PM-BUILDER task, 2026-07-15: configure the EPIC Operators SBL tenant AI
// receptionist. Reuse-first: mirrors app/api/provision/route.ts (Tenant +
// User + Subscription + Wallet + Agent) exactly for the create path, and
// app/api/agent/settings/route.ts PUT logic exactly for the persona upsert
// (same fields, same upsert-by-tenant_id shape). Idempotent: safe to re-run.
//
// Why this script exists: DID +1 767-818-2220 forward-to-cell was proven at
// the Magnus (voice engine) layer -- Eric cell rang -- but NO app-level
// Tenant/Agent row existed for "EPIC Operators" in this DB (verified: only
// 3 Tenant rows existed: MoA, Demo Diner, ema_sales_tenant). The normal path
// (GET /api/provision on first admin login) never fired because Eric has not
// yet logged into the Foundation Isola app as admin. This script performs
// the exact same provisioning the app would perform on that first login,
// using the SAME id referenced elsewhere (Port build_task
// bt-mvp-first-customers), so downstream references stay consistent, and
// pre-creates the admin User by email (replit_id: "pending:<email>") using
// the app own existing reconciliation pattern in provision/route.ts (the
// "Admin pre-created this user by email" branch) so Eric real Replit
// identity auto-links on his first real login.
import { prisma } from "../lib/prisma"

const TENANT_ID = "cmreai9ug0000d7y4g6tcl90t"
const OWNER_EMAIL = "epiccommunicationsinc@gmail.com"
const OWNER_CELL = "17672958382"
const DID = "17678182220"

const BUSINESS_INFO = [
  "EPIC Communications Inc -- Internet Service Provider (ISP) and telecom carrier in Dominica.",
  "Address: 8 Castle Street, Roseau, Dominica. Phone: +1 767-818-3742. Email: info@epic.dm. Web: https://www.epic.dm",
  "",
  "Services:",
  "- Residential Internet: Basic EC\$100/mo, Standard EC\$150/mo, Premium EC\$250/mo, Unlimited EC\$300/mo.",
  "- Business Internet: Basic EC\$200/mo, Business EC\$300/mo, Business Enterprise 100 Mbps (SLA) EC\$600/mo, Business Dedicated 200 Mbps (SLA) EC\$1000/mo.",
  "- Voice/Phone (VOIP): Residential and Business phone service, DID + bundled local/US/UK/Canada minute plans, SIP trunking, Auto Attendant/IVR setup (EC\$50).",
  "- IT services: Advanced Network Restoration (EC\$600), Anti-Virus Clean-up (EC\$150), Backup Internet (EC\$100/mo), Backup and Recovery.",
  "",
  "Business hours: Monday-Friday 8:00 AM - 4:00 PM, Saturday 9:00 AM - 1:00 PM, closed Sunday (Atlantic Standard Time, America/Dominica). Source: existing EPIC agent config in production BFF -- verify unchanged before go-live.",
].join("\n")

const KNOWLEDGE_TEXT = [
  "TOP CUSTOMER QUESTIONS AND HOW TO HANDLE THEM:",
  "1. How much is internet / what plans do you have -- Give the plan NAMES and STARTING price ranges from the price list above as general guidance only. Do NOT confirm a final price -- say a sales/care agent will confirm the exact plan and price for their address, because pricing can depend on serviceability and current promotions.",
  "2. When can you install / how long for a new connection -- Do NOT promise or estimate an install date. Say installation scheduling depends on a site survey and current technician availability, and a staff member will follow up with a firm date.",
  "3. My internet/phone is down or I have no service -- This is an OUTAGE. Escalate to staff immediately. Collect: account name/number if known, service address, and when the issue started. Do not attempt to troubleshoot or diagnose.",
  "4. My bill is wrong / I was overcharged / any billing or payment dispute -- Escalate to staff immediately. Do not confirm, dispute, or adjust any billing figure.",
  "5. Can I upgrade/downgrade/cancel my plan -- Acknowledge the request, collect contact info, and hand off to staff/sales -- do not process changes conversationally.",
  "6. General company info (address, hours, website, email) -- Answer directly from the business info above.",
  "7. I want to become a new customer -- Collect name, phone/WhatsApp, service address, and what service they want (residential/business internet, phone). Tell them a sales agent will follow up. Do not quote a binding price or install date (see rules 1-2).",
  "",
  "DO-NOT-DO RULES (hard constraints):",
  "- NEVER quote a final/binding price. Ranges and plan names only; final pricing is confirmed by staff.",
  "- NEVER promise or estimate an installation date or repair-completion time.",
  "- NEVER attempt to resolve billing disputes or outage reports yourself -- always escalate.",
  "- NEVER invent information not in this knowledge base (no guessing at coverage areas, speeds at a specific address, or account details).",
  "",
  "ESCALATION TRIGGERS (hand off to a human / notify staff):",
  "- Any outage or service-is-down report.",
  "- Any billing dispute, refund request, or payment issue.",
  "- A frustrated, angry, or repeat-contact customer.",
  "- Any request needing account-specific lookup (this agent has no account/CRM access).",
  "- Any sales negotiation or contract/legal question.",
].join("\n")

const GREETING = "Hi, thanks for contacting EPIC Communications! This is the EPIC virtual assistant -- I can help with plan info, general questions, or connect you with our team. How can I help today?"

const AWAY_MESSAGE = "Thanks for reaching EPIC Communications. Our team is currently outside business hours (Mon-Fri 8am-4pm, Sat 9am-1pm AST). I can still help with general questions, or leave your name and reason for contact and staff will follow up when we reopen."

async function main() {
  const before = await prisma.tenant.findUnique({ where: { id: TENANT_ID } })
  console.log("BEFORE_TENANT " + JSON.stringify(before))

  const tenant = await prisma.tenant.upsert({
    where: { id: TENANT_ID },
    update: {
      business_name: "EPIC Operators",
      status: "active",
      plan: "pro",
      magnus_did_number: DID,
      voice_forward_to_cell: true,
      voice_cell_number: OWNER_CELL,
    },
    create: {
      id: TENANT_ID,
      business_name: "EPIC Operators",
      status: "active",
      plan: "pro",
      magnus_did_number: DID,
      voice_forward_to_cell: true,
      voice_cell_number: OWNER_CELL,
    },
  })
  console.log("TENANT_UPSERTED " + JSON.stringify(tenant))

  const existingUser = await prisma.user.findFirst({ where: { tenant_id: TENANT_ID, email: OWNER_EMAIL } })
  const user = existingUser
    ? existingUser
    : await prisma.user.create({
        data: {
          tenant_id: TENANT_ID,
          replit_id: "pending:" + OWNER_EMAIL,
          role: "admin",
          email: OWNER_EMAIL,
          name: "Eric",
          intelligence_tier: "standard",
        },
      })
  console.log("USER " + JSON.stringify(user))

  const sub = await prisma.subscription.upsert({
    where: { tenant_id: TENANT_ID },
    update: { plan: "pro", status: "active" },
    create: { tenant_id: TENANT_ID, plan: "pro", status: "active" },
  })
  console.log("SUBSCRIPTION " + JSON.stringify(sub))

  const wallet = await prisma.wallet.upsert({
    where: { tenant_id: TENANT_ID },
    update: {},
    create: { tenant_id: TENANT_ID, balance_cache: 0, balance_minor: 0 },
  })
  console.log("WALLET " + JSON.stringify(wallet))

  const agent = await prisma.agent.upsert({
    where: { tenant_id: TENANT_ID },
    update: {
      name: "EPIC Assistant",
      greeting: GREETING,
      business_info: BUSINESS_INFO,
      knowledge_text: KNOWLEDGE_TEXT,
      intelligence_tier: "standard",
      after_hours_start: "16:00",
      after_hours_end: "08:00",
      away_message: AWAY_MESSAGE,
      timezone: "America/Dominica",
      is_active: true,
    },
    create: {
      tenant_id: TENANT_ID,
      name: "EPIC Assistant",
      greeting: GREETING,
      business_info: BUSINESS_INFO,
      knowledge_text: KNOWLEDGE_TEXT,
      intelligence_tier: "standard",
      after_hours_start: "16:00",
      after_hours_end: "08:00",
      away_message: AWAY_MESSAGE,
      timezone: "America/Dominica",
      is_active: true,
    },
  })
  console.log("AGENT_UPSERTED " + JSON.stringify(agent))

  const verify = await prisma.tenant.findUnique({
    where: { id: TENANT_ID },
    include: { agents: true, whatsapp_numbers: true, chatwoot_binding: true, users: true },
  })
  console.log("VERIFY " + JSON.stringify(verify, null, 2))
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("ERR " + (e && e.message ? e.message : e))
    process.exit(1)
  })
