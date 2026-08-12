/**
 * THE ALLOWLIST.
 *
 * This file is the security surface of the gateway. A Meta operation exists if
 * and only if it appears here, and it can do exactly what its entry says.
 *
 * There is deliberately NO generic Graph proxy and no way to express one. A
 * caller supplies an operation id and a body matching that operation's schema.
 * The method, the path template, the API version, the query parameters and the
 * set of response fields that may leave this process are all fixed HERE, in
 * code, and none of them can be influenced by the caller.
 *
 * Adding an operation is a reviewed change to this file. That is the point:
 * "which endpoint may we call" stops being a parsing problem and becomes an
 * API surface with a diff.
 */

/** A parameter the caller may supply, and the only shapes it may take. */
export type FieldSpec =
  | { kind: 'meta_id'; required: true }
  | { kind: 'e164'; required: true }
  | { kind: 'enum'; required: boolean; values: readonly string[] }
  | { kind: 'short_text'; required: boolean; maxLength: number }
  | { kind: 'text_list'; required: boolean; maxItems: number; maxLength: number };

export type OperationClass =
  | 'metadata_read'
  | 'content_read'
  | 'customer_visible_mutation'
  | 'configuration_mutation';

export interface Operation {
  /** Stable, caller-facing identifier. Never a URL. */
  readonly id: string;
  readonly class: OperationClass;
  /** Fixed. The caller cannot influence the method in any way. */
  readonly method: 'GET' | 'POST';
  /**
   * Server-side path template. `{name}` segments are filled ONLY from validated
   * input fields. A template can never introduce a host, a scheme, a query
   * string or a `..` segment — buildPath() rejects anything a filled value
   * would change structurally.
   */
  readonly pathTemplate: string;
  /** Fixed query parameters. Callers cannot add, remove or alter query keys. */
  readonly query?: Readonly<Record<string, string>>;
  /** Accepted input fields. Anything else in the body is a rejection, not a warning. */
  readonly input: Readonly<Record<string, FieldSpec>>;
  /**
   * The ONLY response paths that may leave this process. Dot notation, `[]` for
   * "every element of this array". A field Meta returns that is not listed here
   * is dropped before the response is serialised — including one that arrives in
   * a field this gateway has never heard of.
   */
  readonly projection: readonly string[];
  /** Which asset field in the input carries the tenant-scoped asset. */
  readonly scopeField: string;
  /** Asset kind the scope check must match. */
  readonly scopeKind: 'waba' | 'phone_number' | 'token';
  readonly requiresApproval: boolean;
  /** Requests per minute, per tenant. */
  readonly rateLimitPerMinute: number;
  /** Upstream timeout. */
  readonly timeoutMs: number;
  /** Maximum accepted upstream body size, in bytes, before projection. */
  readonly maxResponseBytes: number;
}

/**
 * Phase 1 — bounded metadata reads only, per the migration order.
 *
 * Message, media and configuration operations are added in later phases, each
 * with its own acceptance. They are absent rather than disabled: an operation
 * that does not exist cannot be enabled by a configuration mistake.
 */
export const OPERATIONS: readonly Operation[] = [
  {
    id: 'wa.webhook_ownership.read',
    class: 'metadata_read',
    method: 'GET',
    pathTemplate: '/{waba_id}/subscribed_apps',
    input: { waba_id: { kind: 'meta_id', required: true } },
    projection: [
      'data[].whatsapp_business_api_data.id',
      'data[].whatsapp_business_api_data.name',
      'data[].whatsapp_business_api_data.link',
    ],
    scopeField: 'waba_id',
    scopeKind: 'waba',
    requiresApproval: false,
    rateLimitPerMinute: 30,
    timeoutMs: 10_000,
    maxResponseBytes: 256 * 1024,
  },
  {
    id: 'wa.phone_numbers.list',
    class: 'metadata_read',
    method: 'GET',
    pathTemplate: '/{waba_id}/phone_numbers',
    query: { fields: 'id,display_phone_number,verified_name,quality_rating,platform_type' },
    input: { waba_id: { kind: 'meta_id', required: true } },
    projection: [
      'data[].id',
      'data[].display_phone_number',
      'data[].verified_name',
      'data[].quality_rating',
      'data[].platform_type',
    ],
    scopeField: 'waba_id',
    scopeKind: 'waba',
    requiresApproval: false,
    rateLimitPerMinute: 30,
    timeoutMs: 10_000,
    maxResponseBytes: 256 * 1024,
  },
  {
    id: 'wa.phone.metadata.read',
    class: 'metadata_read',
    method: 'GET',
    pathTemplate: '/{phone_number_id}',
    query: {
      fields:
        'id,display_phone_number,verified_name,quality_rating,platform_type,code_verification_status',
    },
    input: { phone_number_id: { kind: 'meta_id', required: true } },
    projection: [
      'id',
      'display_phone_number',
      'verified_name',
      'quality_rating',
      'platform_type',
      'code_verification_status',
    ],
    scopeField: 'phone_number_id',
    scopeKind: 'phone_number',
    requiresApproval: false,
    rateLimitPerMinute: 60,
    timeoutMs: 10_000,
    maxResponseBytes: 64 * 1024,
  },
  {
    id: 'wa.phone.webhook_config.read',
    class: 'metadata_read',
    method: 'GET',
    pathTemplate: '/{phone_number_id}',
    query: { fields: 'id,webhook_configuration' },
    input: { phone_number_id: { kind: 'meta_id', required: true } },
    // Callback URLs are operational configuration, not credentials. The verify
    // token is NOT projected and Meta does not return it here; if a future API
    // version ever did, this allowlist would drop it.
    //
    // `whatsapp_business_account` is the PHONE-LEVEL override and is the field
    // that actually decides which processor receives this number's inbound
    // events. An earlier version of this projection declared only `application`
    // and silently dropped it — which would have meant verifying a cutover while
    // blind to the one value the cutover changes. Both are required.
    projection: [
      'id',
      'webhook_configuration.application',
      'webhook_configuration.whatsapp_business_account',
    ],
    scopeField: 'phone_number_id',
    scopeKind: 'phone_number',
    requiresApproval: false,
    rateLimitPerMinute: 60,
    timeoutMs: 10_000,
    maxResponseBytes: 64 * 1024,
  },
];

const BY_ID = new Map(OPERATIONS.map((o) => [o.id, o]));

export function findOperation(id: string): Operation | null {
  if (typeof id !== 'string') return null;
  return BY_ID.get(id) ?? null;
}

export function operationIds(): string[] {
  return OPERATIONS.map((o) => o.id);
}
