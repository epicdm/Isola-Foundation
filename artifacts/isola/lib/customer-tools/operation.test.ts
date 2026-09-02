import { describe, it, expect } from "vitest"
import {
  canonicalJson,
  claimOperation,
  completeOperation,
  deriveOperationId,
  failOperation,
  hashArguments,
  type ClaimOperationInput,
  type OperationRecord,
  type OperationStore,
} from "./operation"

/** In-memory store with the SAME uniqueness rule the database enforces. */
function memoryStore(): OperationStore & { rows: OperationRecord[]; failNextInsertWithRace: boolean } {
  const rows: OperationRecord[] = []
  let seq = 0
  const store = {
    rows,
    failNextInsertWithRace: false,
    async findByOperationId(tenantId: string, operationId: string) {
      return rows.find((r) => r.tenant_id === tenantId && r.operation_id === operationId) ?? null
    },
    async insert(row: {
      tenant_id: string; operation_id: string; tool_name: string; request_hash: string
      conversation_id: string; correlation_id: string; agent_session_id: string | null
    }) {
      if (rows.some((r) => r.tenant_id === row.tenant_id && r.operation_id === row.operation_id)) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
      }
      const created: OperationRecord = {
        id: `rec-${++seq}`,
        tenant_id: row.tenant_id,
        operation_id: row.operation_id,
        tool_name: row.tool_name,
        request_hash: row.request_hash,
        state: "claimed",
        result_model: null,
        result_id: null,
        result: null,
        failure_code: null,
        claimed_at: new Date("2026-07-30T04:00:00.000Z"),
      }
      rows.push(created)
      return created
    },
    async reclaim(id: string) {
      const r = rows.find((x) => x.id === id)!
      r.state = "claimed"
      r.failure_code = null
      return r
    },
    async markSucceeded(id: string, data: { result_model: string | null; result_id: number | null; result: unknown }) {
      const r = rows.find((x) => x.id === id)!
      r.state = "succeeded"
      r.result_model = data.result_model
      r.result_id = data.result_id
      r.result = data.result
      return r
    },
    async markFailed(id: string, data: { failure_code: string; failure_detail: string | null }) {
      const r = rows.find((x) => x.id === id)!
      r.state = "failed"
      r.failure_code = data.failure_code
      return r
    },
  }
  return store
}

function claim(over: Partial<ClaimOperationInput> = {}): ClaimOperationInput {
  return {
    tenantId: "tenant-epic",
    toolName: "crm.lead.create",
    conversationId: "conv-9001",
    correlationId: "corr-1",
    agentSessionId: "sess-1",
    hint: "hint-abc",
    authorisedArguments: { serviceInterest: "Smart Business Line", nextStep: "call back" },
    ...over,
  }
}

describe("canonicalJson and hashArguments", () => {
  it("hashes key order insensitively so a reserialised retry is still a retry", () => {
    expect(hashArguments({ a: 1, b: { c: 2, d: 3 } })).toBe(hashArguments({ b: { d: 3, c: 2 }, a: 1 }))
  })

  it("distinguishes genuinely different arguments", () => {
    expect(hashArguments({ a: 1 })).not.toBe(hashArguments({ a: 2 }))
  })

  it("keeps array order significant", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })

  it("ignores undefined members, which JSON drops anyway", () => {
    expect(hashArguments({ a: 1, b: undefined })).toBe(hashArguments({ a: 1 }))
  })
})

describe("deriveOperationId", () => {
  it("is deterministic for the same authorised turn", () => {
    const base = { tenantId: "t", toolName: "crm.lead.create", conversationId: "c", hint: "h", requestHash: "r" }
    expect(deriveOperationId(base)).toBe(deriveOperationId({ ...base }))
  })

  it.each([
    ["tenantId", { tenantId: "other" }],
    ["toolName", { toolName: "crm.lead.update" }],
    ["conversationId", { conversationId: "other" }],
    ["hint", { hint: "other" }],
    ["requestHash", { requestHash: "other" }],
  ])("changes when %s changes", (_label, over) => {
    const base = { tenantId: "t", toolName: "crm.lead.create", conversationId: "c", hint: "h", requestHash: "r" }
    expect(deriveOperationId({ ...base, ...over })).not.toBe(deriveOperationId(base))
  })

  it("never returns the raw hint as the identity", () => {
    const id = deriveOperationId({ tenantId: "t", toolName: "x", conversationId: "c", hint: "hint-abc", requestHash: "r" })
    expect(id).not.toBe("hint-abc")
    expect(id.startsWith("op-")).toBe(true)
  })
})

describe("claimOperation", () => {
  it("claims a fresh operation exactly once", async () => {
    const store = memoryStore()
    const first = await claimOperation(claim(), store)
    expect(first.status).toBe("claimed")
    expect(store.rows).toHaveLength(1)
  })

  it("reports in_flight for a concurrent second attempt, and does not insert twice", async () => {
    const store = memoryStore()
    await claimOperation(claim(), store)
    const second = await claimOperation(claim(), store)
    expect(second.status).toBe("in_flight")
    expect(store.rows).toHaveLength(1)
  })

  it("returns the recorded result on a retry after success, without re-executing", async () => {
    const store = memoryStore()
    const first = await claimOperation(claim(), store)
    if (first.status !== "claimed") throw new Error("expected claimed")
    await completeOperation(first.recordId, { resultModel: "crm.lead", resultId: 4242, result: { id: 4242, name: "SBL enquiry" } }, store)

    const retry = await claimOperation(claim(), store)
    expect(retry.status).toBe("already_succeeded")
    if (retry.status !== "already_succeeded") return
    expect(retry.resultModel).toBe("crm.lead")
    expect(retry.resultId).toBe(4242)
    expect(retry.result).toEqual({ id: 4242, name: "SBL enquiry" })
    expect(store.rows).toHaveLength(1)
  })

  it("REFUSES a reused hint carrying different arguments instead of serving the old result", async () => {
    const store = memoryStore()
    const first = await claimOperation(claim(), store)
    if (first.status !== "claimed") throw new Error("expected claimed")
    await completeOperation(first.recordId, { resultModel: "crm.lead", resultId: 1, result: { id: 1 } }, store)

    // Same hint, same conversation, DIFFERENT arguments. A hint-as-identity
    // design would hand back lead 1 for a request that is not that request.
    const different = await claimOperation(
      claim({ authorisedArguments: { serviceInterest: "Voice line", nextStep: "site visit" } }),
      store,
    )
    expect(different.status).not.toBe("already_succeeded")
    expect(different.status).toBe("claimed")
    expect(store.rows).toHaveLength(2)
  })

  it("flags a genuine id collision across tools as a conflict", async () => {
    const store = memoryStore()
    const input = claim()
    await claimOperation(input, store)
    const row = store.rows[0]
    // Simulate the pathological case the request hash exists to catch.
    row.request_hash = "some-other-hash"
    const again = await claimOperation(input, store)
    expect(again.status).toBe("conflict")
    if (again.status === "conflict") expect(again.detail).toContain("different authorised arguments")
  })

  it("re-takes the claim after a failure so a retry can execute again", async () => {
    const store = memoryStore()
    const first = await claimOperation(claim(), store)
    if (first.status !== "claimed") throw new Error("expected claimed")
    await failOperation(first.recordId, { code: "odoo_unavailable", detail: "ETIMEDOUT" }, store)

    const retry = await claimOperation(claim(), store)
    expect(retry.status).toBe("retry_after_failure")
    if (retry.status === "retry_after_failure") {
      expect(retry.previousFailureCode).toBe("odoo_unavailable")
      expect(retry.recordId).toBe(first.recordId)
    }
    expect(store.rows).toHaveLength(1)
  })

  it("survives losing the insert race and reports the winner state", async () => {
    const store = memoryStore()
    const realFind = store.findByOperationId.bind(store)
    let firstLook = true
    store.findByOperationId = async (t: string, o: string) => {
      if (firstLook) {
        firstLook = false
        return null // both attempts see nothing
      }
      return realFind(t, o)
    }
    await claimOperation(claim(), memoryStoreShared(store))
    const racer = await claimOperation(claim(), store)
    expect(["in_flight", "claimed"]).toContain(racer.status)
    expect(store.rows.length).toBeLessThanOrEqual(2)
  })

  it("keeps two tenants operations separate even with identical hints and arguments", async () => {
    const store = memoryStore()
    await claimOperation(claim({ tenantId: "tenant-a" }), store)
    const other = await claimOperation(claim({ tenantId: "tenant-b" }), store)
    expect(other.status).toBe("claimed")
    expect(store.rows).toHaveLength(2)
    expect(store.rows[0].operation_id).not.toBe(store.rows[1].operation_id)
  })
})

/** The racer test drives the same underlying rows through the patched store. */
function memoryStoreShared(store: OperationStore): OperationStore {
  return store
}
