import type {
  ConversationDetail,
  ConversationState,
  MockConversationSummary,
  MockMessage,
  MockOperator,
} from "./types";

// -----------------------------------------------------------------------
// Mock tenant + conversation list — a small dental-practice business using
// Isola/Clawith/Chatwoot. All names, numbers, invoices, and history below
// are invented for this owner visual-review packet only.
// -----------------------------------------------------------------------

export const TENANT_NAME = "Riverside Family Dental";

export const CONVERSATIONS: MockConversationSummary[] = [
  {
    id: "conv-1",
    contactName: "Maria Gomez",
    initials: "MG",
    channel: "whatsapp",
    lastMessage: "Hi, can you tell me if my invoice #348 was paid?",
    timestamp: "2 min ago",
    unread: true,
    status: "ai_handling",
    buckets: ["mine", "all"],
  },
  {
    id: "conv-2",
    contactName: "James Okafor",
    initials: "JO",
    channel: "whatsapp",
    lastMessage: "Need to reschedule my cleaning appointment to next week",
    timestamp: "11 min ago",
    unread: false,
    status: "human_active",
    buckets: ["mine", "all"],
  },
  {
    id: "conv-3",
    contactName: "Unknown Caller",
    initials: "UC",
    channel: "voice",
    lastMessage: "Missed call — voicemail left about a billing question",
    timestamp: "24 min ago",
    unread: true,
    status: "waiting",
    buckets: ["unassigned", "all"],
  },
  {
    id: "conv-4",
    contactName: "Sarah Bianchi",
    initials: "SB",
    channel: "web",
    lastMessage: "Do you accept new patients right now?",
    timestamp: "38 min ago",
    unread: false,
    status: "ai_handling",
    buckets: ["all"],
  },
  {
    id: "conv-5",
    contactName: "David Chen",
    initials: "DC",
    channel: "whatsapp",
    lastMessage: "Following up on my insurance claim from last month",
    timestamp: "1 hr ago",
    unread: true,
    status: "human_active",
    buckets: ["mine", "all"],
  },
  {
    id: "conv-6",
    contactName: "Front Desk Line",
    initials: "FD",
    channel: "voice",
    lastMessage: "Appointment confirmation call — Friday 2:00 PM",
    timestamp: "2 hr ago",
    unread: false,
    status: "waiting",
    buckets: ["unassigned", "all"],
  },
  {
    id: "conv-7",
    contactName: "Lucia Fernandez",
    initials: "LF",
    channel: "web",
    lastMessage: "Question about the payment plan for my filling",
    timestamp: "3 hr ago",
    unread: false,
    status: "ai_handling",
    buckets: ["all"],
  },
  {
    id: "conv-8",
    contactName: "Tom Walsh",
    initials: "TW",
    channel: "whatsapp",
    lastMessage: "Is Dr. Patel available this Friday afternoon?",
    timestamp: "5 hr ago",
    unread: true,
    status: "waiting",
    buckets: ["unassigned", "all"],
  },
];

export function getConversationSummary(id: string): MockConversationSummary {
  return CONVERSATIONS.find((c) => c.id === id) ?? CONVERSATIONS[0];
}

export const OPERATORS: MockOperator[] = [
  { id: "op-priya", name: "Priya Nair", initials: "PN" },
  { id: "op-marcus", name: "Marcus Lee", initials: "ML" },
  { id: "op-dana", name: "Dana Whitfield", initials: "DW" },
];

const CLAWITH_AGENT = { name: "Front Desk AI — Riverside", avatarInitials: "CW" };

// -----------------------------------------------------------------------
// Hand-authored detail for the featured conversation (Maria Gomez / invoice
// #348), used as the primary walkthrough example. Every other conversation
// gets a generated-but-consistent detail via buildGenericDetail below.
// -----------------------------------------------------------------------

const MARIA_BASE_THREAD: MockMessage[] = [
  {
    id: "m-1",
    sender: "customer",
    senderName: "Maria Gomez",
    text: "Hi! Quick question — can you tell me if my invoice #348 was paid? I thought I paid it online last week.",
    timestamp: "10:02 AM",
  },
  {
    id: "m-2",
    sender: "ai",
    senderName: "Clawith AI",
    text: "Hi Maria, thanks for reaching out! Let me check that for you — one moment.",
    timestamp: "10:02 AM",
  },
  {
    id: "m-3",
    sender: "ai",
    senderName: "Clawith AI",
    text: "I can see invoice #348 for $210.00 on file, and it's currently showing as not paid. Would you like me to send you a payment link, or connect you with our front desk to double check?",
    timestamp: "10:03 AM",
  },
  {
    id: "m-4",
    sender: "customer",
    senderName: "Maria Gomez",
    text: "Hmm, that's strange, I really thought I paid that. Can someone actually look into it please?",
    timestamp: "10:05 AM",
  },
];

const MARIA_DETAIL: ConversationDetail = {
  summary: getConversationSummary("conv-1"),
  contactPhone: "+1 (555) 214-7788",
  conversationHistoryCount: 6,
  clawithAgent: CLAWITH_AGENT,
  operators: OPERATORS,
  defaultOperator: OPERATORS[0],
  labels: ["billing", "urgent"],
  priority: "Medium",
  lifecycle: "Open",
  privateNote: {
    author: "Priya Nair",
    mention: "@Marcus",
    text: "@Marcus can you double check the Stripe webhook for invoice #348? Maria says she paid but Odoo still shows not_paid — might be the same lag we saw last month.",
  },
  baseThread: MARIA_BASE_THREAD,
  stateExtraMessages: {
    human_control: [
      {
        id: "m-human-1",
        sender: "human",
        senderName: "Priya Nair",
        text: "Hi Maria, this is Priya from Riverside Family Dental. I'm pulling up your account now — give me just a moment.",
        timestamp: "Just now",
      },
    ],
    ai_silent: [
      {
        id: "m-human-2",
        sender: "human",
        senderName: "Priya Nair",
        text: "Thanks for your patience — I can confirm invoice #348 has not cleared on our end. I'll send a fresh payment link and flag the earlier attempt for reconciliation.",
        timestamp: "Just now",
      },
    ],
    returned_to_ai: [
      {
        id: "m-return-1",
        sender: "ai",
        senderName: "Clawith AI",
        text: "Thanks Priya! Maria, I'm back — a new payment link for invoice #348 has been sent to your WhatsApp. Anything else I can help with?",
        timestamp: "Just now",
      },
    ],
  },
  customer360: {
    odooCustomerName: "Maria Gomez",
    odooCompanyName: "Riverside Family Dental",
    activeProducts: ["Family Dental Care Plan", "SMS Appointment Reminders Add-on"],
    invoices: [
      { id: "inv-348", label: "Invoice #348 — Cleaning + X-ray", amount: "$210.00", state: "overdue", daysOverdue: 12 },
      { id: "inv-331", label: "Invoice #331 — Filling (2 surfaces)", amount: "$340.00", state: "paid" },
      { id: "inv-298", label: "Invoice #298 — Annual checkup", amount: "$150.00", state: "paid" },
    ],
    ordersOrAppointments: [
      { id: "appt-1", label: "Routine cleaning", date: "Aug 2, 2026 · 9:00 AM", status: "Confirmed" },
      { id: "appt-2", label: "Filling follow-up", date: "Jun 14, 2026", status: "Completed" },
    ],
    supportTickets: [{ id: "tix-221", subject: "Insurance claim delay — Delta Dental", status: "open" }],
    assignedNumbers: [{ number: "+1 (555) 010-3742", label: "Front Desk (main line)", pbxStatus: "active" }],
    callHistory: [
      { id: "call-1", direction: "missed", label: "Missed call from Maria Gomez", timestamp: "3 days ago" },
      { id: "call-2", direction: "inbound", label: "Inbound — 4m 12s — appointment confirmation", timestamp: "1 week ago" },
    ],
    assignedClawithAgent: CLAWITH_AGENT.name,
    onboardingState: "Onboarded — accepted Mar 10, 2026",
  },
  hermes: {
    summary:
      "Maria is asking about invoice #348, which she believes she already paid. Odoo shows it as unpaid and 12 days overdue. This is the second time this month a customer has reported a payment mismatch.",
    odooFacts: [
      "Invoice #348 is 12 days overdue ($210.00).",
      "Last payment on file for Maria Gomez was invoice #331, paid in full.",
      "No Stripe webhook event recorded for invoice #348 in the last 14 days.",
    ],
    suggestedResponse:
      "Hi Maria — thanks for flagging this. I don't see a completed payment for invoice #348 on our end yet, so nothing has gone through. I'll send you a fresh secure payment link now, and I'm also flagging the earlier attempt so our billing system can be double-checked in case it was a delay on our side.",
    recommendedNextAction: "Send a new payment link and open a billing-reconciliation note for invoice #348.",
    riskAlert: "Invoice #348 is 12 days overdue — second reported payment mismatch this month.",
    callbackPrepNote: "If Maria asks for a callback, mention her prior visit (filling, Jun 14) and confirm the correct card on file before retrying payment.",
    workflowSuggestion: "Consider the \"Billing Reconciliation Check\" workflow to compare Stripe + Odoo invoice state before replying further.",
  },
};

function buildGenericDetail(summary: MockConversationSummary): ConversationDetail {
  const operator = OPERATORS[(summary.id.charCodeAt(summary.id.length - 1) + 1) % OPERATORS.length];
  const firstName = summary.contactName.split(" ")[0];
  const invoiceNumber = 300 + (summary.id.charCodeAt(summary.id.length - 1) % 90);

  const baseThread: MockMessage[] = [
    {
      id: `${summary.id}-m1`,
      sender: "customer",
      senderName: summary.contactName,
      text: summary.lastMessage,
      timestamp: summary.timestamp,
    },
    {
      id: `${summary.id}-m2`,
      sender: "ai",
      senderName: "Clawith AI",
      text: `Hi ${firstName}, thanks for reaching out to ${TENANT_NAME}! Let me take a look at that for you.`,
      timestamp: summary.timestamp,
    },
    {
      id: `${summary.id}-m3`,
      sender: "ai",
      senderName: "Clawith AI",
      text: "I've noted the details — someone from our team will confirm shortly if I can't resolve it directly.",
      timestamp: "Just now",
    },
  ];

  return {
    summary,
    contactPhone: "+1 (555) 019-2244",
    conversationHistoryCount: 2,
    clawithAgent: CLAWITH_AGENT,
    operators: OPERATORS,
    defaultOperator: operator,
    labels: summary.channel === "voice" ? ["voice", "follow-up"] : ["general"],
    priority: summary.unread ? "High" : "Low",
    lifecycle: summary.status === "waiting" ? "Pending" : "Open",
    privateNote: {
      author: operator.name,
      mention: `@${OPERATORS[(OPERATORS.indexOf(operator) + 1) % OPERATORS.length].name.split(" ")[0]}`,
      text: `@${OPERATORS[(OPERATORS.indexOf(operator) + 1) % OPERATORS.length].name.split(" ")[0]} can you take the next reply on this one? Nothing urgent, just want a second set of eyes.`,
    },
    baseThread,
    stateExtraMessages: {
      human_control: [
        {
          id: `${summary.id}-human-1`,
          sender: "human",
          senderName: operator.name,
          text: `Hi ${firstName}, this is ${operator.name.split(" ")[0]} from ${TENANT_NAME} — happy to help directly.`,
          timestamp: "Just now",
        },
      ],
      returned_to_ai: [
        {
          id: `${summary.id}-return-1`,
          sender: "ai",
          senderName: "Clawith AI",
          text: `Thanks ${operator.name.split(" ")[0]}! ${firstName}, I'm back — let me know if anything else comes up.`,
          timestamp: "Just now",
        },
      ],
    },
    customer360: {
      odooCustomerName: summary.contactName,
      odooCompanyName: TENANT_NAME,
      activeProducts: ["Family Dental Care Plan"],
      invoices: [
        { id: `inv-${invoiceNumber}`, label: `Invoice #${invoiceNumber} — Recent visit`, amount: "$180.00", state: summary.unread ? "overdue" : "paid", daysOverdue: summary.unread ? 5 : undefined },
      ],
      ordersOrAppointments: [{ id: `${summary.id}-appt`, label: "Routine checkup", date: "Jul 30, 2026", status: "Confirmed" }],
      supportTickets: summary.status === "waiting" ? [{ id: `${summary.id}-tix`, subject: "Awaiting front-desk pickup", status: "open" }] : [],
      assignedNumbers: [{ number: "+1 (555) 010-3742", label: "Front Desk (main line)", pbxStatus: "active" }],
      callHistory:
        summary.channel === "voice"
          ? [{ id: `${summary.id}-call`, direction: "missed", label: `Missed call from ${summary.contactName}`, timestamp: summary.timestamp }]
          : [],
      assignedClawithAgent: CLAWITH_AGENT.name,
      onboardingState: "Onboarded — accepted Feb 2026",
    },
    hermes: {
      summary: `${firstName} reached out about "${summary.lastMessage}" — Clawith has responded once and is waiting on either the customer or a human operator.`,
      odooFacts: [`Invoice #${invoiceNumber} is on file for ${summary.contactName}.`, "No open incidents beyond this conversation."],
      suggestedResponse: `Hi ${firstName}, thanks for your patience — here's an update on your request. Let me know if you'd like anything else.`,
      recommendedNextAction: "Confirm the customer's request is fully resolved before closing the conversation.",
      riskAlert: summary.unread ? "Unread inbound message — response time SLA at risk." : null,
      callbackPrepNote: `If ${firstName} requests a callback, confirm the best number is ${"+1 (555) 019-2244"}.`,
      workflowSuggestion: "No special workflow needed — standard front-desk reply is sufficient.",
    },
  };
}

const DETAIL_CACHE = new Map<string, ConversationDetail>();

export function getConversationDetail(id: string): ConversationDetail {
  const summary = getConversationSummary(id);
  if (DETAIL_CACHE.has(summary.id)) return DETAIL_CACHE.get(summary.id)!;
  const detail = summary.id === "conv-1" ? MARIA_DETAIL : buildGenericDetail(summary);
  DETAIL_CACHE.set(summary.id, detail);
  return detail;
}

export function defaultStateForStatus(status: MockConversationSummary["status"]): ConversationState {
  if (status === "ai_handling") return "ai_handling";
  if (status === "human_active") return "human_control";
  return "takeover_requested";
}
