/**
 * fake-operation-store.ts - an in-memory OperationStore for tests.
 *
 * Follows the precedent of lib/ownership/fake-prisma.ts: the double lives
 * beside the code it doubles, not inside one test file, so every governed tool
 * exercises the SAME uniqueness semantics. A per-file hand-rolled fake is how
 * two tools end up disagreeing about what a claim means while both suites stay
 * green.
 *
 * It enforces the real constraint - unique (tenant_id, operation_id), raised as
 * Prisma P2002 - because that constraint is the exactly-once guarantee. A fake
 * that quietly allows a duplicate would test nothing worth testing.
 */
import type { OperationRecord, OperationStore } from "./operation"

export interface FakeOperationStore extends OperationStore {
  rows: OperationRecord[]
}

export function createFakeOperationStore(): FakeOperationStore {
  const rows: OperationRecord[] = []
  let seq = 0
  return {
    rows,
    async findByOperationId(tenantId, operationId) {
      return rows.find((r) => r.tenant_id === tenantId && r.operation_id === operationId) ?? null
    },
    async insert(row) {
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
        claimed_at: new Date("2026-07-30T10:00:00.000Z"),
      }
      rows.push(created)
      return created
    },
    async reclaim(id) {
      const r = rows.find((x) => x.id === id)
      if (!r) throw new Error(`no operation row ${id}`)
      r.state = "claimed"
      r.failure_code = null
      return r
    },
    async markSucceeded(id, data) {
      const r = rows.find((x) => x.id === id)
      if (!r) throw new Error(`no operation row ${id}`)
      r.state = "succeeded"
      r.result_model = data.result_model
      r.result_id = data.result_id
      r.result = data.result
      return r
    },
    async markFailed(id, data) {
      const r = rows.find((x) => x.id === id)
      if (!r) throw new Error(`no operation row ${id}`)
      r.state = "failed"
      r.failure_code = data.failure_code
      return r
    },
  }
}
