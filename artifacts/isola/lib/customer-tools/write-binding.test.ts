/**
 * A write inherits nothing — proven for all four governed write tools.
 *
 * THE ASSERTION THAT MATTERS is not the failure code. It is that the Odoo
 * write dep was NEVER CALLED. A tool that returned `tenant_not_bound` and then
 * created the record anyway would satisfy a response-only test and would be
 * the exact defect this guard exists to prevent.
 *
 * Every refusal below is paired with its CONTROL in the same describe: the
 * identical call with a resolving config does reach the write. Without the
 * pair, a tool that refuses everybody passes.
 */
import { describe, expect, it, vi } from "vitest"

import { OdooBindingRequiredError } from "@/lib/engine-bindings"
import type { OdooConfig } from "@/engines/odoo"

import { createGovernedLead, type LeadCreateDeps, type LeadCreateInput } from "./lead-create"
import { updateGovernedLead, type LeadUpdateDeps, type LeadUpdateInput } from "./lead-update"
import { createGovernedFollowUp, type FollowUpDeps, type FollowUpInput } from "./follow-up"
import {
  createGovernedBusinessNote,
  type BusinessNoteDeps,
  type BusinessNoteInput,
} from "./business-note"
import type { OperationRecord, OperationStore } from "./operation"

const TENANT = "43b006e4-33e0-42a8-bec7-4422ba290d79"
const CONFIG: OdooConfig = { url: "https://tenant.odoo.example", db: "tenant", apiKey: "never-logged" }

/** The refusal the write door throws for a tenant with no OdooBinding row. */
const unbound = () =>
  vi.fn(async () => {
    throw new OdooBindingRequiredError(TENANT, `tenant ${TENANT} has no OdooBinding row`)
  })

/** A real outage, for the control that the two are not the same fact. */
const unreachable = () =>
  vi.fn(async () => {
    throw new Error("connect ECONNREFUSED 10.1.2.3:443")
  })

const bound = () => vi.fn(async () => CONFIG)

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
        claimed_at: new Date("2026-09-09T10:00:00.000Z"),
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

/* ── Tool 2: crm.lead.create ────────────────────────────────────────────*/

const leadInput = (): LeadCreateInput => ({
  tenantId: TENANT,
  partnerId: 605,
  contactName: "Brent Symes",
  serviceInterest: "Smart Business Line",
  qualificationFacts: ["Runs a pizza shop"],
  nextStep: "Call back Thursday",
  chatwootConversationId: "conv-9001",
  clawithSessionId: "sess-1",
  correlationId: "corr-1",
  operationIdHint: "hint-abc",
})

const leadDeps = (over: Partial<LeadCreateDeps> = {}): LeadCreateDeps => ({
  resolveConfig: bound(),
  findSuitableLead: vi.fn(async () => null),
  resolveSourceId: vi.fn(async () => 9),
  createLead: vi.fn(async () => 4242),
  readLead: vi.fn(async () => ({
    id: 4242, name: "Smart Business Line", type: "lead", partner_id: [605, "Brent Symes"],
    source_id: [9, "WhatsApp / Isola AI"], team_id: null, stage_id: [1, "New"], active: true,
    description: "Chatwoot conversation: conv-9001", create_date: "2026-09-09 10:00:00",
  })),
  store: memoryStore(),
  ...over,
})

describe("crm.lead.create refuses an unbound tenant and creates nothing", () => {
  it("returns tenant_not_bound and NEVER calls createLead", async () => {
    const d = leadDeps({ resolveConfig: unbound() })
    const r = await createGovernedLead(leadInput(), undefined, d)

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("tenant_not_bound")
    expect(d.createLead).not.toHaveBeenCalled()
  })

  it("CONTROL: a bound tenant DOES reach createLead", async () => {
    const d = leadDeps()
    const r = await createGovernedLead(leadInput(), undefined, d)

    expect(r.ok).toBe(true)
    expect(d.createLead).toHaveBeenCalledTimes(1)
  })

  it("CONTROL: an unreachable Odoo is odoo_unavailable, not tenant_not_bound", async () => {
    const d = leadDeps({ resolveConfig: unreachable() })
    const r = await createGovernedLead(leadInput(), undefined, d)

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("odoo_unavailable")
  })
})

/* ── Tool 3: crm.lead.update ────────────────────────────────────────────*/

const updateInput = (): LeadUpdateInput => ({
  tenantId: TENANT,
  leadId: 4242,
  expectedPartnerId: 605,
  changes: { nextStep: "Call back Thursday" },
  chatwootConversationId: "conv-9001",
  clawithSessionId: "sess-1",
  correlationId: "corr-2",
  operationIdHint: "hint-def",
})

const LEAD_ROW = {
  id: 4242, name: "Smart Business Line", type: "lead", partner_id: [605, "Brent Symes"],
  stage_id: [1, "New"], team_id: null, user_id: null, description: "", active: true,
  probability: 50, date_deadline: null, write_date: "2026-09-09 10:00:00",
}

const updateDeps = (over: Partial<LeadUpdateDeps> = {}): LeadUpdateDeps => ({
  resolveConfig: bound(),
  readLead: vi.fn(async () => ({ ...LEAD_ROW, description: "corr-2" })),
  readPipelineStageIds: vi.fn(async () => [1]),
  writeLead: vi.fn(async () => {}),
  store: memoryStore(),
  ...over,
})

describe("crm.lead.update refuses an unbound tenant and writes nothing", () => {
  it("returns tenant_not_bound and NEVER calls writeLead", async () => {
    const d = updateDeps({ resolveConfig: unbound() })
    const r = await updateGovernedLead(updateInput(), undefined, d)

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("tenant_not_bound")
    expect(d.writeLead).not.toHaveBeenCalled()
    // It also never got as far as READING the lead, so no ownership check was
    // performed against an instance nobody chose.
    expect(d.readLead).not.toHaveBeenCalled()
  })

  it("CONTROL: a bound tenant DOES reach writeLead", async () => {
    const d = updateDeps()
    await updateGovernedLead(updateInput(), undefined, d)

    expect(d.writeLead).toHaveBeenCalledTimes(1)
  })
})

/* ── Tool 4: crm.followup.create ────────────────────────────────────────*/

const followUpInput = (): FollowUpInput => ({
  tenantId: TENANT,
  targetModel: "crm.lead",
  targetId: 4242,
  expectedPartnerId: 605,
  assigneeUserId: 8,
  purpose: "Call the customer back about the quotation",
  deadline: "2026-09-11",
  chatwootConversationId: "conv-9001",
  clawithSessionId: "sess-1",
  correlationId: "corr-3",
  operationIdHint: "hint-ghi",
})

const FOLLOW_UP_POLICY = { allowFollowUps: true, approvedAssigneeUserIds: [8] }

const followUpDeps = (over: Partial<FollowUpDeps> = {}): FollowUpDeps => ({
  resolveConfig: bound(),
  resolveResModelId: vi.fn(async () => 100),
  resolveActivityType: vi.fn(async () => ({ activityTypeId: 4, name: "To-Do" })),
  readTargetPartnerId: vi.fn(async () => 605),
  createActivity: vi.fn(async () => 5001),
  readActivity: vi.fn(async () => ({
    id: 5001, res_model: "crm.lead", res_model_id: [100, "crm.lead"], res_id: 4242,
    user_id: [8, "Hakeem"], activity_type_id: [4, "To-Do"],
    summary: "Call the customer back about the quotation", date_deadline: "2026-09-11",
  })),
  store: memoryStore(),
  ...over,
})

describe("crm.followup.create refuses an unbound tenant and creates no activity", () => {
  it("returns tenant_not_bound and NEVER calls createActivity", async () => {
    const d = followUpDeps({ resolveConfig: unbound() })
    const r = await createGovernedFollowUp(followUpInput(), FOLLOW_UP_POLICY, d)

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("tenant_not_bound")
    expect(d.createActivity).not.toHaveBeenCalled()
  })

  it("records the refusal on the operation as its own code, not as an outage", async () => {
    // This tool claims the ledger BEFORE resolving, deliberately, so the
    // refusal lands on a real row. A later reader must be able to tell
    // "nowhere to write" from "could not get through".
    const store = memoryStore()
    const d = followUpDeps({ resolveConfig: unbound(), store })
    await createGovernedFollowUp(followUpInput(), FOLLOW_UP_POLICY, d)

    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].state).toBe("failed")
    expect(store.rows[0].failure_code).toBe("tenant_not_bound")
  })

  it("CONTROL: a bound tenant DOES reach createActivity", async () => {
    const d = followUpDeps()
    const r = await createGovernedFollowUp(followUpInput(), FOLLOW_UP_POLICY, d)

    expect(r.ok).toBe(true)
    expect(d.createActivity).toHaveBeenCalledTimes(1)
  })
})

/* ── Tool 5: crm.note.create ────────────────────────────────────────────*/

const noteInput = (): BusinessNoteInput => ({
  tenantId: TENANT,
  targetModel: "res.partner",
  targetId: 605,
  expectedPartnerId: 605,
  customerRequest: "Asked about the quotation",
  actionTaken: "Read it back to them",
  result: "They want to proceed",
  nextStep: "Sales to confirm",
  chatwootConversationId: "conv-9001",
  clawithSessionId: "sess-1",
  correlationId: "corr-4",
  operationIdHint: "hint-jkl",
})

const noteDeps = (over: Partial<BusinessNoteDeps> = {}): BusinessNoteDeps => ({
  resolveConfig: bound(),
  readTargetPartnerId: vi.fn(async () => 605),
  postNote: vi.fn(async () => 7001),
  readRecordMessageIds: vi.fn(async () => [7001]),
  readMessage: vi.fn(async () => ({
    id: 7001, model: "res.partner", res_id: 605,
    body: "<p>Logged by WhatsApp / Isola AI · Isola correlation: corr-4</p>",
    message_type: "comment",
  })),
  store: memoryStore(),
  ...over,
})

describe("crm.note.create refuses an unbound tenant and posts nothing", () => {
  it("returns tenant_not_bound and NEVER calls postNote", async () => {
    const d = noteDeps({ resolveConfig: unbound() })
    const r = await createGovernedBusinessNote(noteInput(), undefined, d)

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("tenant_not_bound")
    expect(d.postNote).not.toHaveBeenCalled()
  })

  it("records the refusal on the operation as its own code", async () => {
    const store = memoryStore()
    const d = noteDeps({ resolveConfig: unbound(), store })
    await createGovernedBusinessNote(noteInput(), undefined, d)

    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].failure_code).toBe("tenant_not_bound")
  })

  it("CONTROL: a bound tenant DOES reach postNote", async () => {
    const d = noteDeps()
    const r = await createGovernedBusinessNote(noteInput(), undefined, d)

    expect(r.ok).toBe(true)
    expect(d.postNote).toHaveBeenCalledTimes(1)
  })

  it("CONTROL: an unreachable Odoo is still odoo_unavailable", async () => {
    const d = noteDeps({ resolveConfig: unreachable() })
    const r = await createGovernedBusinessNote(noteInput(), undefined, d)

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("odoo_unavailable")
  })
})
