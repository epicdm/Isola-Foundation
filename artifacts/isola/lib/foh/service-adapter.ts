// Typed bridge over the ACCEPTED mock adapter (source of truth: contracts/service-adapter.js).
// Correct relative path from lib/foh -> ../../contracts. Uses the module's .IsolaServices
// export (do NOT cast the module object itself to the service interface).
import AdapterModule from '../../contracts/service-adapter.js';

export interface AdapterResult<T = Record<string, unknown>> {
  status: 'success' | 'pending' | 'assisted' | 'error';
  ok?: boolean; data?: T; code?: string; message?: string; recovery?: string; stage?: string; correlationId?: string;
}
export interface IntentPayload {
  cta: string; offer?: string | null; service?: string | null; assistant?: string | null;
  customerType: string; existingEpic?: boolean; campaign?: string | null; referral?: string | null;
  source?: string; consent: boolean; contact: string; idempotencyKey?: string; _scenario?: string;
}
export interface Services {
  configure: (o: Record<string, unknown>) => void;
  createIntent: (p: IntentPayload) => Promise<AdapterResult<{ intentId: string; duplicate?: boolean; stage?: string }>>;
  qualify: (p: Record<string, unknown>) => Promise<AdapterResult>;
  recommend: (p: Record<string, unknown>) => Promise<AdapterResult>;
  requestProposal: (p: Record<string, unknown>) => Promise<AdapterResult>;
  resumeJourney: (p: { intentId: string }) => Promise<AdapterResult<{ resumeUrl?: string }>>;
  supportRequest: (p: Record<string, unknown>) => Promise<AdapterResult>;
  activateService: (p: Record<string, unknown>) => Promise<AdapterResult>;
  activateAssistant: (p: Record<string, unknown>) => Promise<AdapterResult>;
}

// The contract exposes .IsolaServices (browser: window.IsolaServices; node: module.exports.IsolaServices).
// Guard the module value first so a future interop failure is a controlled error, not
// "Cannot read properties of undefined (reading 'IsolaServices')".
if (!AdapterModule) {
  throw new Error('service-adapter contract did not expose a module value');
}
const mod = AdapterModule as unknown as { IsolaServices?: Services } & Partial<Services>;
const resolved: Services = (mod.IsolaServices ?? (mod as unknown as Services));

export const REQUIRED_METHODS = [
  'configure','createIntent','qualify','recommend','requestProposal','resumeJourney','supportRequest','activateService','activateAssistant',
] as const;

// Fail fast if the bridge is wired wrong (e.g. module object cast instead of .IsolaServices).
export function assertAdapter(s: Partial<Services> = resolved): asserts s is Services {
  const missing = REQUIRED_METHODS.filter((m) => typeof (s as Record<string, unknown>)[m] !== 'function');
  if (missing.length) throw new Error('service-adapter bridge missing methods: ' + missing.join(', '));
}
assertAdapter(resolved);
export const IsolaServices: Services = resolved;
