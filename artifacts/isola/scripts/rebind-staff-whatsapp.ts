/**
 * Rebind a staff member WhatsApp identity - the governed way.
 *
 * People change numbers, change roles and leave. Editing StaffBinding.wa_id by
 * hand looks like it works and then silently delivers nothing, because
 * `enqueueNotification` is FAIL-CLOSED on consent: every basis except
 * `owner_self_notification` requires an `opted_in` Consent row keyed on
 * (tenant_id, phone) in E.164 with a leading +. A rebind that moves the wa_id
 * and forgets the Consent row produces `consent_denied` on the next dispatch,
 * which is recorded as "not enqueued" rather than as an error anyone notices.
 *
 * So this does BOTH, checks the tenant-unique constraint before it writes,
 * reads everything back, and prints the previous value so the change is
 * reversible by copy-paste.
 *
 *   DATABASE_URL="$NEON_PROD_URL" npx tsx scripts/rebind-staff-whatsapp.ts \
 *     --tenant <id> --odoo-user <n> --wa-id <digits> [--execute]
 *
 * Without --execute it validates and prints the plan. Nothing is written.
 */
import { prisma } from "../lib/prisma"
import { staffContactE164 } from "../lib/staff-ops/staff-notification"

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}

const TENANT = arg("tenant")
const ODOO_USER = Number(arg("odoo-user"))
const RAW_WA = (arg("wa-id") ?? "").replace(/\D/g, "")
const EXECUTE = process.argv.includes("--execute")

function abort(why: string): never {
  console.error("ABORT " + why)
  process.exit(1)
}

function mask(v: string | null | undefined): string {
  if (!v) return String(v)
  return v.length <= 4 ? "****" : "*".repeat(v.length - 4) + v.slice(-4)
}

;(async () => {
  if (!TENANT) abort("--tenant is required")
  if (!Number.isInteger(ODOO_USER) || ODOO_USER <= 0) abort("--odoo-user must be a res.users id")
  if (RAW_WA.length < 8 || RAW_WA.length > 15) abort("--wa-id must be 8-15 digits, E.164 without the plus")

  const tenant = await prisma.tenant.findUnique({ where: { id: TENANT }, select: { id: true, business_name: true } })
  if (!tenant) abort(`tenant ${TENANT} does not exist`)

  const binding = await prisma.staffBinding.findFirst({
    where: { tenant_id: TENANT, odoo_res_user_id: ODOO_USER },
    select: { id: true, display_name: true, wa_id: true, role: true, active: true, manager_odoo_res_user_id: true },
  })
  if (!binding) abort(`no StaffBinding for res.users ${ODOO_USER} on this tenant`)

  // wa_id is unique per tenant. Two people sharing one number means every
  // inbound is ambiguous, so this refuses rather than letting the database
  // decide which write wins.
  const clash = await prisma.staffBinding.findFirst({
    where: { tenant_id: TENANT, wa_id: RAW_WA, NOT: { id: binding.id } },
    select: { id: true, display_name: true, odoo_res_user_id: true },
  })
  if (clash) abort(`wa_id already belongs to ${clash.display_name} (res.users ${clash.odoo_res_user_id}) on this tenant`)

  const e164 = staffContactE164(RAW_WA)
  const existingConsent = await prisma.consent.findUnique({
    where: { tenant_id_phone: { tenant_id: TENANT, phone: e164 } },
    select: { id: true, status: true, source: true },
  })

  console.log("PLAN " + JSON.stringify({
    tenant: tenant.business_name,
    staff: binding.display_name,
    odoo_res_user_id: ODOO_USER,
    role: binding.role,
    active: binding.active,
    manager_odoo_res_user_id: binding.manager_odoo_res_user_id,
    previous_wa_id: binding.wa_id,
    previous_wa_id_masked: mask(binding.wa_id),
    new_wa_id: RAW_WA,
    new_contact_e164: e164,
    consent_row: existingConsent ? existingConsent.status : "MISSING - will be created opted_in",
  }))
  console.log(`RESTORE_WITH --tenant ${TENANT} --odoo-user ${ODOO_USER} --wa-id ${binding.wa_id ?? "NONE"} --execute`)

  if (!EXECUTE) {
    console.log("DRY_RUN - nothing written. Re-run with --execute.")
    await prisma.$disconnect()
    process.exit(0)
  }

  // Consent FIRST. If the rebind landed and the consent write then failed, the
  // staff member would be unreachable with no obvious cause; this order leaves
  // an unused consent row instead, which is harmless.
  const consent = await prisma.consent.upsert({
    where: { tenant_id_phone: { tenant_id: TENANT, phone: e164 } },
    create: { tenant_id: TENANT, phone: e164, status: "opted_in", source: "explicit" },
    update: { status: "opted_in", opted_out_at: null },
    select: { id: true, phone: true, status: true, source: true },
  })
  console.log("CONSENT " + JSON.stringify({ ...consent, phone: mask(consent.phone) }))

  const updated = await prisma.staffBinding.update({
    where: { id: binding.id },
    data: { wa_id: RAW_WA },
    select: { id: true, display_name: true, wa_id: true, odoo_res_user_id: true, role: true, active: true, manager_odoo_res_user_id: true },
  })

  const checks = {
    wa_id_stored: updated.wa_id === RAW_WA,
    same_person: updated.odoo_res_user_id === ODOO_USER,
    still_active: updated.active === true,
    manager_link_intact: updated.manager_odoo_res_user_id === binding.manager_odoo_res_user_id,
    consent_opted_in: consent.status === "opted_in",
  }
  console.log("READBACK " + JSON.stringify({ ...updated, wa_id: mask(updated.wa_id) }))
  console.log("CHECKS " + JSON.stringify(checks))
  const bad = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k)
  if (bad.length) abort(`rebind readback FAILED: ${bad.join(", ")}`)

  // Inbound routing resolves a sender by wa_id, so prove the new number now
  // resolves to exactly one person and to the right one.
  const resolved = await prisma.staffBinding.findMany({
    where: { tenant_id: TENANT, wa_id: RAW_WA },
    select: { id: true, display_name: true, odoo_res_user_id: true },
  })
  console.log("INBOUND_RESOLVES_TO " + JSON.stringify(resolved))
  if (resolved.length !== 1 || resolved[0].id !== binding.id) abort("the new number does not resolve to exactly this staff member")

  console.log("REBIND_OK")
  await prisma.$disconnect()
  process.exit(0)
})().catch(async (e: any) => {
  console.error("ERR " + (e?.message ?? e))
  try { await prisma.$disconnect() } catch {}
  process.exit(1)
})
