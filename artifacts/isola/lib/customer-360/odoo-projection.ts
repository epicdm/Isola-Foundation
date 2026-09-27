import { json2Call, type OdooConfig, type OdooCustomer } from '@/engines/odoo';
import { odooDeepLink } from '@/lib/context/customer-sources';
import { createOdooRecordSystem } from '@/lib/governed/executors/odoo-record-system';
import { readPersonalLineServices } from './personal-line-services';
import type {
  Customer360Balance,
  Customer360Document,
  Customer360FollowUp,
  Customer360Loop,
  Customer360ObjectDetail,
  Customer360RecommendedAction,
  Customer360Snapshot,
  Customer360Stage,
  Customer360TimelineEntry,
  DetailAvailability,
} from './contracts';

/** One message from this partner's conversation mirror — passed in by the
 *  route, which owns the Prisma access this module deliberately does not
 *  have. Empty when there is no known conversation (the customerId door). */
export interface ConversationMessage {
  role: string;
  content: string;
  createdAt: string;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Refuses to build a deep link against an origin this projection does not
 * trust, even though `odooDeepLink` already refuses a missing baseUrl.
 *
 * `epic_sandbox` is a real, deployed, NON-authoritative Odoo instance
 * (CLAUDE.md's authority map: "the authority is epic-communications-inc.odoo.com
 * and nothing else"). A tenant's OdooBinding is data, not code — a
 * misconfigured row could point there, and a deep link is exactly the kind
 * of confident, clickable artifact that must never be built against it.
 * This does not hardcode a single tenant's host, because other tenants may
 * have their own legitimate self-hosted or SaaS Odoo instances; it refuses
 * only what is generically unsafe: a non-https origin, or a hostname naming
 * itself a sandbox.
 */
function isAllowedOdooOrigin(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (/sandbox/i.test(parsed.hostname)) return false;
  return true;
}

/** Server-authoritative deep link, or null when it cannot be honestly built. */
function safeOdooLink(baseUrl: string | undefined, model: string, recordId: number): string | null {
  if (!baseUrl || !isAllowedOdooOrigin(baseUrl)) return null;
  return odooDeepLink(baseUrl, model, recordId);
}

/**
 * FIX 2026-09-20 (Codex P1 on PR#144, discussion_r4057010114): Personal Line
 * is a SINGLE-TENANT bff-v2 relationship -- one process-wide
 * BFF_V2_INTERNAL_BASE_URL/BFF_V2_PL_OPERATOR_READ_TOKEN, scoped to EPIC's
 * own LiteAccount table, never per-tenant. Isola-Foundation itself is
 * multi-tenant (this file's own isAllowedOdooOrigin comment: "other tenants
 * may have their own legitimate self-hosted or SaaS Odoo instances").
 *
 * Before this gate, `readPersonalLineServices(partnerId)` fired for EVERY
 * tenant's customer lookup, keyed only on the Odoo-local, NOT globally
 * unique `res.partner` id. A different tenant's operator opening their own
 * customer whose numeric partner id happened to collide with an EPIC
 * LiteAccount.odooPartnerId would receive that EPIC customer's real DID and
 * SIP registration status -- a cross-tenant leak, not a hypothetical one:
 * Odoo partner ids are small sequential integers, so a collision across two
 * separate Odoo databases is an ordinary occurrence, not an edge case.
 *
 * The fix gates the call to the ONE Odoo instance Personal Line is actually
 * bound to -- same shape as isAllowedOdooOrigin above, an allowlist of one
 * trusted origin rather than a denylist, because unlike deep links (which
 * merely need to avoid a KNOWN-bad origin) this call sends the tenant's
 * customer id to a system that has no way to verify it owns that id at all.
 */
const PERSONAL_LINE_ODOO_ORIGIN = 'https://epic-communications-inc.odoo.com';
function tenantOwnsPersonalLine(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).origin === new URL(PERSONAL_LINE_ODOO_ORIGIN).origin;
  } catch {
    return false;
  }
}

/** Odoo returns a many2one as [id, "NAME"]; the currency NAME is the code. */
function currencyCode(value: unknown): string | null {
  return displayName(value);
}

function displayName(value: unknown): string | null {
  if (Array.isArray(value)) return text(value[1]);
  if (value && typeof value === 'object') {
    return text((value as Record<string, unknown>).display_name);
  }
  return null;
}

const CUSTOMER_FIELDS = ['id', 'name', 'email', 'phone', 'phone_sanitized', 'street', 'city', 'is_company', 'parent_id', 'create_date', 'category_id'];

/**
 * Sentinel for a read this projection is willing to lose but not willing to
 * misreport. Distinct from `[]`, which means Odoo answered and had nothing.
 */
const TOLERATED_FAILURE = Symbol('tolerated-odoo-read-failure');

/** Unlike the legacy helper, this lookup does not turn transport failure into no-match. */
async function findCustomerStrict(config: OdooConfig, phone: string): Promise<OdooCustomer | null> {
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 7) return null;
  const candidates = [...new Set([
    digits.length === 10 ? `+1${digits}` : `+${digits}`,
    `+${digits}`,
  ])];

  for (const candidate of candidates) {
    const rows = await json2Call(config, 'res.partner', 'search_read', {
      domain: [['phone_sanitized', '=', candidate]],
      fields: CUSTOMER_FIELDS,
      limit: 1,
    }, 12000) as OdooCustomer[];
    if (rows.length) return rows[0];
  }

  const rows = await json2Call(config, 'res.partner', 'search_read', {
    domain: [['phone_sanitized', 'ilike', digits.slice(-10)]],
    fields: CUSTOMER_FIELDS,
    limit: 1,
  }, 12000) as OdooCustomer[];
  return rows[0] ?? null;
}

/**
 * Resolve a partner by its Odoo id.
 *
 * Same discipline as findCustomerStrict: a transport failure THROWS rather than
 * returning null, because "Odoo did not answer" and "there is no such customer"
 * must not collapse. The caller turns the first into `unavailable` and the
 * second into `not-found`, and they mean opposite things to a reader.
 */
async function findCustomerById(config: OdooConfig, partnerId: number): Promise<OdooCustomer | null> {
  if (!Number.isSafeInteger(partnerId) || partnerId <= 0) return null;
  const rows = await json2Call(config, 'res.partner', 'search_read', {
    domain: [['id', '=', partnerId]],
    fields: CUSTOMER_FIELDS,
    limit: 1,
  }, 12000) as OdooCustomer[];
  return rows[0] ?? null;
}

/**
 * One partner-scoped Odoo projection for the embedded Chatwoot workspace,
 * addressed by the conversation's phone number.
 * It creates nothing and every read is pinned to the resolved partner id.
 */
export async function readCustomer360(
  config: OdooConfig,
  phone: string,
  conversation: Customer360Snapshot['conversation'],
  messages: ConversationMessage[] = [],
): Promise<Customer360Snapshot | null> {
  const partner = await findCustomerStrict(config, phone);
  if (!partner) return null;
  return projectPartner(config, partner, conversation, messages);
}

/**
 * THE SAME PROJECTION, addressed by customer id instead of by phone.
 *
 * This is the portal's door. It exists because a customer list emits a customer
 * LOCATOR, and until now the cockpit could only be reached from a Chatwoot
 * conversation — so the one experience the ruling describes (list → cockpit)
 * had no way to complete.
 *
 * It deliberately shares `projectPartner` with the phone-addressed read rather
 * than growing a parallel projection. Two projections over the same customer
 * would drift, and the drift would show up as the two surfaces disagreeing
 * about a balance, which is the failure this whole workspace exists to prevent.
 */
export async function readCustomer360ById(
  config: OdooConfig,
  partnerId: number,
  conversation: Customer360Snapshot['conversation'],
  messages: ConversationMessage[] = [],
): Promise<Customer360Snapshot | null> {
  const partner = await findCustomerById(config, partnerId);
  if (!partner) return null;
  return projectPartner(config, partner, conversation, messages);
}

/** Everything below the partner resolution, shared by both doors. */
async function projectPartner(
  config: OdooConfig,
  partner: OdooCustomer,
  conversation: Customer360Snapshot['conversation'],
  messages: ConversationMessage[],
): Promise<Customer360Snapshot> {
  const partnerId = partner.id;

  const [sales, invoices, opportunitiesRaw, tasksRaw, ticketsRaw, followUpsRaw, servicesResult] = await Promise.all([
    json2Call(config, 'sale.order', 'search_read', {
      domain: [['partner_id', '=', partnerId]],
      fields: ['id', 'name', 'state', 'amount_total', 'currency_id', 'date_order'],
      order: 'date_order desc',
      limit: 12,
    }, 12000) as Promise<Record<string, unknown>[]>,
    json2Call(config, 'account.move', 'search_read', {
      domain: [['partner_id', '=', partnerId], ['move_type', '=', 'out_invoice']],
      fields: ['id', 'name', 'state', 'payment_state', 'amount_total', 'amount_residual', 'currency_id', 'invoice_date'],
      order: 'invoice_date desc',
      limit: 12,
    }, 12000) as Promise<Record<string, unknown>[]>,
    json2Call(config, 'crm.lead', 'search_read', {
      domain: [['partner_id', '=', partnerId], ['active', '=', true]],
      fields: ['id', 'name', 'stage_id', 'expected_revenue', 'date_deadline'],
      order: 'write_date desc',
      limit: 8,
    }, 12000).catch(() => TOLERATED_FAILURE) as Promise<Record<string, unknown>[] | typeof TOLERATED_FAILURE>,
    json2Call(config, 'project.task', 'search_read', {
      domain: [['partner_id', '=', partnerId], ['active', '=', true]],
      fields: ['id', 'name', 'stage_id', 'date_deadline'],
      order: 'date_deadline asc',
      limit: 8,
    }, 12000).catch(() => TOLERATED_FAILURE) as Promise<Record<string, unknown>[] | typeof TOLERATED_FAILURE>,
    // helpdesk.ticket -- confirmed installed and readable on this instance
    // (measured live 2026-09-05: state 'available' via /api/v1/customers/
    // 163/context). Tolerated the same as opportunities/tasks: a 404 on a
    // DIFFERENT Odoo instance must not crash this read.
    json2Call(config, 'helpdesk.ticket', 'search_read', {
      domain: [['partner_id', '=', partnerId]],
      fields: ['id', 'name', 'stage_id', 'priority', 'user_id', 'create_date', 'write_date'],
      order: 'write_date desc',
      limit: 8,
    }, 12000).catch(() => TOLERATED_FAILURE) as Promise<Record<string, unknown>[] | typeof TOLERATED_FAILURE>,
    // mail.activity -- Follow-ups. Real Odoo, not a new store (the same
    // ruling lib/context/customer-sources.ts already recorded when it
    // considered and rejected inventing one). res_model/res_id is the
    // generic polymorphic link every mail.activity carries.
    json2Call(config, 'mail.activity', 'search_read', {
      domain: [['res_model', '=', 'res.partner'], ['res_id', '=', partnerId]],
      fields: ['id', 'summary', 'date_deadline', 'user_id'],
      order: 'date_deadline asc',
      limit: 12,
    }, 12000).catch(() => TOLERATED_FAILURE) as Promise<Record<string, unknown>[] | typeof TOLERATED_FAILURE>,
    // NOT an Odoo read -- bff-v2, server-to-server, keyed on this same
    // partnerId (LiteAccount.odooPartnerId). GATED to the one tenant
    // Personal Line is actually bound to (tenantOwnsPersonalLine above) --
    // a wrong-tenant caller never reaches the network call at all, rather
    // than being trusted not to collide on partnerId. readPersonalLineServices()
    // never throws, so no .catch()/TOLERATED_FAILURE sentinel is needed
    // here; it reports its own availability in the resolved value.
    tenantOwnsPersonalLine(config.url)
      ? readPersonalLineServices(partnerId)
      : Promise.resolve({ available: false, services: [] }),
  ]);

  // A tolerated failure is reported, never rendered as an empty result. The
  // same distinction the customer lookup already makes between "no match" and
  // "could not ask".
  const openLoopsAvailable = opportunitiesRaw !== TOLERATED_FAILURE && tasksRaw !== TOLERATED_FAILURE && ticketsRaw !== TOLERATED_FAILURE;
  const opportunities = opportunitiesRaw === TOLERATED_FAILURE ? [] : opportunitiesRaw;
  const tasks = tasksRaw === TOLERATED_FAILURE ? [] : tasksRaw;
  const tickets = ticketsRaw === TOLERATED_FAILURE ? [] : ticketsRaw;
  const followUpsAvailable = followUpsRaw !== TOLERATED_FAILURE;
  const followUpRows = followUpsRaw === TOLERATED_FAILURE ? [] : followUpsRaw;

  const documents: Customer360Document[] = [
    ...sales.map((row) => ({
      id: Number(row.id),
      reference: String(row.name ?? ''),
      kind: row.state === 'draft' || row.state === 'sent' ? 'quotation' as const : 'order' as const,
      state: text(row.state),
      total: number(row.amount_total),
      currency: currencyCode(row.currency_id),
      date: text(row.date_order),
      odooLink: safeOdooLink(config.url, 'sale.order', Number(row.id)),
    })),
    ...invoices.map((row) => ({
      id: Number(row.id),
      reference: String(row.name ?? ''),
      kind: 'invoice' as const,
      state: text(row.state),
      paymentState: text(row.payment_state),
      total: number(row.amount_total),
      residual: number(row.amount_residual),
      currency: currencyCode(row.currency_id),
      date: text(row.invoice_date),
      odooLink: safeOdooLink(config.url, 'account.move', Number(row.id)),
    })),
  ];

  const openLoops: Customer360Loop[] = [
    ...opportunities.map((row) => ({
      id: Number(row.id),
      title: String(row.name ?? ''),
      kind: 'opportunity' as const,
      state: displayName(row.stage_id),
      due: text(row.date_deadline),
      value: number(row.expected_revenue),
      // Same builder as the document links; only the model differs.
      odooLink: safeOdooLink(config.url, 'crm.lead', Number(row.id)),
    })),
    ...tasks.map((row) => ({
      id: Number(row.id),
      title: String(row.name ?? ''),
      kind: 'task' as const,
      state: displayName(row.stage_id),
      due: text(row.date_deadline),
      odooLink: safeOdooLink(config.url, 'project.task', Number(row.id)),
    })),
    ...tickets.map((row) => ({
      id: Number(row.id),
      title: String(row.name ?? ''),
      kind: 'ticket' as const,
      // The real helpdesk.stage NAME this instance actually uses -- never
      // the reference design's fixed New/Diagnosing/In progress/Resolved
      // vocabulary, which this Odoo's own stage names may not match.
      state: displayName(row.stage_id),
      due: null,
      odooLink: safeOdooLink(config.url, 'helpdesk.ticket', Number(row.id)),
    })),
  ];

  // GROUPED, NOT SUMMED. `def-receivables-headline-figure-is-mostly-draft-
  // invoices-2026-08-13` measured EPIC's own unpaid set as 265 XCD invoices
  // plus 2 USD ones, and states plainly that adding amount_residual across
  // them without conversion "produces a meaningless total". This runtime has
  // no FX rate and must not invent one, so each currency is reported on its
  // own line and the operator reads them separately.
  const byCurrency = new Map<string, number>();
  for (const row of invoices) {
    if (row.state !== 'posted') continue;
    const residual = number(row.amount_residual) ?? 0;
    if (residual === 0) continue;
    const code = currencyCode(row.currency_id) ?? 'UNKNOWN';
    byCurrency.set(code, (byCurrency.get(code) ?? 0) + residual);
  }
  const balances: Customer360Balance[] = [...byCurrency.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => b.amount - a.amount);

  // LIFETIME VALUE: the total of POSTED invoices, never draft ones — an
  // unconfirmed document is not revenue. Grouped by currency for the same
  // reason `balances` is: this ledger has no FX rate and must not invent one.
  const lifetimeByCurrency = new Map<string, number>();
  for (const row of invoices) {
    if (row.state !== 'posted') continue;
    const total = number(row.amount_total) ?? 0;
    if (total === 0) continue;
    const code = currencyCode(row.currency_id) ?? 'UNKNOWN';
    lifetimeByCurrency.set(code, (lifetimeByCurrency.get(code) ?? 0) + total);
  }
  const lifetimeValue: Customer360Balance[] = [...lifetimeByCurrency.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => b.amount - a.amount);

  const rawTags = (partner as unknown as { category_id?: unknown }).category_id;
  const tags = Array.isArray(rawTags)
    ? rawTags.map((t) => displayName(Array.isArray(t) ? t : [t])).filter((t): t is string => !!t)
    : [];

  const now = new Date();
  const followUps: Customer360FollowUp[] = followUpRows.map((row) => ({
    id: Number(row.id),
    summary: String(row.summary ?? ''),
    dueDate: text(row.date_deadline),
    dueLabel: dueDateLabel(text(row.date_deadline), now),
    assignee: displayName(row.user_id),
  }));

  const timeline: Customer360TimelineEntry[] = [
    ...messages.map((m): Customer360TimelineEntry => ({
      kind: 'message',
      id: `msg-${m.createdAt}-${m.content.slice(0, 12)}`,
      date: m.createdAt,
      from: m.role === 'user' ? 'customer' : 'operator',
      text: m.content,
    })),
    ...sales.map((row): Customer360TimelineEntry => ({
      kind: 'order',
      id: `order-${row.id}`,
      date: String(row.date_order ?? ''),
      reference: String(row.name ?? ''),
      total: number(row.amount_total),
      currency: currencyCode(row.currency_id),
      status: text(row.state),
    })),
    ...invoices.map((row): Customer360TimelineEntry => ({
      kind: 'invoice',
      id: `invoice-${row.id}`,
      date: String(row.invoice_date ?? ''),
      reference: String(row.name ?? ''),
      total: number(row.amount_total),
      currency: currencyCode(row.currency_id),
      status: text(row.state),
    })),
  ]
    .filter((e) => e.date)
    .sort((a, b) => b.date.localeCompare(a.date));

  return {
    verifiedAt: now.toISOString(),
    freshness: 'fresh',
    conversation,
    customer: {
      id: partnerId,
      name: partner.name,
      email: partner.email,
      phone: partner.phone,
      city: partner.city,
      // Odoo's own flag. Absent or non-boolean defaults to TRUE — the safe
      // direction, because the cost of an over-formal greeting to a person is
      // trivial and the cost of "Hi EPIC," to a company is a message that
      // reads as machine-generated.
      isCompany: partner.is_company !== false,
      companyName: displayName((partner as unknown as { parent_id?: unknown }).parent_id),
      customerSince: text((partner as unknown as { create_date?: unknown }).create_date),
      tags,
    },
    balances,
    lifetimeValue,
    documents,
    openLoops,
    openLoopsAvailable,
    recommendedAction: recommendedAction(documents, partner.name),
    followUps,
    followUpsAvailable,
    services: servicesResult.services,
    servicesAvailable: servicesResult.available,
    timeline,
    timelineCallsNote: CALLS_NOT_CONNECTED_NOTE,
  };
}

/** Real Magnus CDR data lives on bff-v2, not Foundation, and no
 *  server-to-server read path exists yet -- same fact
 *  lib/context/customer-sources.ts's CALLS_NOT_CONNECTED_REASON already
 *  documents for the sibling lineage. Named so the timeline can say why
 *  calls are absent, not just that they are. */
export const CALLS_NOT_CONNECTED_NOTE =
  'Calls are not shown: Magnus CDR data lives on bff-v2, not Foundation, and no server-to-server read path exists yet.';

/** "Today" / "Tomorrow" only when the real date matches — never a vague
 *  "soon". `now` is passed in so this is computed at the same instant as
 *  the rest of the snapshot, not re-evaluated at render time. */
function dueDateLabel(dateStr: string | null, now: Date): string {
  if (!dateStr) return 'No due date';
  const due = new Date(dateStr);
  if (Number.isNaN(due.getTime())) return dateStr;
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(due) - startOfDay(now)) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  return dateStr.slice(0, 10);
}

/** many2one arrives as [id, "Name"] or false. The numeric id, or null. */
function m2oId(value: unknown): number | null {
  return Array.isArray(value) && typeof value[0] === 'number' ? value[0] : null;
}

/**
 * Confirms an assignee target is a real, active, INTERNAL Odoo user BOUND TO
 * THIS TENANT, before the follow-up write is attempted -- an assigneeRef is
 * caller-supplied input, never trusted as a valid id just because it parses
 * as a number.
 *
 * `share = false` excludes portal/public users: Odoo's shared multi-tenant
 * instance can have external customers with a login, and "any active user"
 * would let a follow-up be assigned to one of them.
 *
 * Odoo identity is NOT tenant proof (Codex review, PR #156): a database or
 * company can be shared across Foundation tenants, so "real, active,
 * internal in THIS Odoo" alone does not prove the user belongs to the
 * ACTING tenant. findBindingByOdooUser (lib/staff-ops/service.ts) is
 * Foundation's own tenant<->Odoo-user binding table, and the SAME check the
 * staff-ops flow already uses for this identical question.
 */
async function resolveAssignableUser(config: OdooConfig, tenantId: string, assigneeRef: string): Promise<{ id: number; name: string } | null> {
  const id = Number(assigneeRef);
  if (!Number.isFinite(id) || id <= 0) return null;
  // 12000ms, matching every other json2Call in this file (Codex review, PR
  // #156: omitting it means NO timeout at all per engines/odoo.ts's own
  // documented default -- a stalled res.users lookup would otherwise hang
  // the request until the hosting platform kills it, unlike the bounded
  // record-system calls immediately after).
  const rows = await json2Call(config, 'res.users', 'search_read', {
    domain: [['id', '=', id], ['active', '=', true], ['share', '=', false]],
    fields: ['id', 'name'],
    limit: 1,
  }, 12000) as Array<{ id: number; name: string }>;
  const row = rows[0];
  if (!row) return null;
  const { findBindingByOdooUser } = await import('@/lib/staff-ops/service');
  const binding = await findBindingByOdooUser(tenantId, Number(row.id));
  // Codex review, PR #156: existence alone is not enough -- a deactivated
  // staff member's binding row still exists. lib/staff-ops/service.ts's own
  // manager-tap path requires `.active` explicitly (service.ts:882-885);
  // this is the same requirement, for the same reason.
  if (!binding || !binding.active) return null;
  return { id: Number(row.id), name: String(row.name ?? '') };
}

/**
 * Writes a real `mail.activity` on this partner via the ALREADY-BUILT,
 * ALREADY-TESTED governed executor (lib/governed/executors/odoo-record-
 * system.ts) rather than a second copy of its activityVals logic. This IS
 * "Create follow-up task" landing a real row, not a toast -- the design's
 * own distinction (dec-c360-... 2026-09-05).
 *
 * assigneeRef (added ev-isola-360-followup-assignment-2026-09-27, closing the
 * W2 gap): optional, an Odoo res.users id as a string. Resolved and verified
 * REAL and ACTIVE before the write -- an assignee that does not resolve is a
 * thrown error, never a silently-dropped assignment. Persistence of the
 * assignment itself (not just the follow-up's existence) is proven by the
 * SAME readback this function already required: readFollowup now selects
 * user_id, and `assignee` below reflects what Odoo actually stored, not what
 * was requested.
 */
export async function createCustomerFollowUp(
  config: OdooConfig,
  partnerId: number,
  note: string,
  dueDate: string,
  assigneeRef: string | null = null,
  tenantId: string | null = null,
): Promise<Customer360FollowUp> {
  const rec = createOdooRecordSystem({ resolveConfig: async () => config });
  let resolvedAssignee: { id: number; name: string } | null = null;
  if (assigneeRef) {
    if (!tenantId) {
      throw new Error('tenantId is required to verify an assignee; the follow-up was not created');
    }
    resolvedAssignee = await resolveAssignableUser(config, tenantId, assigneeRef);
    if (!resolvedAssignee) {
      throw new Error('assigneeRef does not match a real, active, internal user bound to this tenant; the follow-up was not created');
    }
  }
  // companyId is part of RecordSystem's generic interface (other
  // implementations may use it); the Odoo implementation's scheduleFollowup
  // never reads it -- confirmed by reading odoo-record-system.ts directly,
  // not assumed.
  const { externalId } = await rec.scheduleFollowup({
    companyId: 'n/a',
    objectType: 'res.partner',
    objectId: String(partnerId),
    note,
    dueDate,
    ownerRef: resolvedAssignee ? String(resolvedAssignee.id) : null,
  });
  const readback = await rec.readFollowup(externalId);
  if (!readback) {
    throw new Error('the follow-up was created but could not be read back; not shown as confirmed');
  }
  if (resolvedAssignee && m2oId(readback.user_id) !== resolvedAssignee.id) {
    // Codex review, PR #156: comparing DISPLAY NAMES let two same-named
    // users pass as a false match. Compare the numeric id -- the only
    // thing that actually identifies who it landed on -- and use the name
    // only for presentation below. The write reported success but the
    // readback disagrees on WHO it was assigned to -- the same "created
    // but unreadable" honesty standard, pointed at the assignment
    // specifically rather than existence alone.
    throw new Error('the follow-up was created but the assignment could not be confirmed on readback');
  }
  const now = new Date();
  return {
    id: Number(externalId),
    summary: String(readback.summary ?? note),
    dueDate,
    dueLabel: dueDateLabel(dueDate, now),
    assignee: displayName(readback.user_id),
  };
}

/* ── one object, opened inside the customer workspace ──────────────────────── */

/**
 * Distinguish "this Odoo does not have that model" from "the read failed".
 *
 * Odoo's JSON-2 API answers 404 for a model the instance does not carry, and
 * `json2Call` surfaces the status in the thrown message. Measured 2026-08-29 on
 * isola_erp: crm.lead, helpdesk.ticket and stock.picking all 404 while
 * sale.order and account.move answer on the same credential — so the 404 is a
 * fact about the instance, not about Odoo, and production may differ.
 */
function availabilityFromError(err: unknown): DetailAvailability {
  const message = err instanceof Error ? err.message : String(err);
  if (/\(404\)/.test(message)) return 'not-supported';
  // 403 is a GRANT, not a capability. Measured 2026-08-29: production Odoo
  // answers 403 for crm.lead on the ai-operations service account while
  // answering 200 for helpdesk.ticket and stock.picking on the same key. The
  // module is there; the account cannot read it. Saying "unavailable" would
  // describe that as a data problem and hide a one-line ACL fix.
  if (/\(403\)/.test(message)) return 'not-permitted';
  return 'unavailable';
}

async function readSection<T>(
  run: () => Promise<T[]>,
): Promise<{ rows: T[]; availability: DetailAvailability }> {
  try {
    return { rows: await run(), availability: 'available' };
  } catch (err) {
    // An empty array is NEVER returned as if the read had succeeded.
    return { rows: [], availability: availabilityFromError(err) };
  }
}

/**
 * The stage rail for an order, derived ENTIRELY from fields Odoo actually holds.
 *
 * The reference design's rail is Deal→Order→Fulfilled→Invoiced→Paid, but
 * "Fulfilled" requires stock.picking, which is not installed. Rather than draw a
 * step nothing can justify, this derives four honest stages from `state` and
 * `invoice_status`.
 */
function orderStages(state: string | null, invoiceStatus: string | null): Customer360Stage[] {
  const confirmed = state === 'sale' || state === 'done';
  const invoiced = invoiceStatus === 'invoiced';
  const at = !confirmed ? 0 : !invoiced ? 1 : 2;
  return ['Quotation', 'Confirmed', 'Invoiced'].map((label, i) => ({
    key: label.toLowerCase(),
    label,
    state: i < at ? 'done' : i === at ? 'current' : 'upcoming',
  }));
}

/** The invoice rail, from `state` and `payment_state` — both real fields. */
function invoiceStages(state: string | null, paymentState: string | null): Customer360Stage[] {
  const posted = state === 'posted';
  const paid = paymentState === 'paid';
  const partial = paymentState === 'partial';
  const at = !posted ? 0 : paid ? 3 : partial ? 2 : 1;
  return ['Draft', 'Posted', 'Part paid', 'Paid'].map((label, i) => ({
    key: label.toLowerCase().replace(' ', '-'),
    label,
    state: i < at ? 'done' : i === at ? 'current' : 'upcoming',
  }));
}

/**
 * Read ONE object belonging to ONE partner.
 *
 * PARTNER-PINNED, and that is not defensive tidiness. The domain carries
 * `partner_id = partnerId` as well as the record id, so a caller cannot address
 * a record that is not this customer's — without it the route becomes an
 * enumeration oracle over the whole ledger. The send route already models this:
 * it re-reads the snapshot and finds the document within it, and collapses "not
 * yours" and "does not exist" into one wording so neither can be distinguished
 * from outside.
 */
export async function readCustomer360Object(
  config: OdooConfig,
  partnerId: number,
  kind: 'quotation' | 'order' | 'invoice' | 'ticket',
  recordId: number,
): Promise<Customer360ObjectDetail | null> {
  if (!Number.isInteger(recordId) || recordId <= 0) return null;
  // helpdesk.ticket has no lines, payments, amount or currency -- a
  // genuinely different shape, not a branch of the sale/invoice read.
  if (kind === 'ticket') return readTicketObject(config, partnerId, recordId);
  const isInvoice = kind === 'invoice';
  const model = isInvoice ? 'account.move' : 'sale.order';

  const head = await json2Call(config, model, 'search_read', {
    domain: isInvoice
      ? [['id', '=', recordId], ['partner_id', '=', partnerId], ['move_type', '=', 'out_invoice']]
      : [['id', '=', recordId], ['partner_id', '=', partnerId]],
    fields: isInvoice
      ? ['id', 'name', 'state', 'payment_state', 'amount_total', 'currency_id', 'invoice_date', 'invoice_date_due']
      : ['id', 'name', 'state', 'invoice_status', 'amount_total', 'currency_id', 'date_order'],
    limit: 1,
  }, 12000) as Record<string, unknown>[];

  const row = head[0];
  if (!row) return null;

  const lines = await readSection(async () => await json2Call(config, isInvoice ? 'account.move.line' : 'sale.order.line', 'search_read', {
    domain: [[isInvoice ? 'move_id' : 'order_id', '=', recordId]],
    fields: isInvoice
      ? ['id', 'name', 'quantity', 'price_unit', 'price_subtotal', 'display_type']
      : ['id', 'name', 'product_uom_qty', 'price_unit', 'price_subtotal'],
    limit: 60,
  }, 12000) as Promise<Record<string, unknown>[]>);

  // Payments exist only for invoices. A quotation has none — that is a fact
  // about the object, not a failed read, so it reports `available` and empty.
  const payments = isInvoice
    ? await readSection(async () => await json2Call(config, 'account.payment', 'search_read', {
        domain: [['partner_id', '=', partnerId], ['state', '=', 'paid']],
        fields: ['id', 'amount', 'currency_id', 'date', 'name'],
        order: 'date desc',
        limit: 20,
      }, 12000) as Promise<Record<string, unknown>[]>)
    : { rows: [] as Record<string, unknown>[], availability: 'available' as DetailAvailability };

  const state = text(row.state);
  const paymentState = isInvoice ? text(row.payment_state) : null;

  return {
    kind,
    id: recordId,
    reference: String(row.name ?? ''),
    state,
    paymentState,
    total: number(row.amount_total),
    currency: currencyCode(row.currency_id),
    date: text(isInvoice ? row.invoice_date : row.date_order),
    dueDate: isInvoice ? text(row.invoice_date_due) : null,
    odooLink: safeOdooLink(config.url, model, recordId),
    stages: isInvoice
      ? invoiceStages(state, paymentState)
      : orderStages(state, text(row.invoice_status)),
    // Odoo marks section and note rows with a display_type; they are layout,
    // not money, and must not appear as line items.
    lines: lines.rows
      .filter((l) => !text(l.display_type))
      .map((l) => ({
        id: Number(l.id),
        label: String(l.name ?? ''),
        quantity: number(isInvoice ? l.quantity : l.product_uom_qty),
        unitPrice: number(l.price_unit),
        // Odoo's own subtotal. We never recompute qty × price: tax, discount
        // and rounding are the ledger's business, and a figure we derived
        // ourselves could disagree with the invoice the customer holds.
        subtotal: number(l.price_subtotal),
      })),
    linesAvailability: lines.availability,
    payments: payments.rows.map((p) => ({
      id: Number(p.id),
      amount: number(p.amount),
      currency: currencyCode(p.currency_id),
      date: text(p.date),
      reference: text(p.name),
    })),
    paymentsAvailability: payments.availability,
  };
}

/**
 * ONE helpdesk.ticket, partner-pinned the same way the sale/invoice read is.
 *
 * NO STAGE RIBBON, DELIBERATELY. A ribbon needs the real ORDERED sequence of
 * this Odoo's helpdesk.stage records, and helpdesk stages are commonly
 * scoped per TEAM (`team_ids` on helpdesk.stage) -- fetching all stages
 * unfiltered risks showing steps from a team this ticket does not belong
 * to, which would be a wrong ribbon dressed as a real one. That schema has
 * not been verified live on this instance. Until it is, `stages: []` (the
 * honest "nothing to draw" this component already renders as no ribbon at
 * all) and the REAL stage name travels as a plain fact instead -- never the
 * reference design's fixed New/Diagnosing/In progress/Resolved words, which
 * this instance's own stages are not confirmed to use.
 */
async function readTicketObject(
  config: OdooConfig,
  partnerId: number,
  recordId: number,
): Promise<Customer360ObjectDetail | null> {
  const head = await json2Call(config, 'helpdesk.ticket', 'search_read', {
    domain: [['id', '=', recordId], ['partner_id', '=', partnerId]],
    fields: ['id', 'name', 'stage_id', 'priority', 'user_id', 'create_date', 'write_date'],
    limit: 1,
  }, 12000) as Record<string, unknown>[];

  const row = head[0];
  if (!row) return null;

  return {
    kind: 'ticket',
    id: recordId,
    reference: String(row.name ?? ''),
    state: displayName(row.stage_id),
    paymentState: null,
    total: null,
    currency: null,
    date: text(row.create_date),
    dueDate: null,
    odooLink: safeOdooLink(config.url, 'helpdesk.ticket', recordId),
    stages: [],
    lines: [],
    linesAvailability: 'not-supported',
    payments: [],
    paymentsAvailability: 'not-supported',
    priority: text(row.priority),
    assignee: displayName(row.user_id),
    updatedAt: text(row.write_date),
  };
}

/** en-DM: same locale the panel already renders amounts in. */
function formatMoney(amount: number, currency: string | null): string {
  if (!currency) return `${amount.toLocaleString('en-DM')} (currency unknown)`;
  try {
    return new Intl.NumberFormat('en-DM', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toLocaleString('en-DM')} ${currency}`;
  }
}

/**
 * S3: ONE recommendation, and only for the case this slice actually proves —
 * a draft quotation. Every other document shape gets no recommendation
 * rather than a wrong one; withholding is the honest default (dispatch:
 * "recommendation changes or is withheld" for non-draft quotes).
 */
function recommendedAction(
  documents: Customer360Document[],
  customerName: string,
): Customer360RecommendedAction | null {
  const draftQuotation = documents
    .filter((d) => d.kind === 'quotation' && d.state === 'draft')
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0];
  if (!draftQuotation) return null;

  const firstName = customerName.trim().split(/\s+/)[0] || customerName;
  const amount = draftQuotation.total != null
    ? formatMoney(draftQuotation.total, draftQuotation.currency)
    : 'an amount Odoo has not confirmed';

  return {
    kind: 'review-draft-quotation',
    headline: `Review quotation ${draftQuotation.reference} and ask the customer whether they would like to proceed or request changes.`,
    document: draftQuotation,
    reasoning: `${draftQuotation.reference} is a draft quotation for ${customerName} — it has not been sent, approved or accepted. Confirming intent before any further action avoids acting on a stale or unreviewed document.`,
    suggestedReply: `Hi ${firstName}, I've reviewed quotation ${draftQuotation.reference} for ${amount}. Would you like to proceed, or is there anything you'd like adjusted?`,
  };
}
