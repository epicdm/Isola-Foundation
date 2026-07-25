"use client";

import { BarChart3, Inbox, Settings, Users } from "lucide-react";

import { cn } from "@/lib/utils";

const RAIL_ITEMS = [
  { icon: Inbox, label: "Conversations", active: true },
  { icon: Users, label: "Contacts", active: false },
  { icon: BarChart3, label: "Reports", active: false },
  { icon: Settings, label: "Settings", active: false },
];

/**
 * Far-left thin icon rail — purely visual chrome to sell the "this is a
 * different real workspace from Isola" impression. Non-functional by design.
 */
export function ChatwootIconRail() {
  return (
    <div className="hidden w-14 shrink-0 flex-col items-center gap-1 border-r bg-muted/40 py-3 md:flex">
      <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
        RF
      </div>
      {RAIL_ITEMS.map((item) => (
        <button
          key={item.label}
          type="button"
          title={item.label}
          aria-label={item.label}
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover-elevate",
            item.active && "bg-background text-foreground shadow-sm"
          )}
        >
          <item.icon className="size-4" />
        </button>
      ))}
    </div>
  );
}
