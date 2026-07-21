// Typed bridge over the ACCEPTED contract (source of truth: contracts/analytics-schema.json).
// Required properties are DERIVED from the schema at module load — not re-typed here.
import schema from '../../contracts/analytics-schema.json';

type SchemaEvent = { name: string; required?: string[] };
const EVENTS: SchemaEvent[] = (schema as { events: SchemaEvent[] }).events;
const REQUIRED: Record<string, string[]> = Object.fromEntries(EVENTS.map((e) => [e.name, e.required ?? []]));
export const EVENT_NAMES = EVENTS.map((e) => e.name);

const session = 'sess_' + Math.random().toString(36).slice(2, 9);

export function emit(name: string, props: Record<string, unknown> = {}) {
  const req = REQUIRED[name];
  if (!req) { console.warn('[analytics] unknown event', name); return { ok: false as const, error: 'UNKNOWN_EVENT' }; }
  const missing = req.filter((k) => props[k] == null || props[k] === '');
  if (missing.length) { console.warn('[analytics] missing', name, missing); return { ok: false as const, error: 'MISSING:' + missing.join(',') }; }
  const evt = { session, timestamp: new Date().toISOString(), ...props, name };
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('foh:analytics', { detail: evt }));
  return { ok: true as const, event: evt };
}
