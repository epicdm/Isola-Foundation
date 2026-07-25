"use client";

import type { ComponentType } from "react";
import { ArrowRightLeft, Bot, Ear, Undo2, UserCheck } from "lucide-react";

import { cn } from "@/lib/utils";

import { STATE_CONFIG, STATE_ORDER } from "./state-config";
import type { ConversationState } from "./types";
import type { ConversationStateConfig } from "./state-config";

const STATE_ICON: Record<ConversationState, ComponentType<{ className?: string }>> = {
  ai_handling: Bot,
  takeover_requested: ArrowRightLeft,
  human_control: UserCheck,
  ai_silent: Ear,
  returned_to_ai: Undo2,
};

const BANNER_TONE_CLASSES: Record<ConversationStateConfig["bannerTone"], string> = {
  ai: "bg-primary/10 text-primary border-primary/20",
  pending: "badge-warning",
  human: "badge-success",
  silent: "bg-secondary text-secondary-foreground border-secondary-border",
  returned: "bg-primary/10 text-primary border-primary/20",
};

function toneOf(state: ConversationState) {
  return STATE_CONFIG[state].bannerTone;
}

export function StateControlBar({
  state,
  onChange,
}: {
  state: ConversationState;
  onChange: (state: ConversationState) => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-b bg-background/60 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Simulate handoff state:
        </span>
        {STATE_ORDER.map((s) => {
          const Icon = STATE_ICON[s];
          const active = s === state;
          return (
            <button
              key={s}
              type="button"
              onClick={() => onChange(s)}
              aria-pressed={active}
              className={cn(
                "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover-elevate",
                active
                  ? "border-primary bg-primary text-primary-foreground shadow-xs"
                  : "border-input bg-background text-muted-foreground"
              )}
            >
              <Icon className="size-3.5" />
              {STATE_CONFIG[s].label}
            </button>
          );
        })}
      </div>

      <div
        className={cn(
          "rounded-md border px-3 py-2 text-xs font-medium",
          BANNER_TONE_CLASSES[toneOf(state)]
        )}
      >
        {STATE_CONFIG[state].bannerText}
      </div>
    </div>
  );
}
