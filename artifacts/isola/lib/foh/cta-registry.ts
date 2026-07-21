// Typed bridge over the ACCEPTED contract (source of truth: contracts/cta-registry.js).
// We do NOT re-declare the CTA data here — we import it and derive types, so there is
// exactly one source of truth. Contract-drift tests guard the shape.
import Registry from '../../contracts/cta-registry.js';

export type CustomerType = 'business' | 'personal' | 'existing_epic';
export type ServiceId = 'business_line' | 'hosted_pbx' | 'connect_pbx' | 'personal_line' | null;
export type AssistantId =
  | 'business_receptionist' | 'sales_assistant' | 'support_assistant'
  | 'booking_assistant' | 'account_assistant' | 'epic_assistant' | null;

export interface CtaContract {
  id: string; label: string; sourcePage: string;
  offer: string | null; service: ServiceId; assistant: AssistantId;
  customerType: CustomerType; existingEpic: boolean;
  campaign: string | null; referral: string | null; sourceChannel: string;
  consentRequired: boolean; destination: string;
  frontendCalls: string[]; journeyCalls: string[]; provisioningCalls: string[];
  expectedAdapterCalls: string[]; analytics: string[]; owner: string;
}

const api = Registry as unknown as { CTAS: CtaContract[]; byId: (id: string) => CtaContract | null };
export const CTAS: CtaContract[] = api.CTAS;
export const byId = (id: string): CtaContract | null => api.byId(id);
