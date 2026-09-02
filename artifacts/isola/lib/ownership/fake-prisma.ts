/**
 * An in-memory stand-in for the slice of Prisma the ownership engine and the
 * handback orchestrator touch.
 *
 * TEST SUPPORT ONLY — nothing in the application imports this. It exists
 * because the properties Commit 2 must prove (one transition per operation,
 * one note per escalation, a stale episode refused, a failed reconciliation
 * that does not resume) are properties of a UNIQUE CONSTRAINT and of
 * sequencing, and a bag of `vi.fn()`s cannot express either. This fake
 * enforces the real `(tenant_id, conversation_id, operation_id)` uniqueness
 * and raises the same `P2002` the database raises, so a concurrent-claim test
 * exercises the actual code path rather than a mocked-out one.
 *
 * `$transaction` runs the callback against the same store. It does not model
 * rollback; no test here depends on rollback semantics.
 */

export interface FakeConversationRow {
  id: string;
  tenant_id: string;
  status?: string;
  ownership_state?: string | null;
  ownership_episode?: number | null;
  ownership_changed_at?: Date | null;
  ownership_reason?: string | null;
  ownership_actor_ref?: string | null;
  ownership_correlation_id?: string | null;
  ownership_escalation_operation_id?: string | null;
  ownership_handback_operation_id?: string | null;
  human_handling?: boolean | null;
  [k: string]: unknown;
}

export interface FakeTransitionRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  episode: number;
  from_state: string;
  to_state: string;
  reason: string;
  operation_id: string;
  operation_kind: string;
  actor_ref: string | null;
  correlation_id: string | null;
}

export interface FakeMessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: Date;
}

export function createFakePrisma() {
  const store = {
    conversations: new Map<string, FakeConversationRow>(),
    transitions: [] as FakeTransitionRow[],
    messages: [] as FakeMessageRow[],
    odooBindings: new Map<string, { tenant_id: string }>(),
    seq: 0,
    reset() {
      store.conversations.clear();
      store.transitions.length = 0;
      store.messages.length = 0;
      store.odooBindings.clear();
      store.seq = 0;
    },
  };

  const findTransition = (tenantId: string, conversationId: string, operationId: string) =>
    store.transitions.find(
      (t) => t.tenant_id === tenantId && t.conversation_id === conversationId && t.operation_id === operationId,
    ) ?? null;

  const client = {
    conversation: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findUnique: async ({ where }: any) => store.conversations.get(where.id) ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: async ({ where, data }: any) => {
        const row = store.conversations.get(where.id);
        if (!row) throw new Error('no such conversation ' + where.id);
        Object.assign(row, data);
        return row;
      },
    },
    conversationOwnershipTransition: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findUnique: async ({ where }: any) => {
        const k = where.tenant_id_conversation_id_operation_id;
        return findTransition(k.tenant_id, k.conversation_id, k.operation_id);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async ({ data }: any) => {
        if (findTransition(data.tenant_id, data.conversation_id, data.operation_id)) {
          const err = new Error('Unique constraint failed') as Error & { code: string };
          err.code = 'P2002';
          throw err;
        }
        const row: FakeTransitionRow = { id: `tr-${++store.seq}`, ...data };
        store.transitions.push(row);
        return row;
      },
    },
    message: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      count: async ({ where }: any) =>
        store.messages.filter((m) => m.conversation_id === where.conversation_id).length,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where, orderBy, take }: any) => {
        let rows = store.messages.filter((m) => m.conversation_id === where.conversation_id);
        rows = rows.slice().sort((a, b) =>
          orderBy?.created_at === 'desc'
            ? b.created_at.getTime() - a.created_at.getTime()
            : a.created_at.getTime() - b.created_at.getTime(),
        );
        return typeof take === 'number' ? rows.slice(0, take) : rows;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async ({ data }: any) => {
        const row: FakeMessageRow = {
          id: `msg-${++store.seq}`,
          created_at: new Date(2026, 6, 29, 12, 0, store.seq),
          ...data,
        };
        store.messages.push(row);
        return row;
      },
    },
    odooBinding: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findUnique: async ({ where }: any) => store.odooBindings.get(where.tenant_id) ?? null,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: async (fn: any) => fn(client),
  };

  return { store, client };
}

/**
 * Module-level singleton. Test files `vi.mock('@/lib/prisma')` with an async
 * factory that imports THIS module, and also import it statically, so both
 * sides observe the same store. Call `fakePrisma.store.reset()` in beforeEach.
 */
export const fakePrisma = createFakePrisma();
