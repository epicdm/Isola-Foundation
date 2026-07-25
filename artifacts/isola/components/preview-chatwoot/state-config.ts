import type { ConversationState } from "./types";

export interface ConversationStateConfig {
  id: ConversationState;
  label: string;
  shortLabel: string;
  bannerText: string;
  bannerTone: "ai" | "pending" | "human" | "silent" | "returned";
  assignedTo: "ai" | "human";
  composerEnabled: boolean;
  /** {operator} is substituted with the current operator's name at render time. */
  dividerText: string;
}

export const STATE_ORDER: ConversationState[] = [
  "ai_handling",
  "takeover_requested",
  "human_control",
  "ai_silent",
  "returned_to_ai",
];

export const STATE_CONFIG: Record<ConversationState, ConversationStateConfig> = {
  ai_handling: {
    id: "ai_handling",
    label: "AI Handling",
    shortLabel: "AI",
    bannerText: "AI is handling this conversation. Clawith is replying to the customer automatically.",
    bannerTone: "ai",
    assignedTo: "ai",
    composerEnabled: false,
    dividerText: "Clawith AI is actively handling this conversation",
  },
  takeover_requested: {
    id: "takeover_requested",
    label: "Takeover Requested",
    shortLabel: "Requested",
    bannerText:
      "Human takeover requested — awaiting pickup. AI keeps replying until a human operator joins.",
    bannerTone: "pending",
    assignedTo: "ai",
    composerEnabled: false,
    dividerText: "Takeover requested — waiting for a human operator to join",
  },
  human_control: {
    id: "human_control",
    label: "Human In Control",
    shortLabel: "Human",
    bannerText: "You are in control. AI replies are paused for this conversation.",
    bannerTone: "human",
    assignedTo: "human",
    composerEnabled: true,
    dividerText: "{operator} (human) has taken control of this conversation",
  },
  ai_silent: {
    id: "ai_silent",
    label: "AI Silent",
    shortLabel: "Silent",
    bannerText:
      "AI is silent while a human has control. AI and human never reply at the same time.",
    bannerTone: "silent",
    assignedTo: "human",
    composerEnabled: true,
    dividerText: "AI is silent — governance rule: AI and human never reply at once",
  },
  returned_to_ai: {
    id: "returned_to_ai",
    label: "Return to AI",
    shortLabel: "Returned",
    bannerText: "Conversation returned to AI. Clawith resumes automatic replies.",
    bannerTone: "returned",
    assignedTo: "ai",
    composerEnabled: false,
    dividerText: "Returned to AI — Clawith resumes replies",
  },
};
