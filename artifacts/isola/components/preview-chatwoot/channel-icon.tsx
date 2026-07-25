import { Globe, Phone, MessageCircle } from "lucide-react";

import type { Channel, ListStatus } from "./types";

export function ChannelIcon({ channel, className }: { channel: Channel; className?: string }) {
  if (channel === "whatsapp") return <MessageCircle className={className} aria-label="WhatsApp" />;
  if (channel === "voice") return <Phone className={className} aria-label="Voice" />;
  return <Globe className={className} aria-label="Web widget" />;
}

export function statusChipLabel(status: ListStatus): string {
  if (status === "ai_handling") return "AI handling";
  if (status === "human_active") return "Human active";
  return "Waiting";
}

export function statusChipClasses(status: ListStatus): string {
  if (status === "ai_handling") return "bg-primary/10 text-primary border-primary/20";
  if (status === "human_active") return "badge-success";
  return "badge-warning";
}
