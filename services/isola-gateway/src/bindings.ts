/**
 * Bindings: the map from a Chatwoot inbox to exactly one tenant, one Paperclip
 * company, one PUBLIC employee and one template.
 *
 * This is the tenant-isolation boundary of the whole gateway. Everything here
 * fails closed:
 *
 *  - boot rejects a binding whose `exposure` is not `PUBLIC` — an INTERNAL
 *    employee must never be reachable from a public inbox;
 *  - boot rejects a duplicate `(chatwootAccountId, chatwootInboxId)` pair —
 *    two tenants on one inbox is an isolation failure, not a routing choice;
 *  - boot rejects a binding with no AgentBot secret or no access token — an
 *    unverifiable or unsendable binding is worse than an absent one;
 *  - resolution refuses `not_found`, `duplicate`, `retired` and `not_public`
 *    at request time as well, so a future store that can return a duplicate
 *    (NocoBase, a database) still cannot get one past this module.
 *
 * `BindingStore` exists so the env-backed store below can be replaced by a
 * NocoBase-backed one without touching the handler.
 */

export type Exposure = "PUBLIC" | "INTERNAL";
export type BindingStatus = "active" | "retired";

/**
 * The ONLY lifecycle value that may receive traffic.
 *
 * Lifecycle was previously carried as Paperclip metadata (`isolaLifecycle`) that
 * nothing enforced, and a PUBLIC agent marked `staged-not-ready` woke and replied.
 * It is now a routing precondition checked here, at the boundary, rather than a
 * label read somewhere downstream.
 */
export const ROUTABLE_LIFECYCLE = "accepted";

/**
 * Fail-closed lifecycle predicate.
 *
 * Everything that is not the exact string "accepted" is non-routable: absent,
 * null, "staged-not-ready", "rejected", a stale or unknown projection value, a
 * number, an object, differing case, or surrounding whitespace. There is no
 * normalisation and no coercion on purpose — a projection that cannot state
 * `"accepted"` exactly is a projection we do not trust.
 */
export function isRoutableLifecycle(value: unknown): boolean {
  return value === ROUTABLE_LIFECYCLE;
}

export interface Binding {
  tenantId: string;
  chatwootAccountId: number;
  chatwootInboxId: number;
  chatwootAgentBotId: number;
  /** HMAC key for inbound webhook verification. Never logged, never returned. */
  agentBotSecret: string;
  /** `api_access_token` for the outbound Application API. Never logged, never returned. */
  agentBotAccessToken: string;
  paperclipCompanyId: string;
  paperclipAgentId: string;
  templateId: string;
  exposure: Exposure;
  /**
   * Staff numbers permitted to reach an INTERNAL line. EMPTY MEANS NOBODY.
   * Meaningless on a PUBLIC binding and ignored there.
   */
  allowedSenders: readonly string[];
  status: BindingStatus;
  /**
   * Lifecycle as supplied by the runtime projection, kept verbatim.
   *
   * Deliberately `string | null` and NOT a narrow union: an unknown or malformed
   * projection value must be representable so it can be refused at resolution.
   * Narrowing here would force a parse-time error, which would take the gateway
   * down on a bad projection instead of refusing the one affected binding.
   */
  lifecycle: string | null;
  /**
   * The Chatwoot INSTANCE this binding's inbox lives in, e.g.
   * `https://inbox.epic.dm`. Absent means the gateway's configured default,
   * which is the normal case and is what every binding should use.
   *
   * WHAT THIS IS NOT FOR
   *   It is NOT how Isola does multi-tenancy. The target architecture is ONE
   *   Chatwoot instance serving many tenants as separate Chatwoot ACCOUNTS,
   *   which is Chatwoot's own model and is what `chatwootAccountId` +
   *   `chatwootInboxId` already key on. A Chatwoot instance per customer is
   *   not the design and should not become one by habit.
   *
   * WHY IT EXISTS ANYWAY
   *   Because the estate currently has TWO instances and a migration between
   *   them. Without a per-binding host, a gateway process can serve exactly one
   *   instance, which makes moving inboxes between them ALL-OR-NOTHING: every
   *   inbox cuts over in the same breath, and a rollback takes them all back.
   *
   *   With it, inboxes move ONE AT A TIME. Each is a single field on a single
   *   binding, each rolls back independently, and an inbox already moved and an
   *   inbox not yet moved are served side by side by the same process. That is
   *   also what lets a UAT inbox and a production inbox coexist, so the
   *   regression harness survives a cutover instead of being spent on it.
   *
   *   Once consolidation is finished this field goes back to being unset
   *   everywhere and costs nothing.
   *
   * The HOST of this URL must be on the egress allowlist. That is checked at
   * boot (see `bootWarnings` in src/config.ts) rather than discovered on the
   * first customer message, because an unallowlisted host fails every call
   * closed and looks like an outage rather than a misconfiguration.
   */
  chatwootBaseUrl?: string;
  /** Team to assign on escalation. Absent means "escalate but do not assign". */
  escalationTeamId?: number;
  /** Extra approved labels for this tenant, on top of the configured defaults. */
  labels?: string[];
}

export interface BindingStore {
  /** Every binding known to the store, including retired ones. */
  list(): readonly Binding[];
}

export class StaticBindingStore implements BindingStore {
  private readonly bindings: readonly Binding[];
  constructor(bindings: readonly Binding[]) {
    this.bindings = Object.freeze([...bindings]);
  }
  list(): readonly Binding[] {
    return this.bindings;
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type BindingResolution =
  | { kind: "ok"; binding: Binding }
  | { kind: "not_found" }
  | { kind: "duplicate"; count: number }
  | { kind: "retired"; tenantId: string }
  | { kind: "not_public"; tenantId: string; exposure: Exposure }
  | { kind: "not_accepted"; tenantId: string; lifecycle: string | null };

/** Every binding addressed by this (account, inbox) pair, in declaration order. */
export function matchBindings(
  bindings: readonly Binding[],
  accountId: number | null,
  inboxId: number | null,
): Binding[] {
  if (accountId === null || inboxId === null) return [];
  return bindings.filter(
    (b) => b.chatwootAccountId === accountId && b.chatwootInboxId === inboxId,
  );
}

/**
 * Resolve to exactly one servable binding.
 *
 * Precedence, deliberately ordered so the reported reason is the OPERATOR'S
 * disposition first and the platform's judgement second:
 *
 *   match -> status -> exposure -> lifecycle
 *
 * **Status first.** A binding an operator deliberately retired must keep
 * reporting `retired`. An earlier revision evaluated lifecycle first on the
 * theory that "an unaccepted agent is wired to an inbox" is the more alarming
 * half; that was wrong. It is routing-inert but not *operationally* inert — it
 * rewrites audit evidence and masks the fact that a binding was intentionally
 * removed. The retired disposition is a deliberate human act and outranks a
 * derived platform state.
 *
 * Exposure before lifecycle: an INTERNAL employee on a public inbox is a
 * containment failure, whereas a non-accepted lifecycle is a readiness failure.
 * In practice this ordering is defensive only — `parseBindings` refuses any
 * non-PUBLIC exposure at boot, so an INTERNAL binding cannot reach resolution
 * through configuration at all.
 *
 * PUBLIC exposure grants nothing on its own — passing the exposure check does
 * not short-circuit the lifecycle check. That is the whole point: PUBLIC means
 * "eligible to be bound", never "accepted".
 */
export function resolveBinding(
  bindings: readonly Binding[],
  accountId: number | null,
  inboxId: number | null,
): BindingResolution {
  const matches = matchBindings(bindings, accountId, inboxId);
  if (matches.length === 0) return { kind: "not_found" };
  if (matches.length > 1) return { kind: "duplicate", count: matches.length };
  const binding = matches[0] as Binding;
  if (binding.status !== "active") {
    return { kind: "retired", tenantId: binding.tenantId };
  }
  // INTERNAL IS NO LONGER REFUSED HERE — the refusal moved, it did not vanish.
  //
  // This used to reject every non-PUBLIC binding, and `parseBindings` hardcoded
  // PUBLIC so one could not exist anyway. That was the right default while there
  // was no way to say WHO may use an internal line. There is now: an INTERNAL
  // binding carries an allowlist, and `checkSender` refuses anyone not on it
  // BEFORE the brain is invoked or any content is written.
  //
  // The safety property is unchanged in substance: an INTERNAL binding with an
  // empty allowlist answers nobody. It is now refused per-SENDER and logged with
  // a reason, instead of being invisible at boot — a misconfigured staff line
  // that says "empty_allowlist" on every message is far easier to fix than one
  // that silently never loaded.
  if (binding.exposure !== "PUBLIC" && binding.exposure !== "INTERNAL") {
    return { kind: "not_public", tenantId: binding.tenantId, exposure: binding.exposure };
  }
  if (!isRoutableLifecycle(binding.lifecycle)) {
    return { kind: "not_accepted", tenantId: binding.tenantId, lifecycle: binding.lifecycle };
  }
  return { kind: "ok", binding };
}

/**
 * The secrets that may have signed a delivery addressed to this (account,
 * inbox) pair. Retired and non-PUBLIC bindings are included deliberately: a
 * delivery from a retired bot is authentic, and it should be answered with
 * "verified, then declined" rather than with "unauthorized", so the operator
 * sees the real reason in the log.
 */
export function candidateSecrets(
  bindings: readonly Binding[],
  accountId: number | null,
  inboxId: number | null,
): string[] {
  return matchBindings(bindings, accountId, inboxId)
    .map((b) => b.agentBotSecret)
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Parsing and validation
// ---------------------------------------------------------------------------

export type BindingParseResult =
  | { ok: true; bindings: Binding[] }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  index: number,
  errors: string[],
): string | null {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`binding[${index}]: "${key}" must be a non-empty string`);
    return null;
  }
  return value.trim();
}

function requiredInt(
  record: Record<string, unknown>,
  key: string,
  index: number,
  errors: string[],
): number | null {
  const value = record[key];
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  errors.push(`binding[${index}]: "${key}" must be a positive integer`);
  return null;
}

function optionalInt(
  record: Record<string, unknown>,
  key: string,
  index: number,
  errors: string[],
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  errors.push(`binding[${index}]: "${key}", when present, must be a positive integer`);
  return undefined;
}

/**
 * The tenant's own Chatwoot origin, validated hard at boot.
 *
 * HTTPS ONLY, and origin only — no path, no query, no fragment, no credentials
 * in the URL. Every one of those is refused rather than normalised away:
 *
 *   - `http://` would send an AgentBot access token over the wire in clear. The
 *     token is the tenant's whole authority over its Chatwoot account.
 *   - a path would be silently concatenated with the API path built downstream,
 *     producing a URL nobody wrote and a 404 that looks like Chatwoot is down.
 *   - `user:pass@host` would put a credential somewhere that is logged as a
 *     "base URL" by everything that handles one.
 *
 * A trailing slash IS tolerated and stripped, because it is the one variation
 * that is unambiguous and that people type constantly.
 */
function optionalBaseUrl(
  record: Record<string, unknown>,
  index: number,
  errors: string[],
): string | undefined {
  const value = record["chatwootBaseUrl"];
  if (value === undefined || value === null) return undefined;

  const refuse = (why: string): undefined => {
    errors.push(`binding[${index}]: "chatwootBaseUrl", when present, ${why}`);
    return undefined;
  };

  if (typeof value !== "string" || value.trim().length === 0) {
    return refuse("must be a non-empty string");
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return refuse("must be an absolute URL");
  }

  if (url.protocol !== "https:") {
    return refuse(
      "must be https — this URL carries an AgentBot access token on every outbound call",
    );
  }
  if (url.username !== "" || url.password !== "") {
    return refuse("must not embed credentials in the URL");
  }
  if (url.search !== "" || url.hash !== "") {
    return refuse("must be an origin with no query string or fragment");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return refuse(
      "must be an origin with no path — the Chatwoot API path is appended to it",
    );
  }

  // `origin` drops the trailing slash and any default port for us.
  return url.origin;
}

function optionalLabels(
  record: Record<string, unknown>,
  index: number,
  errors: string[],
): string[] | undefined {
  const value = record["labels"];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    errors.push(`binding[${index}]: "labels", when present, must be an array of strings`);
    return undefined;
  }
  const cleaned = (value as string[]).map((v) => v.trim()).filter((v) => v.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Parse and strictly validate `GATEWAY_BINDINGS_JSON`.
 *
 * Error strings name the field and the array index — never a value, so a bad
 * secret can never be echoed into a boot log.
 *
 * An absent or empty value is NOT an error: it yields zero bindings, the
 * service still boots, `/healthz` still answers, and every webhook fails
 * closed. `bootWarnings()` says so loudly.
 */
export function parseBindings(raw: string | null | undefined): BindingParseResult {
  if (raw === null || raw === undefined || raw.trim().length === 0) {
    return { ok: true, bindings: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ["GATEWAY_BINDINGS_JSON is not valid JSON"] };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, errors: ["GATEWAY_BINDINGS_JSON must be a JSON array"] };
  }

  const errors: string[] = [];
  const bindings: Binding[] = [];

  parsed.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push(`binding[${index}]: must be a JSON object`);
      return;
    }

    const tenantId = requiredString(entry, "tenantId", index, errors);
    const chatwootAccountId = requiredInt(entry, "chatwootAccountId", index, errors);
    const chatwootInboxId = requiredInt(entry, "chatwootInboxId", index, errors);
    const chatwootAgentBotId = requiredInt(entry, "chatwootAgentBotId", index, errors);
    const agentBotSecret = requiredString(entry, "agentBotSecret", index, errors);
    const agentBotAccessToken = requiredString(entry, "agentBotAccessToken", index, errors);
    const paperclipCompanyId = requiredString(entry, "paperclipCompanyId", index, errors);
    const paperclipAgentId = requiredString(entry, "paperclipAgentId", index, errors);
    const templateId = requiredString(entry, "templateId", index, errors);
    const escalationTeamId = optionalInt(entry, "escalationTeamId", index, errors);
    const chatwootBaseUrl = optionalBaseUrl(entry, index, errors);
    const labels = optionalLabels(entry, index, errors);

    const exposureRaw = entry["exposure"];
    // Still the hardest rule in this file, now stated in two parts.
    //
    // It used to be "PUBLIC or nothing", because there was no way to say who may
    // use an internal line. There is now, so INTERNAL is admissible — but ONLY
    // with an allowlist, and an unknown exposure is still refused outright
    // rather than defaulted. A typo must never become a routing decision.
    if (exposureRaw !== "PUBLIC" && exposureRaw !== "INTERNAL") {
      errors.push(
        `binding[${index}]: "exposure" must be exactly "PUBLIC" or "INTERNAL" — an unrecognised exposure is refused rather than defaulted`,
      );
    }
    const exposureValue: Exposure = exposureRaw === "INTERNAL" ? "INTERNAL" : "PUBLIC";

    // The allowlist. Absent is an empty list, and an empty list answers NOBODY —
    // see checkSender(). Absent is NOT a boot error on purpose: the same
    // reasoning as lifecycle below, a malformed entry must cost that binding its
    // reachability, never take the gateway down. A non-array, or entries that
    // are not strings, are refused loudly because that IS a config mistake with
    // no safe reading.
    let allowedSenders: readonly string[] = [];
    const allowedRaw = entry["allowedSenders"];
    if (allowedRaw !== undefined && allowedRaw !== null) {
      if (!Array.isArray(allowedRaw) || allowedRaw.some((v) => typeof v !== "string")) {
        errors.push(`binding[${index}]: "allowedSenders" must be an array of strings when present`);
      } else {
        allowedSenders = allowedRaw as string[];
      }
    }
    // An INTERNAL binding with an empty list is NOT a parse error: it is the
    // safe half-configured state and must be shippable. It must not be SILENT,
    // though — the boot line reports exposure and allowlist size per binding,
    // and every refused message logs `empty_allowlist` by name.

    const statusRaw = entry["status"];
    if (statusRaw !== "active" && statusRaw !== "retired") {
      errors.push(`binding[${index}]: "status" must be "active" or "retired"`);
    }

    // Lifecycle is deliberately NOT a boot-time error, in either direction.
    //
    // Absent or unknown is not rejected here, because a projection that omits or
    // garbles lifecycle for one binding must not take the whole gateway down —
    // it must cost exactly that one binding its routability. The refusal happens
    // in resolveBinding(), which fails closed. Keeping the raw value lets the
    // refusal say what it actually saw.
    const lifecycleRaw = entry["lifecycle"];
    const lifecycle = typeof lifecycleRaw === "string" ? lifecycleRaw : null;

    if (
      tenantId === null ||
      chatwootAccountId === null ||
      chatwootInboxId === null ||
      chatwootAgentBotId === null ||
      agentBotSecret === null ||
      agentBotAccessToken === null ||
      paperclipCompanyId === null ||
      paperclipAgentId === null ||
      templateId === null ||
      // A SECOND gate on exposure, and it must agree with the error above or a
      // binding is silently dropped while `ok` stays true — which is exactly
      // what happened when only the error message was updated: parse reported
      // success and returned an empty list.
      (exposureRaw !== "PUBLIC" && exposureRaw !== "INTERNAL") ||
      (statusRaw !== "active" && statusRaw !== "retired")
    ) {
      return;
    }

    bindings.push({
      tenantId,
      chatwootAccountId,
      chatwootInboxId,
      chatwootAgentBotId,
      agentBotSecret,
      agentBotAccessToken,
      paperclipCompanyId,
      paperclipAgentId,
      templateId,
      exposure: exposureValue,
      allowedSenders,
      status: statusRaw,
      lifecycle,
      ...(chatwootBaseUrl === undefined ? {} : { chatwootBaseUrl }),
      ...(escalationTeamId === undefined ? {} : { escalationTeamId }),
      ...(labels === undefined ? {} : { labels }),
    });
  });

  // Duplicate (account, inbox) pairs are refused even when the duplicate rows
  // are otherwise valid and even when one of them is retired: the pair is the
  // routing key, and an ambiguous routing key must not exist at all.
  const seen = new Map<string, number>();
  for (const [index, binding] of bindings.entries()) {
    const key = `${binding.chatwootAccountId}:${binding.chatwootInboxId}`;
    const first = seen.get(key);
    if (first !== undefined) {
      errors.push(
        `binding[${index}]: duplicate (chatwootAccountId, chatwootInboxId) pair ${key}, already declared at binding[${first}]`,
      );
    } else {
      seen.set(key, index);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, bindings };
}

/** Binding metadata safe to return over `GET /v1/bindings`. No secret material. */
export function redactBinding(binding: Binding): Record<string, unknown> {
  return {
    tenantId: binding.tenantId,
    chatwootAccountId: binding.chatwootAccountId,
    chatwootInboxId: binding.chatwootInboxId,
    chatwootAgentBotId: binding.chatwootAgentBotId,
    paperclipCompanyId: binding.paperclipCompanyId,
    paperclipAgentId: binding.paperclipAgentId,
    templateId: binding.templateId,
    exposure: binding.exposure,
    status: binding.status,
    lifecycle: binding.lifecycle,
    // Explicit, so an operator reading GET /v1/bindings sees routability rather
    // than having to infer it from a string they might mis-read.
    lifecycleRoutable: isRoutableLifecycle(binding.lifecycle),
    escalationTeamId: binding.escalationTeamId ?? null,
    labels: binding.labels ?? [],
    // Presence, never the value.
    agentBotSecret: "[redacted]",
    agentBotAccessToken: "[redacted]",
    agentBotSecretConfigured: binding.agentBotSecret.length > 0,
    agentBotAccessTokenConfigured: binding.agentBotAccessToken.length > 0,
    // ── WHO MAY REACH AN INTERNAL LINE ───────────────────────────────────
    //
    // This was omitted entirely until 2026-08-18 — not the values, not even a
    // count. An operator could not answer "who can talk to the staff agent?"
    // from the deployed state at all.
    //
    // The cost was measured, not hypothesised. A non-staff number was found on
    // the internal allowlist, and because the list could not be READ, it had to
    // be diagnosed by ARITHMETIC (deployed size 7, minus the 5 active Odoo
    // employees with a usable number) and by firing a synthetic probe to see
    // whether the gate fired at all. A security list nobody can enumerate is a
    // security list nobody can audit.
    //
    // Full numbers are NEVER returned: they are staff personal phone numbers,
    // and an admin endpoint is not a reason to hand them out. Last four digits
    // plus a length identify an entry to someone who already knows the number —
    // enough to answer "is MY number on this list?" and "does this list have an
    // entry that should not be here?" — without the response becoming a staff
    // directory.
    allowedSendersCount: binding.allowedSenders.length,
    allowedSenders: binding.allowedSenders.map(maskSender),
  };
}

/**
 * Last four digits and a digit count. Never the number.
 *
 * An entry that cannot be parsed is reported as `unparseable` rather than
 * dropped: a malformed allowlist entry admits nobody (see checkSender), and
 * silently hiding it from the audit view would make a broken list look like a
 * short one.
 */
export function maskSender(raw: string): string {
  const digits = String(raw ?? "").replace(/\D+/g, "");
  if (digits.length < 7) return "unparseable";
  return `…${digits.slice(-4)} (${digits.length}d)`;
}
