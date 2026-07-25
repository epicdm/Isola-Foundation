// Hardcoded mock content for the owner visual-review preview only.
// Nothing in this file is read from a database or a real adapter call —
// see CLAUDE.md "owner visual review" packet: this route group is a
// design/UX preview, not a functional integration.
import type { Readiness } from '@/lib/foh/catalog';

export const TENANT = {
  name: 'Riverside Family Dental',
  industry: 'Dental / Healthcare',
  hours: 'Mon–Fri 8:00 AM–5:00 PM, Sat 9:00 AM–1:00 PM',
  address: '14 Victoria Street, Roseau, Dominica',
  timezone: 'America/Dominica',
  phone: '+1 767 555 0142',
};

export type AgentStatus = 'Live' | 'Assisted' | 'Planned';

export interface MockAgent {
  id: string;
  name: string;
  role: string;
  status: AgentStatus;
  channels: string[];
  greeting: string;
  business_info: string;
  knowledge_text: string;
  intelligence_tier: 'standard' | 'advanced' | 'expert';
  after_hours_start: string;
  after_hours_end: string;
  timezone: string;
}

export const AGENTS: MockAgent[] = [
  {
    id: 'front-desk',
    name: 'Riverside Front Desk',
    role: 'Front Desk Receptionist',
    status: 'Live',
    channels: ['WhatsApp'],
    greeting: "Hi! You've reached Riverside Family Dental — how can I help you today?",
    business_info:
      'General and family dentistry in Roseau. We book cleanings, fillings, and emergency visits. Walk-ins accepted for emergencies only.',
    knowledge_text:
      'Cleanings: EC$120. Emergency callout after hours: EC$200. Insurance: we accept most local plans, ask patient to bring their card.',
    intelligence_tier: 'advanced',
    after_hours_start: '17:00',
    after_hours_end: '08:00',
    timezone: 'America/Dominica',
  },
  {
    id: 'support',
    name: 'Riverside Support Assistant',
    role: 'Support Agent',
    status: 'Assisted',
    channels: ['WhatsApp'],
    greeting: 'Hello, this is Riverside support — tell me what you need and I’ll help or find someone who can.',
    business_info:
      'Handles appointment changes, billing questions, and directs anything clinical to a human hygienist or Dr. Alexis.',
    knowledge_text:
      'Reschedule policy: 24 hours notice, otherwise EC$25 fee. Billing disputes always escalate to a human.',
    intelligence_tier: 'standard',
    after_hours_start: '18:00',
    after_hours_end: '08:00',
    timezone: 'America/Dominica',
  },
  {
    id: 'sales',
    name: 'Riverside New-Patient Qualifier',
    role: 'Sales Qualifier',
    status: 'Planned',
    channels: [],
    greeting: 'Hi! Looking to become a new patient at Riverside Family Dental?',
    business_info: 'Qualifies new-patient inquiries and books a first consultation slot.',
    knowledge_text: 'New patient exam + x-rays: EC$180. First-time patient discount: 10% in your first month.',
    intelligence_tier: 'standard',
    after_hours_start: '',
    after_hours_end: '',
    timezone: 'America/Dominica',
  },
];

export const AGENT_TEMPLATES = [
  {
    id: 'front-desk',
    name: 'Front Desk Receptionist',
    blurb: 'Greets customers, answers hours/location/pricing questions, and books appointments.',
    bestFor: 'Clinics, salons, repair shops — anyone with a physical location and a schedule.',
  },
  {
    id: 'support',
    name: 'Support Agent',
    blurb: 'Handles existing-customer questions: order status, billing, reschedules — escalates the rest.',
    bestFor: 'Businesses with an existing customer base needing day-to-day help.',
  },
  {
    id: 'sales',
    name: 'Sales Qualifier',
    blurb: 'Engages new inquiries, asks qualifying questions, and books a consultation or handoff.',
    bestFor: 'Businesses that want to grow their customer base from inbound interest.',
  },
];

export interface MockChannel {
  id: string;
  name: string;
  kind: string;
  status: Readiness;
  detail: string;
}

export const CHANNELS: MockChannel[] = [
  {
    id: 'whatsapp',
    name: '+1 767 555 0142',
    kind: 'WhatsApp Business',
    status: 'Live',
    detail: 'Connected via Meta Embedded Signup · assigned to Front Desk + Support agents',
  },
  {
    id: 'voice',
    name: 'SIP Voice Line',
    kind: 'Voice / PBX',
    status: 'Live',
    detail: 'Softphone via QR pairing · missed-call routing to Front Desk agent',
  },
  {
    id: 'webchat',
    name: 'Website chat widget',
    kind: 'Web Chat',
    status: 'Conditional',
    detail: 'Available once a verified domain is registered — not yet configured for this tenant',
  },
  {
    id: 'email',
    name: 'Support inbox email',
    kind: 'Email',
    status: 'Planned',
    detail: 'Not yet available for any tenant',
  },
  {
    id: 'telegram',
    name: 'Telegram bot',
    kind: 'Telegram',
    status: 'Planned',
    detail: 'Not yet available for any tenant',
  },
];

export interface MockIntegration {
  id: string;
  name: string;
  desc: string;
  status: 'Connected' | 'Not connected';
  lastSynced: string;
}

export const INTEGRATIONS: MockIntegration[] = [
  {
    id: 'chatwoot',
    name: 'Chatwoot',
    desc: 'Conversations, human takeover, and dedup for every channel.',
    status: 'Connected',
    lastSynced: '2 minutes ago',
  },
  {
    id: 'odoo',
    name: 'Odoo',
    desc: 'Invoices, customers, and work orders — the commercial system of record.',
    status: 'Connected',
    lastSynced: '18 minutes ago',
  },
  {
    id: 'magnus',
    name: 'Magnus / PBX',
    desc: 'Voice, DIDs, call rating, and CDR authority.',
    status: 'Connected',
    lastSynced: '1 minute ago',
  },
  {
    id: 'meta',
    name: 'Meta WABA',
    desc: 'WhatsApp Business Account, phone number, and webhook ownership.',
    status: 'Connected',
    lastSynced: '5 minutes ago',
  },
];

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: 'Owner' | 'Manager' | 'Agent';
}

export const TEAM: TeamMember[] = [
  { id: '1', name: 'Jordan Reyes', email: 'jordan@riversidefamilydental.com', role: 'Owner' },
  { id: '2', name: 'Alexis Bertrand, DDS', email: 'alexis@riversidefamilydental.com', role: 'Manager' },
  { id: '3', name: 'Marisol Prince', email: 'marisol@riversidefamilydental.com', role: 'Agent' },
  { id: '4', name: 'Kevon St. Jean', email: 'kevon@riversidefamilydental.com', role: 'Agent' },
];

export interface ActivityItem {
  id: string;
  ts: string;
  text: string;
}

export const ACTIVITY: ActivityItem[] = [
  { id: '1', ts: '2 min ago', text: 'Agent replied to +1 767 555 0198 about appointment availability.' },
  { id: '2', ts: '17 min ago', text: 'Payment received — EC$249.00 monthly plan renewal.' },
  { id: '3', ts: '41 min ago', text: 'Human took over conversation #42 from Marisol Prince.' },
  { id: '4', ts: '1 hr ago', text: 'Missed call from +1 767 555 0176 — routed to voicemail.' },
  { id: '5', ts: '2 hr ago', text: 'Agent booked a new appointment for Thursday 10:00 AM.' },
  { id: '6', ts: 'Yesterday', text: 'Support request #18 marked resolved by Kevon St. Jean.' },
  { id: '7', ts: 'Yesterday', text: 'Wallet topped up EC$100.00 by Jordan Reyes.' },
];

export interface SupportRequest {
  id: string;
  subject: string;
  status: 'Open' | 'In progress' | 'Resolved';
  created: string;
  destination: { channel: 'chatwoot' };
}

export const SUPPORT_REQUESTS: SupportRequest[] = [
  { id: 'SR-104', subject: 'Add a second WhatsApp number for the Portsmouth branch', status: 'Open', created: '3 hours ago', destination: { channel: 'chatwoot' } },
  { id: 'SR-101', subject: 'Update after-hours message wording', status: 'In progress', created: 'Yesterday', destination: { channel: 'chatwoot' } },
  { id: 'SR-096', subject: 'Question about EC$0.27/min voice billing', status: 'Resolved', created: '4 days ago', destination: { channel: 'chatwoot' } },
];

export const KPIS = {
  openConversations: 7,
  missedCallsToday: 2,
  walletBalance: 184.5,
  planUsagePct: 62,
  aiHandledToday: 23,
  awaitingHuman: 3,
};
