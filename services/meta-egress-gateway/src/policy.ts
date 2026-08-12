/**
 * Input validation, path construction and response projection.
 *
 * Every function here fails closed. There is no "unknown but probably fine"
 * branch: an input that does not match a declared field spec is rejected, and a
 * response field that is not in the projection does not leave the process.
 */

import type { FieldSpec, Operation } from './operations.js';

export interface ValidationFailure {
  readonly ok: false;
  /** Safe to return to the caller: names the rule, never echoes the value. */
  readonly reason: string;
}
export interface ValidationSuccess {
  readonly ok: true;
  readonly value: Record<string, string | string[]>;
}
export type ValidationResult = ValidationFailure | ValidationSuccess;

/** Meta object ids are decimal digits. Nothing else is accepted, ever. */
const META_ID_RE = /^[0-9]{5,25}$/;
/** E.164 without the leading plus, as Graph expects it on a send. */
const E164_RE = /^[1-9][0-9]{6,17}$/;

function validateField(name: string, spec: FieldSpec, raw: unknown): { ok: true; value: string | string[] } | ValidationFailure {
  if (raw === undefined || raw === null || raw === '') {
    if ('required' in spec && spec.required) {
      return { ok: false, reason: `field "${name}" is required` };
    }
    return { ok: true, value: '' };
  }

  switch (spec.kind) {
    case 'meta_id': {
      if (typeof raw !== 'string' || !META_ID_RE.test(raw)) {
        return { ok: false, reason: `field "${name}" must be a Meta object id (5-25 digits)` };
      }
      return { ok: true, value: raw };
    }
    case 'e164': {
      if (typeof raw !== 'string' || !E164_RE.test(raw)) {
        return { ok: false, reason: `field "${name}" must be E.164 digits without a leading plus` };
      }
      return { ok: true, value: raw };
    }
    case 'enum': {
      if (typeof raw !== 'string' || !spec.values.includes(raw)) {
        return { ok: false, reason: `field "${name}" is not one of the accepted values` };
      }
      return { ok: true, value: raw };
    }
    case 'short_text': {
      if (typeof raw !== 'string' || raw.length > spec.maxLength) {
        return { ok: false, reason: `field "${name}" must be text of at most ${spec.maxLength} characters` };
      }
      return { ok: true, value: raw };
    }
    case 'text_list': {
      if (!Array.isArray(raw) || raw.length > spec.maxItems) {
        return { ok: false, reason: `field "${name}" must be a list of at most ${spec.maxItems} items` };
      }
      for (const item of raw) {
        if (typeof item !== 'string' || item.length > spec.maxLength) {
          return { ok: false, reason: `field "${name}" items must be text of at most ${spec.maxLength} characters` };
        }
      }
      return { ok: true, value: raw as string[] };
    }
    default: {
      // An unmodelled field kind is a programming error, and it fails closed.
      return { ok: false, reason: `field "${name}" has an unsupported specification` };
    }
  }
}

/**
 * Validate a caller body against an operation's declared input.
 *
 * UNKNOWN KEYS ARE A REJECTION. This is what stops a caller smuggling
 * `access_token`, `fields`, `url` or a header-shaped key into a request: there
 * is no permissive path for a key the operation did not declare.
 */
export function validateInput(op: Operation, body: unknown): ValidationResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'body must be a JSON object' };
  }
  const input = body as Record<string, unknown>;
  const declared = Object.keys(op.input);

  for (const key of Object.keys(input)) {
    if (!declared.includes(key)) {
      return { ok: false, reason: `field "${key}" is not accepted by operation ${op.id}` };
    }
  }

  const out: Record<string, string | string[]> = {};
  for (const [name, spec] of Object.entries(op.input)) {
    const r = validateField(name, spec, input[name]);
    if (!r.ok) return r;
    if (r.value !== '') out[name] = r.value;
  }
  return { ok: true, value: out };
}

/**
 * Fill an operation's path template from validated input.
 *
 * The result is checked structurally afterwards: a filled path must contain no
 * scheme, no authority, no query, no fragment and no dot segment. Validation
 * already restricts the values to digits, so this is belt and braces — but the
 * whole point of this service is that the destination cannot be argued about.
 */
export function buildPath(op: Operation, input: Record<string, string | string[]>): { ok: true; path: string } | ValidationFailure {
  let path = op.pathTemplate;
  const placeholders = op.pathTemplate.match(/\{[a-z_]+\}/g) ?? [];

  for (const ph of placeholders) {
    const name = ph.slice(1, -1);
    const v = input[name];
    if (typeof v !== 'string' || v === '') {
      return { ok: false, reason: `path parameter "${name}" is missing` };
    }
    // The VALUE is checked before substitution, not only the assembled path.
    // `1/accounts` assembles into a structurally valid path that reaches a
    // different endpoint, and a caller-supplied value must never be able to add
    // a segment. validateInput() already restricts these to digits; this does
    // not rely on it having run.
    if (!/^[A-Za-z0-9_.-]+$/.test(v) || v.includes('..')) {
      return { ok: false, reason: `path parameter "${name}" contains characters that are not permitted` };
    }
    path = path.replace(ph, v);
  }

  if (/\{|\}/.test(path)) return { ok: false, reason: 'path template was not fully resolved' };
  if (!path.startsWith('/')) return { ok: false, reason: 'path must be absolute' };
  if (path.includes('://') || path.includes('?') || path.includes('#') || path.includes('..') || path.includes('//')) {
    return { ok: false, reason: 'path failed its structural check' };
  }
  if (!/^[/A-Za-z0-9_.-]+$/.test(path)) {
    return { ok: false, reason: 'path contains characters that are not permitted' };
  }
  return { ok: true, path };
}

/**
 * Project an upstream response down to the declared field set.
 *
 * Allowlist, not denylist. A field Meta returns that is not named in the
 * operation's projection does not appear in the output — so a credential
 * arriving in an unexpected field is dropped rather than forwarded, which is the
 * response-side half of the credential-custody guarantee.
 */
export function project(value: unknown, projection: readonly string[]): unknown {
  const out: Record<string, unknown> = {};
  for (const path of projection) {
    assign(out, path.split('.'), value);
  }
  return prune(out);
}

function assign(target: Record<string, unknown>, segments: string[], source: unknown): void {
  if (source === null || source === undefined) return;
  const head = segments[0];
  if (head === undefined) return;
  const rest = segments.slice(1);

  if (head.endsWith('[]')) {
    const key = head.slice(0, -2);
    const arr = (source as Record<string, unknown>)[key];
    if (!Array.isArray(arr)) return;
    const existing = Array.isArray(target[key]) ? (target[key] as unknown[]) : [];
    target[key] = existing;
    arr.forEach((item, i) => {
      if (rest.length === 0) {
        // A projected array of scalars.
        existing[i] = item;
        return;
      }
      const slot = existing[i];
      const child: Record<string, unknown> =
        slot !== null && typeof slot === 'object' && !Array.isArray(slot) ? (slot as Record<string, unknown>) : {};
      existing[i] = child;
      assign(child, rest, item);
    });
    return;
  }

  if (rest.length === 0) {
    const v = (source as Record<string, unknown>)[head];
    if (v !== undefined) target[head] = v;
    return;
  }

  const next = (source as Record<string, unknown>)[head];
  if (next === null || next === undefined || typeof next !== 'object') return;
  const child = (target[head] as Record<string, unknown>) ?? {};
  target[head] = child;
  assign(child, rest, next);
}

/** Drop empty objects left behind by a projection path the response did not have. */
function prune(v: unknown): unknown {
  if (Array.isArray(v)) {
    const arr = v.map(prune).filter((x) => x !== undefined);
    return arr;
  }
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(obj)) {
      const p = prune(val);
      if (p !== undefined) out[k] = p;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }
  return v;
}
