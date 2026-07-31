/**
 * Repoint a staff member VERIFIER - the governed way.
 *
 * `StaffBinding.manager_odoo_res_user_id` is the only thing that decides who
 * verifies a completion. It is not stored on the task, so a manager who is
 * unavailable cannot be worked around by editing the work item; the binding
 * has to move. People go on leave, change teams and leave the company, so this
 * is a capability rather than a hand-edit somebody remembers to do correctly.
 *
 * WHAT IT REFUSES, AND WHY EACH ONE MATTERS
 *   - a verifier with no StaffBinding: the manager notification resolves the
 *     handset through the binding, so there would be nobody to notify;
 *   - a verifier whose role is not manager or owner: `resolveInboundManagerTap`
 *     rejects the verdict tap, so the activity would be created and then be
 *     unresolvable;
 *   - a verifier with no wa_id, or no opted_in Consent row: consent is
 *     FAIL-CLOSED, so the notification returns consent_denied and is recorded
 *     as "not enqueued" rather than as an error anyone notices;
 *   - a verifier who is not an active, non-share user in ODOO: the
 *     mail.activity assigns to that res.users id, and an activity assigned to
 *     a disabled or portal user is a record nobody can action;
 *   - self-verification: a staff member approving their own completion is not
 *     verification, it is a formality with extra steps.
 *
 *   DATABASE_URL="$NEON_PROD_URL" npx tsx scripts/rebind-staff-manager.ts \
 *     --tenant <id> --odoo-user <staff> --manager <verifier> [--execute]
 */
import { prisma } from "../lib/prisma"
import { staffContactE164 } from "../lib/staff-ops/staff-notification"
import { resolveOdooConfigForTenant } from "../lib/engine-bindings"
import { json2Call } from "../engines/odoo"

function arg(n: string): string | null {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}
const TENANT = arg("tenant")
const STAFF = Number(arg("odoo-user"))
const MANAGER = Number(arg("manager"))
const EXECUTE = process.argv.includes("--execute")

function abort(w: string): never { console.error("ABORT " + w); process.exit(1) }
function mask(v: string | null): string { return !v ? String(v) : "*".repeat(Math.max(0, v.length - 4)) + v.slice(-4) }

;(async () => {
  if (!TENANT) abort("--tenant is required")
  if (!Number.isInteger(STAFF) || STAFF <= 0) abort("--odoo-user must be a res.users id")
  if (!Number.isInteger(MANAGER) || MANAGER <= 0) abort("--manager must be a res.users id")
  if (STAFF === MANAGER) abort("a staff member cannot verify their own completion")

  const sel = { id: true, display_name: true, odoo_res_user_id: true, role: true, active: true, wa_id: true, manager_odoo_res_user_id: true }
  const staff = await prisma.staffBinding.findFirst({ where: { tenant_id: TENANT, odoo_res_user_id: STAFF }, select: sel })
  if (!staff) abort(`no StaffBinding for res.users ${STAFF}`)

  const mgr = await prisma.staffBinding.findFirst({ where: { tenant_id: TENANT, odoo_res_user_id: MANAGER }, select: sel })
  if (!mgr) abort(`no StaffBinding for the proposed verifier res.users ${MANAGER} - nobody to notify`)
  if (!mgr.active) abort("the proposed verifier binding is inactive")
  if (mgr.role !== "manager" && mgr.role !== "owner") abort(`verifier role is ${mgr.role} - resolveInboundManagerTap would reject the verdict`)
  if (!mgr.wa_id) abort("the proposed verifier has no WhatsApp identity")

  const consent = await prisma.consent.findUnique({
    where: { tenant_id_phone: { tenant_id: TENANT, phone: staffContactE164(mgr.wa_id) } },
    select: { status: true },
  })
  if (!consent || consent.status !== "opted_in") abort("the verifier has no opted_in Consent row - the notification would be silently dropped")

  const cfg = await resolveOdooConfigForTenant(TENANT)
  const users = (await json2Call(cfg, "res.users", "search_read", {
    domain: [["id", "=", MANAGER]], fields: ["id", "name", "active", "share"], limit: 1,
  }, 15000)) as Record<string, unknown>[]
  const u = users?.[0]
  if (!u) abort(`res.users ${MANAGER} does not exist in Odoo`)
  if (u.active !== true) abort(`res.users ${MANAGER} is archived in Odoo - the activity would be unactionable`)
  if (u.share === true) abort(`res.users ${MANAGER} is a portal user - it cannot own an internal activity`)

  console.log("PLAN " + JSON.stringify({
    staff: staff.display_name, staff_res_user: STAFF,
    previous_verifier: staff.manager_odoo_res_user_id,
    new_verifier: MANAGER, new_verifier_name: mgr.display_name, new_verifier_role: mgr.role,
    new_verifier_handset: mask(mgr.wa_id), odoo_user_ok: `${u.name} active non-share`,
  }))
  console.log(`RESTORE_WITH --tenant ${TENANT} --odoo-user ${STAFF} --manager ${staff.manager_odoo_res_user_id ?? "NONE"} --execute`)

  if (!EXECUTE) { console.log("DRY_RUN"); await prisma.$disconnect(); process.exit(0) }

  const updated = await prisma.staffBinding.update({
    where: { id: staff.id }, data: { manager_odoo_res_user_id: MANAGER }, select: sel,
  })
  const checks = {
    verifier_stored: updated.manager_odoo_res_user_id === MANAGER,
    same_person: updated.odoo_res_user_id === STAFF,
    staff_handset_unchanged: updated.wa_id === staff.wa_id,
    staff_still_active: updated.active === true,
  }
  console.log("READBACK " + JSON.stringify({ ...updated, wa_id: mask(updated.wa_id) }))
  console.log("CHECKS " + JSON.stringify(checks))
  const bad = Object.entries(checks).filter(([, v]) => v !== true).map(([k]) => k)
  if (bad.length) abort(`readback FAILED: ${bad.join(", ")}`)
  console.log("VERIFIER_REBIND_OK")
  await prisma.$disconnect()
  process.exit(0)
})().catch(async (e: any) => {
  console.error("ERR " + (e?.message ?? e))
  try { await prisma.$disconnect() } catch {}
  process.exit(1)
})
