import { describe, it, expect } from "vitest"
import { STAFF_PHONE_NUMBER_ID_ENV, isStaffNotification, resolveStaffChannel } from "./staff-channel"

/** The two numbers that actually exist on the EPIC tenant, in creation order. */
const CUSTOMER_6737 = "278390858690809" // +17672956737, created 2026-07-17 - EARLIEST
const STAFF_9043 = "1029700810228517" // +17678189043, created 2026-07-28

function env(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return over as NodeJS.ProcessEnv
}

describe("resolveStaffChannel", () => {
  it("selects the explicitly configured staff channel", () => {
    const r = resolveStaffChannel(env({ [STAFF_PHONE_NUMBER_ID_ENV]: STAFF_9043 }))
    expect(r).toEqual({ ok: true, phoneNumberId: STAFF_9043 })
  })

  it("fails closed when the staff channel is not configured", () => {
    const r = resolveStaffChannel(env({}))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain(STAFF_PHONE_NUMBER_ID_ENV)
  })

  it("fails closed on a blank or whitespace value rather than treating it as absent-but-fine", () => {
    expect(resolveStaffChannel(env({ [STAFF_PHONE_NUMBER_ID_ENV]: "   " })).ok).toBe(false)
  })

  it("fails closed on a value that is not a Meta phone_number_id", () => {
    expect(resolveStaffChannel(env({ [STAFF_PHONE_NUMBER_ID_ENV]: "+17678189043" })).ok).toBe(false)
  })

  it("NEVER yields the customer 6737 line when the staff channel is unconfigured", () => {
    const r = resolveStaffChannel(env({}))
    expect(JSON.stringify(r)).not.toContain(CUSTOMER_6737)
  })

  it("ignores record creation order entirely - it reads configuration, not a table", () => {
    // The customer line is the tenant EARLIEST-created number. The old rule
    // would have picked it. This one cannot see the table at all.
    const r = resolveStaffChannel(env({ [STAFF_PHONE_NUMBER_ID_ENV]: STAFF_9043 }))
    expect(r.ok && r.phoneNumberId).toBe(STAFF_9043)
    expect(r.ok && r.phoneNumberId).not.toBe(CUSTOMER_6737)
  })

  it("is unambiguous when a tenant owns several numbers - exactly one is configured", () => {
    // Two numbers exist on this tenant; only the configured id can be returned,
    // so "which one" is never a judgement the send path has to make.
    const r = resolveStaffChannel(env({ [STAFF_PHONE_NUMBER_ID_ENV]: STAFF_9043 }))
    expect(r.ok).toBe(true)
    const other = resolveStaffChannel(env({ [STAFF_PHONE_NUMBER_ID_ENV]: CUSTOMER_6737 }))
    // Configuring the customer line is an operator error this module cannot
    // detect - but it can guarantee the value SENT is the value CONFIGURED,
    // which is what makes the misconfiguration findable in one place.
    expect(other.ok && other.phoneNumberId).toBe(CUSTOMER_6737)
  })
})

describe("isStaffNotification", () => {
  it("classifies a row carrying a work ref as staff", () => {
    expect(isStaffNotification({ work_ref_model: "project.task" })).toBe(true)
  })

  it("classifies a customer notification as not staff", () => {
    expect(isStaffNotification({ work_ref_model: null })).toBe(false)
    expect(isStaffNotification({})).toBe(false)
    expect(isStaffNotification({ work_ref_model: "" })).toBe(false)
  })
})
