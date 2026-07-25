// Shared mock types for the Chatwoot visual-review preview.
// Everything here is static/hardcoded data for an owner design walkthrough —
// there is no real Chatwoot, Odoo, or Magnus behind any of it.

export type Channel = "whatsapp" | "web" | "voice";

export type ListStatus = "ai_handling" | "human_active" | "waiting";

export type FilterBucket = "mine" | "unassigned" | "all";

export interface MockConversationSummary {
  id: string;
  contactName: string;
  initials: string;
  channel: Channel;
  lastMessage: string;
  timestamp: string;
  unread: boolean;
  status: ListStatus;
  buckets: FilterBucket[];
}

/**
 * The five AI/human handoff states the state-control-bar can put a
 * conversation into. This is the most important interactive surface in the
 * whole preview — the owner needs to be able to click through each one and
 * see the banner, composer, thread, and "assigned to" chip all react.
 */
export type ConversationState =
  | "ai_handling"
  | "takeover_requested"
  | "human_control"
  | "ai_silent"
  | "returned_to_ai";

export type SenderType = "customer" | "ai" | "human" | "system";

export interface MockMessage {
  id: string;
  sender: SenderType;
  senderName: string;
  text: string;
  timestamp: string;
}

export interface MockOperator {
  id: string;
  name: string;
  initials: string;
}

export interface MockInvoice {
  id: string;
  label: string;
  amount: string;
  state: "paid" | "overdue" | "pending";
  daysOverdue?: number;
}

export interface MockOrderOrAppointment {
  id: string;
  label: string;
  date: string;
  status: string;
}

export interface MockSupportTicket {
  id: string;
  subject: string;
  status: "open" | "pending" | "resolved";
}

export interface MockCallLogEntry {
  id: string;
  direction: "inbound" | "outbound" | "missed";
  label: string;
  timestamp: string;
}

export interface Customer360Data {
  odooCustomerName: string;
  odooCompanyName: string;
  activeProducts: string[];
  invoices: MockInvoice[];
  ordersOrAppointments: MockOrderOrAppointment[];
  supportTickets: MockSupportTicket[];
  assignedNumbers: { number: string; label: string; pbxStatus: "active" | "degraded" | "offline" }[];
  callHistory: MockCallLogEntry[];
  assignedClawithAgent: string;
  onboardingState: string;
}

export interface HermesData {
  summary: string;
  odooFacts: string[];
  suggestedResponse: string;
  recommendedNextAction: string;
  riskAlert: string | null;
  callbackPrepNote: string;
  workflowSuggestion: string;
}

export interface ConversationDetail {
  summary: MockConversationSummary;
  contactPhone: string;
  conversationHistoryCount: number;
  clawithAgent: { name: string; avatarInitials: string };
  operators: MockOperator[];
  defaultOperator: MockOperator;
  labels: string[];
  priority: "Low" | "Medium" | "High";
  lifecycle: "Open" | "Pending" | "Resolved";
  privateNote: { author: string; mention: string; text: string };
  baseThread: MockMessage[];
  stateExtraMessages: Partial<Record<ConversationState, MockMessage[]>>;
  customer360: Customer360Data;
  hermes: HermesData;
}
