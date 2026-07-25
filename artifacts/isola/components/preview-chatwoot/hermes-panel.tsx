"use client";

import { useState } from "react";
import { AlertTriangle, Check, Copy, PhoneCall, Sparkles, Workflow } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

import type { HermesData } from "./types";

export function HermesPanel({
  data,
  onCopyToComposer,
}: {
  data: HermesData;
  onCopyToComposer: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <div className="flex flex-col gap-4 p-3 text-sm">
      <div className="flex items-center gap-2 rounded-md border border-secondary-border bg-secondary/30 px-2.5 py-2">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-bold text-secondary-foreground">
          H
        </span>
        <p className="text-[11px] leading-snug text-muted-foreground">
          Hermes assists the human operator only. It never replies to the customer automatically.
        </p>
      </div>

      <div className="space-y-1.5">
        <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Sparkles className="size-3.5" />
          Conversation summary
        </h4>
        <p className="rounded-md border px-2.5 py-2 text-xs leading-relaxed">{data.summary}</p>
      </div>

      <div className="space-y-1.5">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Relevant Odoo facts
        </h4>
        <ul className="space-y-1 text-xs">
          {data.odooFacts.map((fact) => (
            <li key={fact} className="rounded-md border px-2.5 py-1.5">
              {fact}
            </li>
          ))}
        </ul>
      </div>

      {data.riskAlert && (
        <div className="flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {data.riskAlert}
        </div>
      )}

      <div className="space-y-1.5">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Suggested response
        </h4>
        <p className="rounded-md border bg-muted/40 px-2.5 py-2 text-xs leading-relaxed">
          {data.suggestedResponse}
        </p>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => {
            onCopyToComposer(data.suggestedResponse);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied to composer" : "Copy to composer"}
        </Button>
        <p className="text-[10px] text-muted-foreground">
          Copies into the reply box only — a human still has to review and hit send.
        </p>
      </div>

      <Separator />

      <div className="space-y-1.5">
        <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Recommended next action
        </h4>
        <p className="text-xs">{data.recommendedNextAction}</p>
      </div>

      <div className="space-y-1.5">
        <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <PhoneCall className="size-3.5" />
          Callback-prep note
        </h4>
        <p className="text-xs">{data.callbackPrepNote}</p>
      </div>

      <div className="space-y-1.5">
        <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Workflow className="size-3.5" />
          Workflow suggestion
        </h4>
        <p className="text-xs">{data.workflowSuggestion}</p>
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 text-xs"
        onClick={() => setAcknowledged(true)}
        disabled={acknowledged}
      >
        {acknowledged ? <Check className="size-3.5" /> : null}
        {acknowledged ? "Acknowledged" : "Acknowledge"}
      </Button>
      {acknowledged && (
        <Badge variant="outline" className="w-fit text-[10px]">
          Noted for the human operator — nothing sent to the customer
        </Badge>
      )}
    </div>
  );
}
