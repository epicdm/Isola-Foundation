"use client";

import { Paperclip, Send, Smile } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Composer({
  enabled,
  value,
  onChange,
}: {
  enabled: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className={cn("shrink-0 border-t p-3", !enabled && "bg-muted/30")}>
      <div
        className={cn(
          "rounded-lg border bg-background p-2 transition-opacity",
          !enabled && "opacity-60"
        )}
      >
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={!enabled}
          placeholder={enabled ? "Type a reply to the customer…" : "AI is currently replying — composer is disabled"}
          rows={2}
          className="w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        <div className="mt-1 flex items-center justify-between">
          <div className="flex items-center gap-1 text-muted-foreground">
            <Button type="button" variant="ghost" size="icon" disabled={!enabled} className="size-7">
              <Paperclip className="size-3.5" />
            </Button>
            <Button type="button" variant="ghost" size="icon" disabled={!enabled} className="size-7">
              <Smile className="size-3.5" />
            </Button>
          </div>
          <Button type="button" size="sm" disabled={!enabled} className="h-7 gap-1.5 text-xs">
            <Send className="size-3.5" />
            Send
          </Button>
        </div>
      </div>
      <p className="mt-1 text-center text-[11px] text-muted-foreground">
        {enabled
          ? "(mock — sending disabled in preview)"
          : "(mock — sending disabled in preview; AI is in control)"}
      </p>
    </div>
  );
}
