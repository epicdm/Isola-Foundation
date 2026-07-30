import { describe, it, expect, vi } from "vitest"
import {
  FOLLOW_UP_TOOL,
  createGovernedFollowUp,
  isFollowUpTargetModel,
  renderFollowUpNote,
  type FollowUpDeps,
  type FollowUpInput,
  type FollowUpPolicy,
} from "./follow-up"
import { createFakeOperationStore } from "./fake-operation-store"
import { WORK_REF_MODELS } from "@/lib/staff-ops/work-ref"
import type { OdooConfig } from "@/engines/odoo"

const CONFIG: OdooConfig = { url: "https://tenant.odoo.example", db: "tenant", apiKey: "never-logged" }
const PARTNER = 605
const RES_MODEL_ID = 512
const ACTIVITY_TYPE = { activityTypeId: 4, name: "To-Do" }

function activityRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 8801,
    res_model: "crm.lead",
    res_model_id: [RES_MODEL_ID, "crm.lead"],
    res_id: 4242,
    user_id: [5, "Phillip"],
    activity_type_id: [4, "To-Do"],
    summary: "Send the fibre quote",
    date_deadline: "2026-08-05",
    ...over,
  }
}

function input(over: Partial<FollowUpInput> = {}): FollowUpInput {
  return {
    tenantId: "43b006e4-33e0-42a8-bec7-4422ba290d79",
    targetModel: "crm.lead",
    targetId: 4242,
    expectedPartnerId: PARTNER,
    assigneeUserId: 5,
    purpose: "Send the fibre quote",
    deadline: "2026-08-05",
    chatwootConversationId: "conv-9001",
    clawithSessionId: "sess-1",
    correlationId: "corr-1",
    operationIdHint: "hint-abc",
    leadReference: 4242,
    ...over,
  }
}

function policy(over: Partial<FollowUpPolicy> = {}): FollowUpPolicy {
  return { allowFollowUps: true, approvedAssigneeUserIds: [5], ...over }
}

function deps(over: Partial<FollowUpDeps> = {}): FollowUpDeps {
  return {
    resolveConfig: vi.fn(async () => CONFIG),
    resolveResModelId: vi.fn(async () => RES_MODEL_ID),
    resolveActivityType: vi.fn(async () => ACTIVITY_TYPE),
    readTargetPartnerId: vi.fn(async () => PARTNER),
    createActivity: vi.fn(async () => 8801),
    readActivity: vi.fn(async () => activityRow()),
    store: createFakeOperationStore(),
    ...over,
  }
}

describe("createGovernedFollowUp - the property that matters most", () => {
  it("does NOT create a second follow-up after the first was completed and unlinked in Odoo", async () => {
    const store = createFakeOperationStore()
    const first = await createGovernedFollowUp(input(), policy(), deps({ store }))
    expect(first.ok && first.created).toBe(true)

    // The human did the work: Odoo marked the activity done, so it is gone from
    // every searchable set. Any "does one already exist" strategy would create
    // a duplicate right here.
    const afterCompletion = deps({
      store,
      readActivity: vi.fn(async () => null),
      readTargetPartnerId: vi.fn(async () => { throw new Error("should not be consulted") }),
    })
    const retry = await createGovernedFollowUp(input(), policy(), afterCompletion)
    expect(retry.ok).toBe(true)
    if (!retry.ok) return
    expect(retry.created).toBe(false)
    expect(retry.followUp.activityId).toBe(8801)
    expect(afterCompletion.createActivity).not.toHaveBeenCalled()
    // Odoo is not touched at all on the recorded path.
    expect(afterCompletion.readTargetPartnerId).not.toHaveBeenCalled()
    expect(afterCompletion.resolveConfig).not.toHaveBeenCalled()
  })

  it("refuses a reused hint carrying a different follow-up", async () => {
    const d = deps()
    await createGovernedFollowUp(input(), policy(), d)
    const store = d.store as ReturnType<typeof createFakeOperationStore>
    store.rows[0].request_hash = "different"
    const again = await createGovernedFollowUp(input(), policy(), d)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.code).toBe("operation_conflict")
    expect(d.createActivity).toHaveBeenCalledTimes(1)
  })
})

describe("createGovernedFollowUp - manager verification is not weakened", () => {
  it("uses its OWN allowlist, which does not include the staff work-ref models", () => {
    expect(isFollowUpTargetModel("crm.lead")).toBe(true)
    expect(isFollowUpTargetModel("res.partner")).toBe(true)
    for (const m of WORK_REF_MODELS) {
      expect(isFollowUpTargetModel(m)).toBe(false)
    }
  })

  it("refuses a model that is not on the follow-up allowlist, before any Odoo call", async () => {
    const d = deps()
    const r = await createGovernedFollowUp(input({ targetModel: "account.move" }), policy(), d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("model_not_allowlisted")
    expect(d.resolveConfig).not.toHaveBeenCalled()
  })

  it("writes res_model_id and never res_model - the defect that broke verification", async () => {
    const d = deps()
    await createGovernedFollowUp(input(), policy(), d)
    const vals = (d.createActivity as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as Record<string, unknown>
    expect(vals.res_model_id).toBe(RES_MODEL_ID)
    expect(vals.res_id).toBe(4242)
    expect(vals.res_model).toBeUndefined()
    expect(vals.date_deadline).toBe("2026-08-05")
  })

  it("refuses rather than guessing when no activity type resolves", async () => {
    const d = deps({ resolveActivityType: vi.fn(async () => null) })
    const r = await createGovernedFollowUp(input(), policy(), d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("activity_type_unresolved")
    expect(d.createActivity).not.toHaveBeenCalled()
  })

  it("refuses rather than guessing when ir.model does not resolve", async () => {
    const d = deps({ resolveResModelId: vi.fn(async () => null) })
    const r = await createGovernedFollowUp(input(), policy(), d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("res_model_id_unresolved")
    expect(d.createActivity).not.toHaveBeenCalled()
  })
})

describe("createGovernedFollowUp - authorisation", () => {
  it("refuses an assignee the tenant has not approved", async () => {
    const d = deps()
    const r = await createGovernedFollowUp(input({ assigneeUserId: 77 }), policy(), d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("assignee_not_authorized")
    expect(d.resolveConfig).not.toHaveBeenCalled()
  })

  it("refuses a target belonging to another customer", async () => {
    const d = deps({ readTargetPartnerId: vi.fn(async () => 999) })
    const r = await createGovernedFollowUp(input(), policy(), d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("target_not_owned_by_customer")
    expect(d.createActivity).not.toHaveBeenCalled()
  })

  it("refuses a target that does not exist", async () => {
    const d = deps({ readTargetPartnerId: vi.fn(async () => null) })
    const r = await createGovernedFollowUp(input(), policy(), d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("target_not_found")
  })

  it("requires a real deadline rather than letting Odoo decide", async () => {
    const r = await createGovernedFollowUp(input({ deadline: "next week" }), policy(), deps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain("YYYY-MM-DD")
  })

  it("refuses when tenant policy disables follow-ups", async () => {
    const r = await createGovernedFollowUp(input(), policy({ allowFollowUps: false }), deps())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("follow_up_not_permitted")
  })
})

describe("createGovernedFollowUp - the create is proven", () => {
  it("refuses to record success when the activity hung off the wrong record", async () => {
    const d = deps({ readActivity: vi.fn(async () => activityRow({ res_id: 1 })) })
    const r = await createGovernedFollowUp(input(), policy(), d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain("hangs_on_the_right_record")
  })

  it("refuses when the activity landed on a different assignee", async () => {
    const d = deps({ readActivity: vi.fn(async () => activityRow({ user_id: [9, "Someone"] })) })
    const r = await createGovernedFollowUp(input(), policy(), d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain("assigned_to_the_authorized_user")
  })

  it("records FAILED and reports the id when the readback is unavailable", async () => {
    const d = deps({ readActivity: vi.fn(async () => null) })
    const r = await createGovernedFollowUp(input(), policy(), d)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe("readback_failed")
      expect(r.activityId).toBe(8801)
    }
    const store = d.store as ReturnType<typeof createFakeOperationStore>
    expect(store.rows[0].state).toBe("failed")
  })

  it("reports the tool name and never leaks the api key", async () => {
    const r = await createGovernedFollowUp(input(), policy(), deps())
    expect(r.tool).toBe(FOLLOW_UP_TOOL)
    expect(JSON.stringify(r)).not.toContain("never-logged")
  })
})

describe("renderFollowUpNote", () => {
  it("carries provenance, the lead reference and the conversation", () => {
    const note = renderFollowUpNote(input())
    expect(note).toContain("WhatsApp / Isola AI")
    expect(note).toContain("crm.lead#4242")
    expect(note).toContain("conv-9001")
  })

  it("says plainly when there is no lead rather than implying one", () => {
    expect(renderFollowUpNote(input({ leadReference: null }))).toContain("none referenced")
  })
})
