"use client";

import Link from "next/link";
import { useState } from "react";
import { Search } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { ChannelIcon, statusChipClasses, statusChipLabel } from "./channel-icon";
import { CONVERSATIONS } from "./mock-data";
import type { FilterBucket } from "./types";

const TABS: { value: FilterBucket; label: string }[] = [
  { value: "mine", label: "Mine" },
  { value: "unassigned", label: "Unassigned" },
  { value: "all", label: "All" },
];

const TENANT_LABEL = "Riverside Family Dental";

// Single-line clipping without relying on the Tailwind shorthand utility
// (kept spelled out across classes for readability in this file).
const CLIP_LINE = "overflow-hidden text-ellipsis whitespace-nowrap";

export function ConversationList({ activeConversationId }: { activeConversationId?: string }) {
  const [tab, setTab] = useState<FilterBucket>("all");
  const rows = CONVERSATIONS.filter((c) => c.buckets.includes(tab));

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="shrink-0 border-b p-3">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{TENANT_LABEL}</h2>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search conversations (preview only)"
            disabled
            className="h-8 pl-8 text-xs disabled:cursor-not-allowed disabled:opacity-70"
          />
        </div>
        <Tabs value={tab} onValueChange={(v) => setTab(v as FilterBucket)} className="mt-2">
          <TabsList className="h-8 w-full">
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="flex-1 text-xs">
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rows.map((conv) => (
          <Link
            key={conv.id}
            href={`/chatwoot/${conv.id}`}
            className={cn(
              "flex items-start gap-2.5 border-b px-3 py-3 text-left transition-colors hover-elevate",
              activeConversationId === conv.id && "bg-muted"
            )}
          >
            <div className="relative shrink-0">
              <Avatar className="size-9">
                <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                  {conv.initials}
                </AvatarFallback>
              </Avatar>
              <span className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full border-2 border-background bg-background">
                <ChannelIcon channel={conv.channel} className="size-2.5 text-muted-foreground" />
              </span>
              {conv.unread && (
                <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-background bg-primary" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className={cn("text-sm", CLIP_LINE, conv.unread ? "font-semibold" : "font-medium")}>
                  {conv.contactName}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{conv.timestamp}</span>
              </div>
              <p className={cn("text-xs text-muted-foreground", CLIP_LINE)}>{conv.lastMessage}</p>
              <Badge variant="outline" className={cn("mt-1.5 border text-[10px]", statusChipClasses(conv.status))}>
                {statusChipLabel(conv.status)}
              </Badge>
            </div>
          </Link>
        ))}
        {rows.length === 0 && (
          <p className="p-4 text-center text-xs text-muted-foreground">No conversations in this view.</p>
        )}
      </div>
    </div>
  );
}
