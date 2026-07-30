/**
 * Dispatch pilot task 2590 through the NORMAL application path.
 *
 * Not a repair. 2590 has never been dispatched, so it gets a fresh correlation
 * id and a fresh dedupe key, and its payload is built by dispatchWorkToStaff /
 * buildStaffNotification exactly as production will build it once 974d6c5 is
 * published. That is what makes this the proof the forward fix works unaided:
 * the 2589 send needed its frozen payload repaired first, so it proved the
 * sender, not the builder.
 *
 * It runs from the WORKSPACE against the production database because the
 * deployed SHA b8764d7 still carries the four-parameter builder. Publishing
 * only to unblock a pilot is not authorised, so the corrected code runs here.
 *
 *   DATABASE_URL="$NEON_PROD_URL" npx tsx scripts/dispatch-pilot-2590.ts [--execute]
 */
import { prisma } from "../lib/prisma"
import { findBindingByOdooUser, listOpenWorkForStaff, dispatchWorkToStaff } from "../lib/staff-ops/service"
import { drainNotificationOutbox } from "../lib/notify-drain"
import { INTERNAL_TASK_TEMPLATE_PARAM_COUNT } from "../lib/staff-ops/staff-notification"
import { resolveStaffChannel } from "../lib/staff-ops/staff-channel"

const TENANT = "43b006e4-33e0-42a8-bec7-4422ba290d79"
const TASK = 2590
const EXPECTED_WA = "14158408440"
const EXECUTE = process.argv.includes("--execute")

function abort(why: string): never { console.error("ABORT " + why); process.exit(1) }
function mask(v: string): string { return "*".repeat(Math.max(0, v.length - 4)) + v.slice(-4) }

;(async () => {
  const binding = await findBindingByOdooUser(TENANT, 8)
  if (!binding) abort("no StaffBinding for res.users 8")
  if (binding.waId !== EXPECTED_WA) abort("binding wa_id is not the rebound test handset")

  const channel = resolveStaffChannel()
  if (!channel.ok) abort("staff channel unresolved: " + channel.reason)

  const work = (await listOpenWorkForStaff(binding)).find((w) => w.odooId === TASK)
  if (!work) abort("task 2590 is not open work for this staff member")

  console.log("PLAN " + JSON.stringify({
    staff: binding.displayName, recipient: mask(binding.waId ?? ""),
    task: work.odooId, stage: work.stageName,
    correlationId: work.correlationId, staff_phone_number_id: channel.phoneNumberId,
  }))

  if (!EXECUTE) { console.log("DRY_RUN"); await prisma.$disconnect(); process.exit(0) }

  const result = await dispatchWorkToStaff({ binding, work, proactive: true })
  console.log("ENQUEUE " + JSON.stringify(result))
  if (!("enqueued" in result) || !result.enqueued) abort("dispatch was not enqueued")

  const row = await prisma.notificationOutbox.findUnique({
    where: { id: result.id },
    select: { id: true, contact: true, template: true, state: true, dedupe_key: true, payload: true, work_ref_id: true },
  })
  if (!row) abort("enqueued row not readable")
  const params = Array.isArray((row.payload as any)?.templateParams) ? (row.payload as any).templateParams : []
  console.log("PAYLOAD " + JSON.stringify({
    id: row.id, work_ref_id: row.work_ref_id, template: row.template,
    param_count: params.length, slot1: params[0], recipient: mask(row.contact),
    dedupe_key: row.dedupe_key,
  }))
  if (params.length !== INTERNAL_TASK_TEMPLATE_PARAM_COUNT) abort("wrong parameter count built")
  if (params[0] !== "#2590") abort("slot 1 is not the authoritative WorkRef")

  const claimable = await prisma.notificationOutbox.findMany({
    where: { state: { in: ["pending", "failed"] }, next_attempt_at: { lte: new Date(Date.now() + 60000) } },
    select: { id: true, work_ref_id: true },
  })
  console.log("CLAIMABLE " + JSON.stringify(claimable))
  if (claimable.length !== 1 || claimable[0].id !== row.id) abort("the drain would not be targeted - refusing to run it")

  console.log("DRAIN " + JSON.stringify(await drainNotificationOutbox()))
  const after = await prisma.notificationOutbox.findUnique({
    where: { id: row.id },
    select: { state: true, external_ref: true, sent_at: true, provider_status: true, delivered_at: true, failure_reason: true },
  })
  console.log("AFTER " + JSON.stringify(after))
  await prisma.$disconnect()
  process.exit(0)
})().catch(async (e: any) => {
  console.error("ERR " + (e?.message ?? e))
  try { await prisma.$disconnect() } catch {}
  process.exit(1)
})
