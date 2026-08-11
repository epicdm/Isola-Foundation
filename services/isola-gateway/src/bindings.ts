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
  status: BindingStatus;
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
  | { kind: "not_public"; tenantId: string; exposure: Exposure };

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
 * Exposure is checked before status on purpose: a retired INTERNAL binding is
 * reported as `not_public`, because that is the alarming half.
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
  if (binding.exposure !== "PUBLIC") {
    return { kind: "not_public", tenantId: binding.tenantId, exposure: binding.exposure };
  }
  if (binding.status !== "active") {
    return { kind: "retired", tenantId: binding.tenantId };
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
    const labels = optionalLabels(entry, index, errors);

    const exposureRaw = entry["exposure"];
    // The single hardest rule in this file. Anything other than the literal
    // string "PUBLIC" is refused at boot, so an INTERNAL employee can never be
    // wired to a publicly reachable inbox by configuration alone.
    if (exposureRaw !== "PUBLIC") {
      errors.push(
        `binding[${index}]: "exposure" must be exactly "PUBLIC" — this gateway is publicly reachable and must never serve an INTERNAL employee`,
      );
    }

    const statusRaw = entry["status"];
    if (statusRaw !== "active" && statusRaw !== "retired") {
      errors.push(`binding[${index}]: "status" must be "active" or "retired"`);
    }

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
      exposureRaw !== "PUBLIC" ||
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
      exposure: "PUBLIC",
      status: statusRaw,
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
    escalationTeamId: binding.escalationTeamId ?? null,
    labels: binding.labels ?? [],
    // Presence, never the value.
    agentBotSecret: "[redacted]",
    agentBotAccessToken: "[redacted]",
    agentBotSecretConfigured: binding.agentBotSecret.length > 0,
    agentBotAccessTokenConfigured: binding.agentBotAccessToken.length > 0,
  };
}
