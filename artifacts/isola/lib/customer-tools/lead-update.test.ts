import { describe, it, expect, vi } from "vitest"
import {
  LEAD_UPDATE_TOOL,
  isClosedLead,
  normaliseChanges,
  updateGovernedLead,
  type LeadUpdateDeps,
  type LeadUpdateInput,
  type LeadUpdatePolicy,
} from "./lead-update"
import { createFakeOperationStore } from "./fake-operation-store"
import type { OdooConfig } from "@/engines/odoo"

const CONFIG: OdooConfig = { url: "https://tenant.odoo.example", db: "tenant", apiKey: "never-logged" }
const PARTNER = 605
const OTHER_PARTNER = 999

function leadRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4242,
    name: "Smart Business Line",
    type: "opportunity",
    partner_id: [PARTNER, "Brent Symes"],
    stage_id: [1, "New"],
    team_id: [1, "Sales"],
    user_id: [5, "Phillip"],
    description: "original body",
    active: true,
    probability: 30,
    write_date: "2026-07-30 10:00:00",
    ...over,
  }
}

function input(over: Partial<LeadUpdateInput> = {}): LeadUpdateInput {
  return {
    tenantId: "43b006e4-33e0-42a8-bec7-4422ba290d79",
    leadId: 4242,
    expectedPartnerId: PARTNER,
    changes: { nextStep: "Call back Thursday" },
    chatwootConversationId: "conv-9001",
    clawithSessionId: "sess-1",
    correlationId: "corr-1",
    operationIdHint: "hint-abc",
    ...over,
  }
}

function policy(over: Partial<LeadUpdatePolicy> = {}): LeadUpdatePolicy {
  return {
    allowUpdates: true,
    approvedStageIds: [2, 3],
    approvedSalesTeamIds: [1],
    approvedSalespersonUserIds: [5],
    allowClosedRecordUpdates: false,
    ...over,
  }
}

/** Writes are applied to a mutable row so the readback reflects them, like Odoo. */
function deps(row = leadRow(), over: Partial<LeadUpdateDeps> = {}): LeadUpdateDeps & { row: Record<string, unknown> } {
  const state = { ...row }
  const d = {
    row: state,
    resolveConfig: vi.fn(async () => CONFIG),
    readLead: vi.fn(async () => ({ ...state })),
    readPipelineStageIds: vi.fn(async () => [1, 2, 3]),
    writeLead: vi.fn(async (_c: OdooConfig, _id: number, vals: Record<string, unknown>) => {
      if (vals.name !== undefined) state.name = vals.name
      if (vals.stage_id !== undefined) state.stage_id = [vals.stage_id, "Moved"]
      if (vals.team_id !== undefined) state.team_id = [vals.team_id, "Team"]
      if (vals.user_id !== undefined) state.user_id = [vals.user_id, "Person"]
      if (vals.description !== undefined) state.description = vals.description
    }),
    store: createFakeOperationStore(),
    ...over,
  }
  return d as LeadUpdateDeps & { row: Record<string, unknown> }
}

describe("updateGovernedLead - ownership is checked, not assumed", () => {
  it("REFUSES a lead belonging to a different customer", async () => {
    const d = deps(leadRow({ partner_id: [OTHER_PARTNER, "Someone else"] }))
    const r = await updateGovernedLead(input(), policy(), d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("target_not_owned_by_customer")
    expect(d.writeLead).not.toHaveBeenCalled()
  })

  it("refuses a lead that does not exist", async () => {
    const d = deps(undefined, { readLead: vi.fn(async () => null) })
    const r = await updateGovernedLead(input(), policy(), d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("target_not_found")
  })

  it("requires an expected partner rather than trusting the lead id alone", async () => {
    const r = await updateGovernedLead(input({ expectedPartnerId: 0 }), policy(), deps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("invalid_input")
  })
})

describe("updateGovernedLead - closed records are commercial facts", () => {
  it.each([
    ["archived", { active: false }],
    ["won", { probability: 100 }],
    ["lost", { probability: 0 }],
  ])("refuses to edit a %s lead by default", async (_l, over) => {
    const d = deps(leadRow(over))
    const r = await updateGovernedLead(input(), policy(), d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("target_closed")
    expect(d.writeLead).not.toHaveBeenCalled()
  })

  it("allows it only when policy explicitly says so", async () => {
    const d = deps(leadRow({ probability: 100 }))
    const r = await updateGovernedLead(input(), policy({ allowClosedRecordUpdates: true }), d)
    expect(r.ok).toBe(true)
  })

  it("isClosedLead is honest about an open lead", () => {
    expect(isClosedLead(leadRow())).toBe(false)
  })
})

describe("updateGovernedLead - stage movement is the sharp edge", () => {
  it("refuses a stage the tenant has not approved for agent movement", async () => {
    const d = deps()
    const r = await updateGovernedLead(input({ changes: { stageId: 9 } }), policy(), d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("stage_not_approved")
    expect(d.writeLead).not.toHaveBeenCalled()
  })

  it("refuses an approved stage that is not on THIS lead own pipeline", async () => {
    const d = deps(undefined, { readPipelineStageIds: vi.fn(async () => [1]) })
    const r = await updateGovernedLead(input({ changes: { stageId: 2 } }), policy(), d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain("own pipeline")
  })

  it("moves the deal when the stage is both approved and on the pipeline", async () => {
    const d = deps()
    const r = await updateGovernedLead(input({ changes: { stageId: 2 } }), policy(), d)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.applied.changedKeys).toEqual(["stageId"])
  })

  it("refuses an unapproved salesperson or team", async () => {
    const a = await updateGovernedLead(input({ changes: { salespersonUserId: 77 } }), policy(), deps())
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.code).toBe("assignee_not_approved")
    const b = await updateGovernedLead(input({ changes: { salesTeamId: 77 } }), policy(), deps())
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.code).toBe("assignee_not_approved")
  })
})

describe("updateGovernedLead - only approved changes reach Odoo", () => {
  it("drops anything that is not on the semantic allowlist", () => {
    const out = normaliseChanges({ nextStep: "x", ...( { partner_id: 1, active: false, __proto__: null } as object) })
    expect(Object.keys(out)).toEqual(["nextStep"])
  })

  it("refuses when nothing in the request maps to an approved change", async () => {
    const d = deps()
    const r = await updateGovernedLead(input({ changes: { serviceInterest: "   " } }), policy(), d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("no_approved_changes")
    expect(d.resolveConfig).not.toHaveBeenCalled()
  })

  it("appends to the description rather than rewriting what was already there", async () => {
    const d = deps()
    await updateGovernedLead(input({ changes: { customerNote: "prefers WhatsApp" } }), policy(), d)
    const vals = (d.writeLead as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as Record<string, unknown>
    expect(String(vals.description)).toContain("original body")
    expect(String(vals.description)).toContain("prefers WhatsApp")
    expect(vals.partner_id).toBeUndefined()
    expect(vals.active).toBeUndefined()
  })

  it("never writes a column for a change that was not requested", async () => {
    const d = deps()
    await updateGovernedLead(input({ changes: { serviceInterest: "Fibre upgrade" } }), policy(), d)
    const vals = (d.writeLead as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as Record<string, unknown>
    expect(Object.keys(vals)).toEqual(["name"])
  })
})

describe("updateGovernedLead - the write is proven, and proven once", () => {
  it("verifies each requested change individually and reports one that did not land", async () => {
    const d = deps(undefined, { writeLead: vi.fn(async () => { /* silently drops everything */ }) })
    const r = await updateGovernedLead(input({ changes: { serviceInterest: "Fibre upgrade" } }), policy(), d)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe("readback_failed")
      expect(r.detail).toContain("serviceInterest")
    }
  })

  it("returns the recorded result on a retry without writing again", async () => {
    const d = deps()
    const first = await updateGovernedLead(input(), policy(), d)
    expect(first.ok).toBe(true)
    const retry = await updateGovernedLead(input(), policy(), d)
    expect(retry.ok).toBe(true)
    if (retry.ok) expect(retry.reused).toBe("recorded_operation")
    expect(d.writeLead).toHaveBeenCalledTimes(1)
  })

  it("refuses a reused hint carrying different authorised changes", async () => {
    const d = deps()
    await updateGovernedLead(input(), policy(), d)
    const store = d.store as ReturnType<typeof createFakeOperationStore>
    store.rows[0].request_hash = "different"
    const again = await updateGovernedLead(input(), policy(), d)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.code).toBe("operation_conflict")
    expect(d.writeLead).toHaveBeenCalledTimes(1)
  })

  it("records FAILED when Odoo rejects the write", async () => {
    const d = deps(undefined, { writeLead: vi.fn(async () => { throw new Error("access denied") }) })
    const r = await updateGovernedLead(input(), policy(), d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("odoo_unavailable")
    const store = d.store as ReturnType<typeof createFakeOperationStore>
    expect(store.rows[0].state).toBe("failed")
  })

  it("reports the tool name and never leaks the api key", async () => {
    const r = await updateGovernedLead(input(), policy(), deps())
    expect(r.tool).toBe(LEAD_UPDATE_TOOL)
    expect(JSON.stringify(r)).not.toContain("never-logged")
  })
})
