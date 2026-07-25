"use client";

import { Bot, ChevronDown, ExternalLink, Flag, Tag, User } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import type { ConversationDetail, MockOperator } from "./types";

const PRIORITIES: ConversationDetail["priority"][] = ["Low", "Medium", "High"];
const LIFECYCLES: ConversationDetail["lifecycle"][] = ["Open", "Pending", "Resolved"];

const PRIORITY_CLASSES: Record<ConversationDetail["priority"], string> = {
  Low: "bg-muted text-muted-foreground",
  Medium: "badge-warning",
  High: "border-transparent bg-destructive text-destructive-foreground",
};

const LIFECYCLE_CLASSES: Record<ConversationDetail["lifecycle"], string> = {
  Open: "bg-primary/10 text-primary border-primary/20",
  Pending: "badge-warning",
  Resolved: "badge-success",
};

export function AssignedToChip({
  assignedTo,
  clawithAgent,
  operator,
}: {
  assignedTo: "ai" | "human";
  clawithAgent: { name: string; avatarInitials: string };
  operator: MockOperator;
}) {
  if (assignedTo === "ai") {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-primary/5 px-2.5 py-1.5">
        <Avatar className="size-6">
          <AvatarFallback className="bg-primary/15 text-[10px] text-primary">
            <Bot className="size-3" />
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="text-xs font-medium leading-tight">{clawithAgent.name}</p>
          <a
            href="#"
            onClick={(e) => e.preventDefault()}
            className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-primary"
          >
            View in Clawith <ExternalLink className="size-2.5" />
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-md border bg-secondary/40 px-2.5 py-1.5">
      <Avatar className="size-6">
        <AvatarFallback className="bg-secondary text-[10px]">{operator.initials}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="text-xs font-medium leading-tight">{operator.name}</p>
        <p className="text-[10px] text-muted-foreground">Human operator</p>
      </div>
    </div>
  );
}

export function AssigneeDropdown({
  operators,
  selected,
  onSelect,
}: {
  operators: MockOperator[];
  selected: MockOperator;
  onSelect: (op: MockOperator) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium hover-elevate"
        >
          <User className="size-3.5 text-muted-foreground" />
          {selected.name}
          <ChevronDown className="size-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Assign conversation (mock)</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {operators.map((op) => (
          <DropdownMenuItem key={op.id} onClick={() => onSelect(op)}>
            {op.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function LabelChips({ labels }: { labels: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Tag className="size-3.5 text-muted-foreground" />
      {labels.map((label) => (
        <Badge key={label} variant="secondary" className="text-[11px]">
          {label}
        </Badge>
      ))}
    </div>
  );
}

export function PriorityDropdown({
  priority,
  onChange,
}: {
  priority: ConversationDetail["priority"];
  onChange: (p: ConversationDetail["priority"]) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="hover-elevate rounded-md">
          <Badge
            variant="outline"
            className={cn("flex items-center gap-1 border text-[11px]", PRIORITY_CLASSES[priority])}
          >
            <Flag className="size-3" />
            {priority} priority
            <ChevronDown className="size-3 opacity-60" />
          </Badge>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Priority (mock)</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {PRIORITIES.map((p) => (
          <DropdownMenuItem key={p} onClick={() => onChange(p)}>
            {p}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function LifecycleDropdown({
  lifecycle,
  onChange,
}: {
  lifecycle: ConversationDetail["lifecycle"];
  onChange: (l: ConversationDetail["lifecycle"]) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="hover-elevate rounded-md">
          <Badge
            variant="outline"
            className={cn("flex items-center gap-1 border text-[11px]", LIFECYCLE_CLASSES[lifecycle])}
          >
            {lifecycle}
            <ChevronDown className="size-3 opacity-60" />
          </Badge>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>Lifecycle (mock)</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {LIFECYCLES.map((l) => (
          <DropdownMenuItem key={l} onClick={() => onChange(l)}>
            {l}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
