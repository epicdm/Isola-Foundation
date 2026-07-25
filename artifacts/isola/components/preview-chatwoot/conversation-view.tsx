"use client";

import { useState } from "react";
import { ArrowLeft, Info, MessagesSquare } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import { AssignedToChip, AssigneeDropdown, LabelChips, LifecycleDropdown, PriorityDropdown } from "./conversation-meta";
import { ConversationList } from "./conversation-list";
import { ContactSidebar } from "./contact-sidebar";
import { Composer } from "./composer";
import { ChatwootIconRail } from "./icon-rail";
import { defaultStateForStatus } from "./mock-data";
import { MessageThread } from "./message-thread";
import { PrivateNote } from "./private-note";
import { StateControlBar } from "./state-control-bar";
import { STATE_CONFIG } from "./state-config";
import type { ConversationDetail, ConversationState, MockOperator } from "./types";

type MobilePane = "list" | "thread" | "contact";

export function ConversationView({ detail }: { detail: ConversationDetail }) {
  const [state, setState] = useState<ConversationState>(defaultStateForStatus(detail.summary.status));
  const [composerValue, setComposerValue] = useState("");
  const [operator, setOperator] = useState<MockOperator>(detail.defaultOperator);
  const [priority, setPriority] = useState(detail.priority);
  const [lifecycle, setLifecycle] = useState(detail.lifecycle);
  const [mobilePane, setMobilePane] = useState<MobilePane>("thread");

  const config = STATE_CONFIG[state];

  return (
    <div className="flex h-full min-h-0 flex-1">
      <ChatwootIconRail />

      <div
        className={cn(
          "w-full flex-col border-r md:flex md:w-80 md:shrink-0",
          mobilePane === "list" ? "flex" : "hidden md:flex"
        )}
      >
        <ConversationList activeConversationId={detail.summary.id} />
      </div>

      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col",
          mobilePane === "thread" ? "flex" : "hidden md:flex"
        )}
      >
        <div className="flex shrink-0 items-center gap-2 border-b p-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 md:hidden"
            onClick={() => setMobilePane("list")}
            aria-label="Back to conversation list"
          >
            <ArrowLeft className="size-4" />
          </Button>
          <Avatar className="size-8 shrink-0">
            <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
              {detail.summary.initials}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold">
              {detail.summary.contactName}
            </p>
            <p className="text-[11px] text-muted-foreground">{detail.contactPhone}</p>
          </div>
          <div className="hidden shrink-0 sm:block">
            <AssignedToChip assignedTo={config.assignedTo} clawithAgent={detail.clawithAgent} operator={operator} />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 md:hidden"
            onClick={() => setMobilePane("contact")}
            aria-label="View contact details"
          >
            <Info className="size-4" />
          </Button>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2 sm:hidden">
          <AssignedToChip assignedTo={config.assignedTo} clawithAgent={detail.clawithAgent} operator={operator} />
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
          <AssigneeDropdown operators={detail.operators} selected={operator} onSelect={setOperator} />
          <LabelChips labels={detail.labels} />
          <PriorityDropdown priority={priority} onChange={setPriority} />
          <LifecycleDropdown lifecycle={lifecycle} onChange={setLifecycle} />
        </div>

        <StateControlBar state={state} onChange={setState} />

        <ScrollArea className="min-h-0 flex-1">
          <MessageThread detail={detail} state={state} operatorName={operator.name} />
        </ScrollArea>

        <PrivateNote note={detail.privateNote} />

        <Composer enabled={config.composerEnabled} value={composerValue} onChange={setComposerValue} />
      </div>

      <div
        className={cn(
          "w-full flex-col md:flex md:w-[22rem] md:shrink-0 md:border-l",
          mobilePane === "contact" ? "flex" : "hidden md:flex"
        )}
      >
        <div className="flex shrink-0 items-center gap-2 border-b p-2 md:hidden">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => setMobilePane("thread")}
          >
            <ArrowLeft className="size-3.5" />
            Back to conversation
          </Button>
          <span className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
            <MessagesSquare className="size-3" />
            Contact details
          </span>
        </div>
        <ContactSidebar detail={detail} onCopyToComposer={setComposerValue} />
      </div>
    </div>
  );
}
