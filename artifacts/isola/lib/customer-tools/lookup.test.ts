import { describe, it, expect, vi } from "vitest"
import {
  CUSTOMER_LOOKUP_TOOL,
  LEAD_FIELDS,
  MAX_RELATED_RECORDS,
  lookupCustomerAndLeads,
  toLeadSummary,
  type CustomerLookupDeps,
  type CustomerLookupInput,
} from "./lookup"
import type { OdooConfig, OdooCustomer } from "@/engines/odoo"

const CONFIG: OdooConfig = { url: "https://tenant.odoo.example", db: "tenant", apiKey: "never-logged" }

const CUSTOMER: OdooCustomer = {
  id: 605,
  name: "Brent Symes",
  email: "brent@example.com",
  phone: "+17671234567",
  phone_sanitized: "+17671234567",
  street: "Roseau",
  city: "Roseau",
  is_company: false,
}

function input(over: Partial<CustomerLookupInput> = {}): CustomerLookupInput {
  return {
    tenantId: "43b006e4-33e0-42a8-bec7-4422ba290d79",
    chatwootAccountId: "1",
    inboxId: "46",
    conversationId: "9001",
    contactRef: "chatwoot-contact-77",
    verifiedPhone: { e164: "+17671234567", verified: true },
    correlationId: "corr-1",
    ...over,
  }
}

function deps(over: Partial<CustomerLookupDeps> = {}): CustomerLookupDeps {
  return {
    resolveConfig: vi.fn(async () => CONFIG),
    findCustomer: vi.fn(async () => CUSTOMER),
    readLeads: vi.fn(async () => []),
    ...over,
  }
}

describe("lookupCustomerAndLeads - identity is never model-selected", () => {
  it("refuses when there is no transport-verified phone", async () => {
    const d = deps()
    const r = await lookupCustomerAndLeads(input({ verifiedPhone: null }), undefined, d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("no_resolvable_identity")
    expect(d.findCustomer).not.toHaveBeenCalled()
  })

  it("refuses a phone the transport did not verify, even if well formed", async () => {
    const d = deps()
    const smuggled = { e164: "+17679998888", verified: false } as unknown as { e164: string; verified: true }
    const r = await lookupCustomerAndLeads(input({ verifiedPhone: smuggled }), undefined, d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("phone_lookup_not_permitted")
    expect(d.findCustomer).not.toHaveBeenCalled()
  })

  it("refuses when tenant policy disables phone resolution", async () => {
    const d = deps()
    const r = await lookupCustomerAndLeads(input(), { allowPhoneLookup: false }, d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("phone_lookup_not_permitted")
    expect(d.resolveConfig).not.toHaveBeenCalled()
  })

  it("refuses a phone too short to resolve", async () => {
    const d = deps()
    const r = await lookupCustomerAndLeads(
      input({ verifiedPhone: { e164: "+1767", verified: true } }),
      undefined,
      d,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("no_resolvable_identity")
    expect(d.findCustomer).not.toHaveBeenCalled()
  })
})

describe("lookupCustomerAndLeads - tenant scoping fails closed", () => {
  it("refuses a blank tenant rather than falling back to the platform default", async () => {
    const d = deps()
    const r = await lookupCustomerAndLeads(input({ tenantId: "   " }), undefined, d)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("invalid_tenant")
    expect(d.resolveConfig).not.toHaveBeenCalled()
  })

  it("resolves the Odoo config for the caller tenant and no other", async () => {
    const d = deps()
    await lookupCustomerAndLeads(input(), undefined, d)
    expect(d.resolveConfig).toHaveBeenCalledWith("43b006e4-33e0-42a8-bec7-4422ba290d79")
    expect(d.resolveConfig).toHaveBeenCalledTimes(1)
  })

  it.each(["chatwootAccountId", "inboxId", "conversationId", "contactRef", "correlationId"] as const)(
    "refuses a missing %s",
    async (field) => {
      const r = await lookupCustomerAndLeads(input({ [field]: "" }), undefined, deps())
      expect(r.ok).toBe(false)
      if (!r.ok) expect(["invalid_conversation_context"]).toContain(r.code)
    },
  )
})

describe("lookupCustomerAndLeads - bounded, read-only results", () => {
  it("returns an empty commercial state when Odoo has no contact for the number", async () => {
    const d = deps({ findCustomer: vi.fn(async () => null) })
    const r = await lookupCustomerAndLeads(input(), undefined, d)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.customer).toBeNull()
      expect(r.leads).toEqual([])
      expect(r.opportunities).toEqual([])
      expect(r.truncated).toBe(false)
    }
    expect(d.readLeads).not.toHaveBeenCalled()
  })

  it("splits leads from opportunities and carries authoritative ids", async () => {
    const d = deps({
      readLeads: vi.fn(async () => [
        { id: 11, name: "Fibre upgrade", type: "opportunity", stage_id: [3, "Proposition"], user_id: [5, "Phillip"], team_id: [1, "Sales"], partner_id: [605, "Brent Symes"], expected_revenue: 4200, probability: 40, write_date: "2026-07-29 10:00:00" },
        { id: 12, name: "Web enquiry", type: "lead", stage_id: [1, "New"], partner_id: [605, "Brent Symes"] },
      ]),
    })
    const r = await lookupCustomerAndLeads(input(), undefined, d)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.customer?.id).toBe(605)
    expect(r.opportunities.map((o) => o.id)).toEqual([11])
    expect(r.leads.map((l) => l.id)).toEqual([12])
    expect(r.opportunities[0].stage).toBe("Proposition")
    expect(r.opportunities[0].salesperson).toBe("Phillip")
    expect(r.opportunities[0].partnerId).toBe(605)
    expect(r.tool).toBe(CUSTOMER_LOOKUP_TOOL)
    expect(Number.isFinite(Date.parse(r.readAt))).toBe(true)
  })

  it("caps related records and says so instead of silently truncating", async () => {
    const many = Array.from({ length: MAX_RELATED_RECORDS + 3 }, (_, i) => ({
      id: i + 1,
      name: `lead ${i}`,
      type: "lead",
    }))
    const r = await lookupCustomerAndLeads(input(), undefined, deps({ readLeads: vi.fn(async () => many) }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.leads).toHaveLength(MAX_RELATED_RECORDS)
    expect(r.truncated).toBe(true)
  })

  it("returns a typed refusal when Odoo is unreachable, never a throw", async () => {
    const r = await lookupCustomerAndLeads(
      input(),
      undefined,
      deps({ findCustomer: vi.fn(async () => { throw new Error("connect ETIMEDOUT") }) }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe("odoo_unavailable")
      expect(r.detail).toContain("ETIMEDOUT")
    }
  })

  it("never returns free-text internal deal commentary", () => {
    expect(LEAD_FIELDS).not.toContain("description")
    expect(LEAD_FIELDS).not.toContain("email_from")
    const summary = toLeadSummary({ id: 1, name: "x", type: "lead", description: "internal: undercut competitor" })
    expect(JSON.stringify(summary)).not.toContain("undercut")
  })

  it("never leaks the Odoo api key into the result", async () => {
    const r = await lookupCustomerAndLeads(input(), undefined, deps())
    expect(JSON.stringify(r)).not.toContain("never-logged")
  })
})
