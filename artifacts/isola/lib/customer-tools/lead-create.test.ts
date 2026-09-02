import { describe, it, expect, vi } from "vitest"
import {
  ISOLA_LEAD_SOURCE,
  LEAD_CREATE_TOOL,
  createGovernedLead,
  renderLeadDescription,
  type LeadCreateDeps,
  type LeadCreateInput,
} from "./lead-create"
import type { OperationRecord, OperationStore } from "./operation"
import type { OdooConfig } from "@/engines/odoo"

const CONFIG: OdooConfig = { url: "https://tenant.odoo.example", db: "tenant", apiKey: "never-logged" }

function memoryStore(): OperationStore & { rows: OperationRecord[] } {
  const rows: OperationRecord[] = []
  let seq = 0
  return {
    rows,
    async findByOperationId(t: string, o: string) {
      return rows.find((r) => r.tenant_id === t && r.operation_id === o) ?? null
    },
    async insert(row) {
      if (rows.some((r) => r.tenant_id === row.tenant_id && r.operation_id === row.operation_id)) {
        throw Object.assign(new Error("unique"), { code: "P2002" })
      }
      const created: OperationRecord = {
        id: `rec-${++seq}`, tenant_id: row.tenant_id, operation_id: row.operation_id,
        tool_name: row.tool_name, request_hash: row.request_hash, state: "claimed",
        result_model: null, result_id: null, result: null, failure_code: null,
        claimed_at: new Date("2026-07-30T10:00:00.000Z"),
      }
      rows.push(created)
      return created
    },
    async reclaim(id) { const r = rows.find((x) => x.id === id)!; r.state = "claimed"; r.failure_code = null; return r },
    async markSucceeded(id, d) {
      const r = rows.find((x) => x.id === id)!
      r.state = "succeeded"; r.result_model = d.result_model; r.result_id = d.result_id; r.result = d.result
      return r
    },
    async markFailed(id, d) {
      const r = rows.find((x) => x.id === id)!
      r.state = "failed"; r.failure_code = d.failure_code
      return r
    },
  }
}

const CREATED_ROW = {
  id: 4242,
  name: "Smart Business Line",
  type: "lead",
  partner_id: [605, "Brent Symes"],
  source_id: [9, ISOLA_LEAD_SOURCE],
  team_id: [1, "Sales"],
  stage_id: [1, "New"],
  active: true,
  description: "Captured by WhatsApp / Isola AI.\nChatwoot conversation: conv-9001",
  create_date: "2026-07-30 10:00:00",
}

function input(over: Partial<LeadCreateInput> = {}): LeadCreateInput {
  return {
    tenantId: "43b006e4-33e0-42a8-bec7-4422ba290d79",
    partnerId: 605,
    contactName: "Brent Symes",
    serviceInterest: "Smart Business Line",
    qualificationFacts: ["Runs a pizza shop", "Wants missed calls answered"],
    nextStep: "Call back Thursday",
    chatwootConversationId: "conv-9001",
    clawithSessionId: "sess-1",
    correlationId: "corr-1",
    operationIdHint: "hint-abc",
    ...over,
  }
}

function deps(over: Partial<LeadCreateDeps> = {}): LeadCreateDeps {
  return {
    resolveConfig: vi.fn(async () => CONFIG),
    findSuitableLead: vi.fn(async () => null),
    resolveSourceId: vi.fn(async () => 9),
    createLead: vi.fn(async () => 4242),
    readLead: vi.fn(async () => ({ ...CREATED_ROW })),
    store: memoryStore(),
    ...over,
  }
}

describe("createGovernedLead - the happy path is proven, not assumed", () => {
  it("creates one lead and records the VERIFIED readback", async () => {
    const d = deps()
    const r = await createGovernedLead(input(), undefined, d)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.created).toBe(true)
    expect(r.lead.id).toBe(4242)
    expect(r.lead.partnerId).toBe(605)
    expect(r.lead.sourceName).toBe(ISOLA_LEAD_SOURCE)
    expect(r.tool).toBe(LEAD_CREATE_TOOL)
    expect(d.createLead).toHaveBeenCalledTimes(1)
    expect(d.readLead).toHaveBeenCalledTimes(1)
  })

  it("stamps the AI source so a human can filter for it in Odoo", async () => {
    const d = deps()
    await createGovernedLead(input(), undefined, d)
    const vals = (d.createLead as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as Record<string, unknown>
    expect(vals.source_id).toBe(9)
    expect(vals.type).toBe("lead")
    expect(vals.partner_id).toBe(605)
  })
})

describe("createGovernedLead - exactly once", () => {
  it("returns the recorded result on a retry and does NOT create a second lead", async () => {
    const d = deps()
    const first = await createGovernedLead(input(), undefined, d)
    expect(first.ok && first.created).toBe(true)

    const retry = await createGovernedLead(input(), undefined, d)
    expect(retry.ok).toBe(true)
    if (!retry.ok) return
    expect(retry.created).toBe(false)
    expect(retry.reused).toBe("recorded_operation")
    expect(retry.lead.id).toBe(4242)
    expect(d.createLead).toHaveBeenCalledTimes(1)
  })

  it("REFUSES a reused hint carrying different authorised arguments", async () => {
    const d = deps()
    await createGovernedLead(input(), undefined, d)
    // Force the pathological case: same derived id, different stored hash.
    const store = d.store as ReturnType<typeof memoryStore>
    store.rows[0].request_hash = "not-the-same-request"
    const again = await createGovernedLead(input(), undefined, d)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.code).toBe("operation_conflict")
    expect(d.createLead).toHaveBeenCalledTimes(1)
  })

  it("reuses a lead a human already opened rather than stacking a duplicate", async () => {
    const d = deps({ findSuitableLead: vi.fn(async () => ({ ...CREATED_ROW, id: 111 })) })
    const r = await createGovernedLead(input(), undefined, d)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.created).toBe(false)
    expect(r.reused).toBe("existing_lead")
    expect(r.lead.id).toBe(111)
    expect(d.createLead).not.toHaveBeenCalled()
  })

  it("still creates when the courtesy lookup itself fails - the ledger is the guarantee", async () => {
    const d = deps({ findSuitableLead: vi.fn(async () => { throw new Error("odoo slow") }) })
    const r = await createGovernedLead(input(), undefined, d)
    expect(r.ok && r.created).toBe(true)
  })
})

describe("createGovernedLead - a create is not a proof", () => {
  it("records FAILED and reports the lead id when the readback cannot be obtained", async () => {
    const d = deps({ readLead: vi.fn(async () => null) })
    const r = await createGovernedLead(input(), undefined, d)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe("readback_failed")
    expect(r.leadId).toBe(4242)
    const store = d.store as ReturnType<typeof memoryStore>
    expect(store.rows[0].state).toBe("failed")
  })

  it("refuses to record success when the readback names a DIFFERENT partner", async () => {
    const d = deps({ readLead: vi.fn(async () => ({ ...CREATED_ROW, partner_id: [999, "Someone else"] })) })
    const r = await createGovernedLead(input(), undefined, d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain("partner_matches")
  })

  it("refuses to record success when the conversation reference did not land", async () => {
    const d = deps({ readLead: vi.fn(async () => ({ ...CREATED_ROW, description: "nothing useful" })) })
    const r = await createGovernedLead(input(), undefined, d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain("conversation_recorded")
  })

  it("records FAILED so a later retry can execute again, not be served a lie", async () => {
    const d = deps({ createLead: vi.fn(async () => null) })
    const r = await createGovernedLead(input(), undefined, d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("odoo_unavailable")
    const store = d.store as ReturnType<typeof memoryStore>
    expect(store.rows[0].state).toBe("failed")
  })
})

describe("createGovernedLead - refusals happen before anything is touched", () => {
  it.each([
    ["blank tenant", { tenantId: " " }, "invalid_tenant"],
    ["absent partner", { partnerId: 0 }, "invalid_input"],
    ["blank service interest", { serviceInterest: "" }, "invalid_input"],
    ["blank next step", { nextStep: "" }, "invalid_input"],
    ["blank conversation", { chatwootConversationId: "" }, "invalid_input"],
    ["blank operation hint", { operationIdHint: "" }, "invalid_input"],
  ])("refuses %s", async (_l, over, code) => {
    const d = deps()
    const r = await createGovernedLead(input(over as Partial<LeadCreateInput>), undefined, d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe(code)
    expect(d.resolveConfig).not.toHaveBeenCalled()
  })

  it("refuses when tenant policy disables AI lead creation", async () => {
    const d = deps()
    const r = await createGovernedLead(input(), { allowLeadCreation: false }, d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("lead_creation_not_permitted")
    expect(d.resolveConfig).not.toHaveBeenCalled()
  })

  it("never leaks the Odoo api key into a result", async () => {
    const r = await createGovernedLead(input(), undefined, deps())
    expect(JSON.stringify(r)).not.toContain("never-logged")
  })
})

describe("renderLeadDescription", () => {
  it("names its provenance and carries the conversation reference", () => {
    const body = renderLeadDescription(input())
    expect(body).toContain(ISOLA_LEAD_SOURCE)
    expect(body).toContain("conv-9001")
    expect(body).toContain("Call back Thursday")
    expect(body).toContain("Runs a pizza shop")
  })

  it("says so plainly when nothing was qualified rather than leaving a blank", () => {
    expect(renderLeadDescription(input({ qualificationFacts: [] }))).toContain("none captured")
  })

  it("bounds and flattens whatever it was handed", () => {
    const body = renderLeadDescription(input({ qualificationFacts: ["line one\nline two", "x".repeat(900)] }))
    expect(body).toContain("line one line two")
    expect(body).not.toContain("\n- x".padEnd(600, "x"))
  })
})
