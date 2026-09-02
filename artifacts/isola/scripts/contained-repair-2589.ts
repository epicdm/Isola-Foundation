/**
 * CONTAINED production repair + targeted drain for the task-2589 staff dispatch.
 *
 * Authority: dec-staff-template-contained-production-repair-before-publish-2026-07-30.
 *
 * Bounded to exactly two rows and one send. It validates first and ABORTS
 * before touching anything if the production state is not the controlled state
 * it expects - a repair script that proceeds on a surprise is just an outage
 * with better intentions.
 *
 *   DATABASE_URL="$NEON_PROD_URL" npx tsx scripts/contained-repair-2589.ts --execute
 *
 * Without --execute it validates and reports, and writes nothing.
 */
import { prisma } from "../lib/prisma"
import { createHash } from "node:crypto"
import {
  INTERNAL_TASK_TEMPLATE,
  INTERNAL_TASK_TEMPLATE_PARAM_COUNT,
  buildStaffTaskTemplateParams,
} from "../lib/staff-ops/staff-notification"
import { resolveStaffChannel } from "../lib/staff-ops/staff-channel"
import { drainNotificationOutbox } from "../lib/notify-drain"

const TENANT = "43b006e4-33e0-42a8-bec7-4422ba290d79"
const ROW_2588 = "cms54h9cz0001s62muhnoqai2"
const ROW_2589 = "cms6ywv24000ss62q6bgqn07s"
const CUSTOMER_6737_PHONE_ID: string = "278390858690809"
const EXPECTED_STAFF_PHONE_ID: string = "1029700810228517"

const DEAD_LETTER_REASON =
  "Historical controlled-pilot dispatch frozen with malformed one-parameter payload before template fix 974d6c5; intentionally not redelivered."

const EXECUTE = process.argv.includes("--execute")

function abort(why: string): never {
  console.error("ABORT " + why)
  process.exit(1)
}

function mask(v: string): string {
  return v.length <= 4 ? "****" : "*".repeat(v.length - 4) + v.slice(-4)
}

function fingerprint(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16)
}

;(async () => {
  // ---- VALIDATE -----------------------------------------------------------
  const rows = await prisma.notificationOutbox.findMany({
    where: { state: { in: ["pending", "failed"] } },
    orderBy: { created_at: "asc" },
  })
  console.log("DRAINABLE_TENANT_WIDE " + JSON.stringify(rows.map((r) => ({
    id: r.id, work_ref_id: r.work_ref_id, tenant: r.tenant_id, state: r.state, template: r.template,
  }))))
  if (rows.length !== 2) abort(`expected exactly 2 drainable rows, found ${rows.length}`)

  const r2588 = rows.find((r) => r.id === ROW_2588)
  const r2589 = rows.find((r) => r.id === ROW_2589)
  if (!r2588) abort("the 2588 row is not in the drainable set")
  if (!r2589) abort("the 2589 row is not in the drainable set")
  if (r2588.tenant_id !== TENANT || r2589.tenant_id !== TENANT) abort("tenant mismatch")
  if (r2588.work_ref_id !== 2588) abort("2588 row does not reference task 2588")
  if (r2589.work_ref_id !== 2589) abort("2589 row does not reference task 2589")
  if (r2588.template !== INTERNAL_TASK_TEMPLATE || r2589.template !== INTERNAL_TASK_TEMPLATE) abort("template mismatch")
  if (r2589.external_ref) abort("the 2589 row already carries a provider message id - it may already have been sent")

  const channel = resolveStaffChannel()
  if (!channel.ok) abort("staff channel unresolved: " + channel.reason)
  if (channel.phoneNumberId !== EXPECTED_STAFF_PHONE_ID) abort("staff channel is not the expected staff line")
  if (channel.phoneNumberId === CUSTOMER_6737_PHONE_ID) abort("staff channel resolves to the CUSTOMER 6737 line")

  const staffNumber = await prisma.whatsAppNumber.findFirst({
    where: { phone_number_id: channel.phoneNumberId, tenant_id: TENANT },
    select: { phone_number_id: true, phone_number: true, display_name: true },
  })
  if (!staffNumber) abort("configured staff phone_number_id does not belong to this tenant")

  const binding = await prisma.staffBinding.findFirst({
    where: { tenant_id: TENANT, odoo_res_user_id: 8 },
    select: { display_name: true, wa_id: true, active: true },
  })
  if (!binding?.wa_id) abort("no WhatsApp identity on the Hakeem StaffBinding")
  if (!binding.active) abort("Hakeem StaffBinding is inactive")
  if (r2589.contact.replace(/\D/g, "") !== binding.wa_id.replace(/\D/g, "")) {
    abort("the 2589 row recipient is not Hakeem")
  }

  const payload = (r2589.payload ?? {}) as Record<string, unknown>
  const old = Array.isArray(payload.templateParams) ? (payload.templateParams as unknown[]) : []
  if (old.length === INTERNAL_TASK_TEMPLATE_PARAM_COUNT) abort("the 2589 payload is already repaired - nothing to do")

  const rebuilt = buildStaffTaskTemplateParams({
    workRefId: 2589,
    staffName: typeof old[0] === "string" ? old[0] : binding.display_name,
    workTitle: typeof old[1] === "string" ? old[1] : "",
    projectName: typeof old[2] === "string" ? old[2] : null,
    dueDate: null,
  })
  if (rebuilt.length !== INTERNAL_TASK_TEMPLATE_PARAM_COUNT) abort("rebuilt payload has the wrong parameter count")
  if (rebuilt[0] !== "#2589") abort("slot 1 is not the authoritative WorkRef")

  console.log("PLAN " + JSON.stringify({
    dead_letter_row: ROW_2588,
    repair_row: ROW_2589,
    template: INTERNAL_TASK_TEMPLATE,
    param_count_before: old.length,
    param_count_after: rebuilt.length,
    work_ref: "project.task#2589",
    tenant: TENANT,
    staff_phone_number_id: staffNumber.phone_number_id,
    staff_line: staffNumber.phone_number,
    recipient: mask(r2589.contact),
    dedupe_key_unchanged: r2589.dedupe_key,
    payload_fingerprint_before: fingerprint(old),
    payload_fingerprint_after: fingerprint(rebuilt),
    slot1: rebuilt[0],
  }))
  console.log("PARAMS " + JSON.stringify(rebuilt))

  if (!EXECUTE) {
    console.log("DRY_RUN - nothing written. Re-run with --execute.")
    await prisma.$disconnect()
    process.exit(0)
  }

  // ---- 2588: terminal, evidence preserved ---------------------------------
  const dead = await prisma.notificationOutbox.update({
    where: { id: ROW_2588 },
    data: { state: "dead_letter", next_attempt_at: null, failed_at: new Date(), failure_reason: DEAD_LETTER_REASON },
    select: { id: true, state: true, work_ref_id: true, dedupe_key: true, failure_reason: true, attempt_count: true, payload: true },
  })
  const deadPayload = (dead.payload ?? {}) as Record<string, unknown>
  const deadParams = Array.isArray(deadPayload.templateParams) ? (deadPayload.templateParams as unknown[]) : []
  console.log("DEAD_LETTERED " + JSON.stringify({
    id: dead.id, state: dead.state, work_ref_id: dead.work_ref_id, dedupe_key: dead.dedupe_key,
    attempt_count: dead.attempt_count, evidence_param_count_preserved: deadParams.length,
    reason: dead.failure_reason,
  }))
  if (dead.state !== "dead_letter") abort("2588 did not reach a terminal state")
  if (deadParams.length !== old.length) abort("2588 payload evidence was altered")

  // ---- 2589: repair in place ----------------------------------------------
  const fixed = await prisma.notificationOutbox.update({
    where: { id: ROW_2589 },
    data: {
      payload: { ...payload, templateParams: rebuilt },
      state: "pending",
      attempt_count: 0,
      next_attempt_at: new Date(),
      failure_reason: null,
    },
    select: { id: true, state: true, attempt_count: true, dedupe_key: true, payload: true },
  })
  const fixedPayload = (fixed.payload ?? {}) as Record<string, unknown>
  const fixedParams = Array.isArray(fixedPayload.templateParams) ? (fixedPayload.templateParams as unknown[]) : []
  console.log("REPAIRED " + JSON.stringify({
    id: fixed.id, state: fixed.state, attempt_count: fixed.attempt_count,
    dedupe_key: fixed.dedupe_key, param_count: fixedParams.length,
    payload_fingerprint: fingerprint(fixedParams), slot1: fixedParams[0],
  }))
  if (fixedParams.length !== INTERNAL_TASK_TEMPLATE_PARAM_COUNT) abort("repair readback has the wrong parameter count")
  if (fixedParams[0] !== "#2589") abort("repair readback slot 1 is wrong")
  if (fixed.dedupe_key !== r2589.dedupe_key) abort("dedupe key changed")

  // ---- Exclusivity: the drain can only touch 2589 --------------------------
  const claimable = await prisma.notificationOutbox.findMany({
    where: { state: { in: ["pending", "failed"] }, next_attempt_at: { lte: new Date(Date.now() + 60_000) } },
    select: { id: true, work_ref_id: true },
  })
  console.log("CLAIMABLE_BEFORE_DRAIN " + JSON.stringify(claimable))
  if (claimable.length !== 1 || claimable[0].id !== ROW_2589) {
    abort("the drain is not provably targeted - refusing to run it")
  }

  // ---- Targeted drain ------------------------------------------------------
  const result = await drainNotificationOutbox()
  console.log("DRAIN " + JSON.stringify(result))

  const after = await prisma.notificationOutbox.findUnique({
    where: { id: ROW_2589 },
    select: {
      id: true, work_ref_id: true, state: true, attempt_count: true, external_ref: true,
      sent_at: true, provider_status: true, delivered_at: true, failure_reason: true,
    },
  })
  console.log("OUTBOX_AFTER " + JSON.stringify(after))
  if (after?.state === "sent" && after.external_ref) {
    console.log("SEND_ACCEPTED wamid=" + after.external_ref)
    console.log("NOTE accepted by Meta is not delivery - handset confirmation and the wa-status callback are the delivery evidence")
  } else {
    console.log("SEND_NOT_ACCEPTED - see failure_reason above")
  }

  await prisma.$disconnect()
  process.exit(0)
})().catch(async (e: any) => {
  console.error("ERR " + (e?.message ?? e))
  try { await prisma.$disconnect() } catch {}
  process.exit(1)
})
