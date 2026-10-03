/**
 * VERIFIED CUSTOMER SCOPE — which customer is this conversation about?
 *
 * PIVOT PACKET ISOLA-PIVOT-20261002-01, item (b)(2).
 *
 * THE GAP THIS CLOSES
 *   A binding maps an (account, inbox) to a tenant, a company and an employee.
 *   That is server-side and sound. But nothing decided WHICH CUSTOMER or SERVICE
 *   the conversation concerns, so any customer-specific question was answered
 *   from whatever the event — or the model — claimed. Open Port defect:
 *   defect-chatwoot-webhook-account-only-tenant-resolution.
 *
 * THE CONTRACT
 *   The scope is resolved SERVER-SIDE from the one identifier the CHANNEL bound the
 *   conversation to — `conversation.contact_inbox.source_id` (WhatsApp: the wa_id) —
 *   and from nothing else. The signed webhook proves Chatwoot sent the event; it does
 *   not make `sender.phone_number` trustworthy, because that is read off the Contact
 *   record at delivery time and an agent can edit a contact. The conversation's
 *   `custom_attributes`, the message text, the contact's phone and anything the model
 *   says are CLAIMS: they never enter the query and never widen the verdict. An absent
 *   `contact_inbox.source_id` is "no channel-bound subject": unresolved, fail closed.
 *   (That the installed Chatwoot sends `contact_inbox` is UNVERIFIED; see
 *   test/pivot-contact-edit-scope.test.ts.)
 *
 *     verified    a customer this gateway can name; carries the ids the runtime
 *                 may scope its business tools to.
 *     anonymous   a prospect; no customer data is available and none is invented.
 *     unresolved  cannot tell — several holders, no holder match, a lookup error,
 *                 no usable sender. FAIL CLOSED: the model is not called, no
 *                 AI-composed reply is sent, a human is shown the conversation.
 *
 *   "unresolved" is NOT "anonymous". Treating "I could not find out" as "a
 *   stranger" would let the model answer a customer-specific question about an
 *   account it could not identify (Law 12: a confident wrong answer about
 *   someone else's account is worse than an error).
 *
 * WHAT IS VERIFIED AND WHAT IS NOT (Law 5, Law 23)
 *   On a live WhatsApp channel the sender phone is Meta-verified: the platform
 *   authenticated the number. On an API-channel TEST inbox the contact
 *   identifier is set by WHOEVER CREATED THE CONVERSATION, so it is NOT
 *   channel-verified. A test on such an inbox is a controlled fixture: it
 *   proves the gateway's behaviour given an identifier, not that the identifier
 *   was authenticated. The fixture resolver below therefore matches ONLY a known
 *   fixture account and reports everything else `unresolved` — it never mints
 *   `anonymous` from an unknown number.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *   The production resolver. The business-identity layer for Personal Line is
 *   bff-v2's LiteAccount, resolved by `resolveExistingBinding` in
 *   `app/lib/lite-signup-identity.ts` (single holder = existing; several = the
 *   one whose userId equals the phone digits, else ambiguous; lookup error =
 *   ambiguous). That logic lives behind bff-v2's database. The internal routes
 *   that exist today (`POST /api/internal/personal-line/accounts`, a paged
 *   population read that excludes fixtures and never serves a Magnus id, and
 *   `GET /api/internal/personal-line/:liteAccountId/service-detail`, keyed by
 *   LiteAccount id) offer NO phone-keyed lookup, and re-implementing
 *   `resolveHolderByIdentity` here would create a second copy of an identity
 *   rule (CLAUDE.md §2.21). So the shipped default for a configured-but-
 *   unwired resolver is `createFailClosedCustomerScopeResolver`, which answers
 *   `unresolved` for everyone. An HTTP-backed resolver needs a phone-keyed
 *   internal route in bff-v2 first; that is a change to another lane's deployed
 *   service and is NOT made here.
 */
import { normalisePhone } from "./allowlist.js";

/** What the resolver is asked. ONLY values the signed webhook and the binding authenticate. */
export interface CustomerScopeQuery {
  tenantId: string;
  chatwootAccountId: number;
  chatwootInboxId: number;
  chatwootConversationId: number;
  /**
   * The identifier the CHANNEL bound the conversation to (`conversation.contact_inbox
   * .source_id`; WhatsApp: the wa_id). NOT `sender.phone_number`: that is read off the
   * Contact record, which an agent can edit. Null = no channel-bound subject => fail closed.
   */
  channelSubject: string | null;
}

export interface VerifiedCustomerScope {
  kind: "verified";
  /** The stable customer id. For Personal Line this is the LiteAccount id. */
  customerId: string;
  /** The services this customer holds; the runtime scopes business tools to these. */
  serviceIds: string[];
  /** Personal Line identity ids, when the resolver knows them. */
  liteAccountId?: string;
  magnusUserId?: string | null;
  /** The commercial-record link. Odoo is the record, never the identity resolver. */
  odooPartnerId?: string | null;
}

export type CustomerScopeVerdict =
  | VerifiedCustomerScope
  | { kind: "anonymous" }
  | { kind: "unresolved" };

export interface CustomerScopeResolver {
  resolve(query: CustomerScopeQuery): Promise<CustomerScopeVerdict>;
}

/** Why a verdict was `unresolved` — for the log, never for the customer. */
export type UnresolvedReason =
  | "resolver_said_unresolved"
  | "resolver_failed"
  | "resolver_returned_invalid_verdict";

export interface ResolvedScope {
  verdict: CustomerScopeVerdict;
  /** Set only when `verdict.kind === "unresolved"`. */
  reason: UnresolvedReason | null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Ask the resolver, and NEVER let its failure become an answer.
 *
 * A rejected resolver, a thrown synchronous error and a verdict this build does
 * not recognise are all `unresolved`. The verdict is rebuilt field by field, so
 * a resolver (or a future HTTP body) cannot smuggle extra properties — a claim
 * included — into the run context.
 */
export async function resolveCustomerScope(
  resolver: CustomerScopeResolver,
  query: CustomerScopeQuery,
): Promise<ResolvedScope> {
  let raw: unknown;
  try {
    raw = await resolver.resolve(query);
  } catch {
    return { verdict: { kind: "unresolved" }, reason: "resolver_failed" };
  }
  if (typeof raw !== "object" || raw === null) {
    return { verdict: { kind: "unresolved" }, reason: "resolver_returned_invalid_verdict" };
  }
  const v = raw as Record<string, unknown>;
  if (v["kind"] === "anonymous") return { verdict: { kind: "anonymous" }, reason: null };
  if (v["kind"] === "unresolved") {
    return { verdict: { kind: "unresolved" }, reason: "resolver_said_unresolved" };
  }
  if (
    v["kind"] === "verified" &&
    isNonEmptyString(v["customerId"]) &&
    Array.isArray(v["serviceIds"]) &&
    v["serviceIds"].every(isNonEmptyString)
  ) {
    const verified: VerifiedCustomerScope = {
      kind: "verified",
      customerId: v["customerId"],
      serviceIds: [...(v["serviceIds"] as string[])],
    };
    if (isNonEmptyString(v["liteAccountId"])) verified.liteAccountId = v["liteAccountId"];
    if (v["magnusUserId"] === null || isNonEmptyString(v["magnusUserId"])) {
      verified.magnusUserId = v["magnusUserId"] as string | null;
    }
    if (v["odooPartnerId"] === null || isNonEmptyString(v["odooPartnerId"])) {
      verified.odooPartnerId = v["odooPartnerId"] as string | null;
    }
    return { verdict: verified, reason: null };
  }
  return { verdict: { kind: "unresolved" }, reason: "resolver_returned_invalid_verdict" };
}

/**
 * The shipped default for "customer scope is required but no lookup is wired":
 * everyone is `unresolved`. A TODO that fails CLOSED rather than a stub that
 * answers — it is the honest state until bff-v2 offers a phone-keyed route.
 */
export function createFailClosedCustomerScopeResolver(): CustomerScopeResolver {
  return { resolve: async () => ({ kind: "unresolved" }) };
}

/**
 * The channel-bound subject, but only when the `contact_inbox` it came from is
 * coherent with this delivery: its `contact_id` is the sender (when both are
 * present) and its `inbox_id` is the inbox the binding routed (when present). A
 * `contact_inbox` that is not the sender's, or not this inbox's, is not a subject
 * channel-bound FOR THIS CONVERSATION, so the scope fails closed exactly as it does
 * for an absent one. Codex round 2: an id that is ABSENT cannot be cross-checked, and
 * accepting it let a signed payload pair another sender with a known fixture
 * `source_id` and simply omit the ids that would have exposed it. So when scope
 * resolution is on, an absent comparison id is UNRESOLVED (fail closed), not a pass.
 * If Chatwoot does not send these nodes, every sender escalates to a person: loud, not
 * wrong. STILL not production identity evidence: HMAC proves the payload's origin and
 * integrity, not the upstream provenance of each field.
 */
export function coherentChannelSubject(args: {
  channelSubject: string | null;
  senderType: string | null;
  senderId: number | null;
  contactInboxContactId: number | null;
  contactInboxInboxId: number | null;
  routedInboxId: number;
}): string | null {
  if (args.channelSubject === null) return null;
  if (args.senderType === "contact") {
    // Both must be PRESENT to be compared at all, and equal.
    if (args.senderId === null || args.contactInboxContactId === null) return null;
    if (args.senderId !== args.contactInboxContactId) return null;
  }
  if (args.contactInboxInboxId === null || args.contactInboxInboxId !== args.routedInboxId) return null;
  return args.channelSubject;
}

/** One known fixture account. Never a real customer. */
export interface CustomerScopeFixture {
  senderPhone: string;
  customerId: string;
  serviceIds: string[];
  /**
   * Bind the fixture to ONE (tenant, account, inbox). Enforced WHEN PRESENT; the env
   * wiring (the only production-reachable one) REQUIRES all three, so a fixture
   * account cannot verify on an inbox it was not declared for.
   */
  tenantId?: string;
  chatwootAccountId?: number;
  chatwootInboxId?: number;
  liteAccountId?: string;
  magnusUserId?: string | null;
  odooPartnerId?: string | null;
}

/**
 * A resolver for a CONTROLLED FIXTURE inbox (the owner's own test account).
 *
 * It matches the sender phone, digits-only and exact (never a suffix), against a
 * fixed list. A number that is not on the list is `unresolved`, NOT `anonymous`:
 * on an API-channel inbox the identifier is caller-supplied, so "unknown" must
 * not quietly become "a prospect we may answer".
 *
 * Throws on a duplicate phone: two fixtures for one number is the very
 * ambiguity the production rule refuses, and silently picking one would hide it.
 */
export function createFixtureCustomerScopeResolver(
  fixtures: readonly CustomerScopeFixture[],
): CustomerScopeResolver {
  const byPhone = new Map<string, CustomerScopeFixture>();
  for (const fixture of fixtures) {
    const key = normalisePhone(fixture.senderPhone);
    if (key === null) {
      throw new Error("customer scope fixture: senderPhone is not a usable phone number");
    }
    if (!isNonEmptyString(fixture.customerId)) {
      throw new Error("customer scope fixture: customerId is required");
    }
    if (byPhone.has(key)) {
      throw new Error("customer scope fixture: two fixtures share one phone number");
    }
    byPhone.set(key, fixture);
  }
  return {
    resolve: async (query) => {
      const key = normalisePhone(query.channelSubject);
      if (key === null) return { kind: "unresolved" };
      const fixture = byPhone.get(key);
      if (fixture === undefined) return { kind: "unresolved" };
      if (fixture.tenantId !== undefined && fixture.tenantId !== query.tenantId) return { kind: "unresolved" };
      if (fixture.chatwootAccountId !== undefined && fixture.chatwootAccountId !== query.chatwootAccountId) {
        return { kind: "unresolved" };
      }
      if (fixture.chatwootInboxId !== undefined && fixture.chatwootInboxId !== query.chatwootInboxId) {
        return { kind: "unresolved" };
      }
      const verified: VerifiedCustomerScope = {
        kind: "verified",
        customerId: fixture.customerId,
        serviceIds: [...fixture.serviceIds],
      };
      if (fixture.liteAccountId !== undefined) verified.liteAccountId = fixture.liteAccountId;
      if (fixture.magnusUserId !== undefined) verified.magnusUserId = fixture.magnusUserId;
      if (fixture.odooPartnerId !== undefined) verified.odooPartnerId = fixture.odooPartnerId;
      return verified;
    },
  };
}

export type CustomerScopeFromEnv =
  | { ok: true; resolver: CustomerScopeResolver | undefined; mode: "off" | "fail_closed" | "fixture" }
  | { ok: false; error: string };

/**
 * Boot-time selection. Variable NAMES only are documented here; no value is
 * ever logged.
 *
 *   GATEWAY_CUSTOMER_SCOPE_MODE   unset | "off"   no resolver: behaviour is exactly
 *                                                 what it was before this change.
 *                                 "fail_closed"   every PUBLIC sender is unresolved.
 *                                 "fixture"       match GATEWAY_CUSTOMER_SCOPE_FIXTURES_JSON.
 *
 * Any other value, or "fixture" with a missing / malformed / empty list, REFUSES
 * to boot: a typo that quietly reads as "off" would turn a required control into
 * no control (the same stance as GATEWAY_FAILPOINT).
 */
export function customerScopeFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): CustomerScopeFromEnv {
  const rawMode = env["GATEWAY_CUSTOMER_SCOPE_MODE"]?.trim();
  if (rawMode === undefined || rawMode === "" || rawMode === "off") {
    return { ok: true, resolver: undefined, mode: "off" };
  }
  if (rawMode === "fail_closed") {
    return { ok: true, resolver: createFailClosedCustomerScopeResolver(), mode: "fail_closed" };
  }
  if (rawMode !== "fixture") {
    return {
      ok: false,
      error:
        'GATEWAY_CUSTOMER_SCOPE_MODE must be "off", "fail_closed" or "fixture"; an unrecognised value is refused rather than treated as off',
    };
  }
  const rawFixtures = env["GATEWAY_CUSTOMER_SCOPE_FIXTURES_JSON"];
  if (!isNonEmptyString(rawFixtures)) {
    return {
      ok: false,
      error: 'GATEWAY_CUSTOMER_SCOPE_MODE="fixture" requires GATEWAY_CUSTOMER_SCOPE_FIXTURES_JSON',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawFixtures);
  } catch {
    return { ok: false, error: "GATEWAY_CUSTOMER_SCOPE_FIXTURES_JSON is not valid JSON" };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return {
      ok: false,
      error: "GATEWAY_CUSTOMER_SCOPE_FIXTURES_JSON must be a non-empty JSON array",
    };
  }
  try {
    const fixtures: CustomerScopeFixture[] = parsed.map((entry: unknown, index: number) => {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`fixture[${index}] must be an object`);
      }
      const e = entry as Record<string, unknown>;
      if (!isNonEmptyString(e["senderPhone"]) || !isNonEmptyString(e["customerId"])) {
        throw new Error(`fixture[${index}] needs senderPhone and customerId`);
      }
      const serviceIds = e["serviceIds"];
      if (!Array.isArray(serviceIds) || !serviceIds.every(isNonEmptyString)) {
        throw new Error(`fixture[${index}].serviceIds must be an array of non-empty strings`);
      }
      // A fixture is declared for ONE (tenant, account, inbox) and must say which.
      if (
        !isNonEmptyString(e["tenantId"]) ||
        typeof e["chatwootAccountId"] !== "number" ||
        !Number.isInteger(e["chatwootAccountId"]) ||
        typeof e["chatwootInboxId"] !== "number" ||
        !Number.isInteger(e["chatwootInboxId"])
      ) {
        throw new Error(`fixture[${index}] needs tenantId, chatwootAccountId and chatwootInboxId`);
      }
      const fixture: CustomerScopeFixture = {
        senderPhone: e["senderPhone"],
        customerId: e["customerId"],
        serviceIds: [...serviceIds],
        tenantId: e["tenantId"],
        chatwootAccountId: e["chatwootAccountId"],
        chatwootInboxId: e["chatwootInboxId"],
      };
      if (isNonEmptyString(e["liteAccountId"])) fixture.liteAccountId = e["liteAccountId"];
      if (e["magnusUserId"] === null || isNonEmptyString(e["magnusUserId"])) {
        fixture.magnusUserId = e["magnusUserId"] as string | null;
      }
      if (e["odooPartnerId"] === null || isNonEmptyString(e["odooPartnerId"])) {
        fixture.odooPartnerId = e["odooPartnerId"] as string | null;
      }
      return fixture;
    });
    return { ok: true, resolver: createFixtureCustomerScopeResolver(fixtures), mode: "fixture" };
  } catch (err) {
    // The message names the index and the rule, never a value.
    return {
      ok: false,
      error: `GATEWAY_CUSTOMER_SCOPE_FIXTURES_JSON invalid: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}
