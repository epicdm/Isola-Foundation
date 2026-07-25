"use client";

import { Bot, User, UserRound } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

import { STATE_CONFIG } from "./state-config";
import type { ConversationDetail, ConversationState, MockMessage } from "./types";

function Bubble({ message }: { message: MockMessage }) {
  const isCustomer = message.sender === "customer";
  const isAi = message.sender === "ai";
  const isHuman = message.sender === "human";

  return (
    <div className={cn("flex items-end gap-2", isCustomer ? "justify-start" : "justify-end")}>
      {isCustomer && (
        <Avatar className="size-7 shrink-0">
          <AvatarFallback className="bg-muted text-[10px]">
            <UserRound className="size-3.5" />
          </AvatarFallback>
        </Avatar>
      )}
      <div className={cn("flex max-w-[75%] flex-col gap-1", !isCustomer && "items-end")}>
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {isAi && <Bot className="size-3" />}
          {isHuman && <User className="size-3" />}
          {message.senderName}
          <span className="text-muted-foreground/70">· {message.timestamp}</span>
        </span>
        <div
          className={cn(
            "rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-xs",
            isCustomer && "rounded-bl-sm bg-muted text-foreground",
            isAi && "rounded-br-sm bg-primary/10 text-foreground border border-primary/20",
            isHuman && "rounded-br-sm bg-secondary text-secondary-foreground"
          )}
        >
          {message.text}
        </div>
      </div>
      {isAi && (
        <Avatar className="size-7 shrink-0">
          <AvatarFallback className="bg-primary/15 text-[10px] text-primary">
            <Bot className="size-3.5" />
          </AvatarFallback>
        </Avatar>
      )}
      {isHuman && (
        <Avatar className="size-7 shrink-0">
          <AvatarFallback className="bg-secondary text-[10px]">
            <User className="size-3.5" />
          </AvatarFallback>
        </Avatar>
      )}
    </div>
  );
}

const DIVIDER_TONE: Record<ConversationState, string> = {
  ai_handling: "bg-primary/10 text-primary",
  takeover_requested: "badge-warning",
  human_control: "badge-success",
  ai_silent: "bg-secondary text-secondary-foreground",
  returned_to_ai: "bg-primary/10 text-primary",
};

export function MessageThread({
  detail,
  state,
  operatorName,
}: {
  detail: ConversationDetail;
  state: ConversationState;
  operatorName: string;
}) {
  const extra = detail.stateExtraMessages[state] ?? [];
  const config = STATE_CONFIG[state];
  const dividerText = config.dividerText.replace("{operator}", operatorName);

  return (
    <div className="flex flex-col gap-4 p-4">
      {detail.baseThread.map((m) => (
        <Bubble key={m.id} message={m} />
      ))}

      <div className="flex items-center justify-center py-1">
        <span
          className={cn(
            "rounded-full border px-3 py-1 text-center text-[11px] font-medium",
            DIVIDER_TONE[state]
          )}
        >
          {dividerText}
        </span>
      </div>

      {extra.map((m) => (
        <Bubble key={m.id} message={m} />
      ))}
    </div>
  );
}
