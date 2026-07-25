"use client";

import { useState, type ComponentType, type ReactNode } from "react";
import {
  AlertCircle,
  Bot,
  Calendar,
  CreditCard,
  Phone,
  PhoneMissed,
  Ticket,
  Wifi,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

import type { Customer360Data, MockInvoice } from "./types";

const INVOICE_CLASSES: Record<MockInvoice["state"], string> = {
  paid: "badge-success",
  overdue: "border-transparent bg-destructive text-destructive-foreground",
  pending: "badge-warning",
};

const ACTIONS = [
  "Create/update lead",
  "Create support request",
  "Request payment",
  "Schedule callback",
  "Escalate incident",
  "Start approved workflow",
] as const;

function Section({ title, icon: Icon, children }: { title: string; icon: ComponentType<{ className?: string }>; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" />
        {title}
      </h4>
      {children}
    </div>
  );
}

export function Customer360Panel({ data }: { data: Customer360Data }) {
  const [lastAction, setLastAction] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4 p-3 text-sm">
      <div className="rounded-md border bg-muted/40 p-2.5">
        <p className="text-xs font-semibold">{data.odooCustomerName}</p>
        <p className="text-[11px] text-muted-foreground">{data.odooCompanyName} · Odoo customer record</p>
        <p className="mt-1 text-[11px] text-muted-foreground">{data.onboardingState}</p>
      </div>

      <Section title="Active products" icon={Wifi}>
        <ul className="space-y-1 text-xs">
          {data.activeProducts.map((p) => (
            <li key={p} className="rounded-md border px-2 py-1">
              {p}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Invoices" icon={CreditCard}>
        <ul className="space-y-1.5">
          {data.invoices.map((inv) => (
            <li key={inv.id} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs">
              <div className="min-w-0">
                <p className="font-medium">{inv.label}</p>
                <p className="text-muted-foreground">
                  {inv.amount}
                  {inv.state === "overdue" && inv.daysOverdue ? ` · ${inv.daysOverdue}d overdue` : ""}
                </p>
              </div>
              <Badge variant="outline" className={cn("shrink-0 border text-[10px] capitalize", INVOICE_CLASSES[inv.state])}>
                {inv.state}
              </Badge>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Orders / appointments" icon={Calendar}>
        <ul className="space-y-1 text-xs">
          {data.ordersOrAppointments.map((o) => (
            <li key={o.id} className="flex items-center justify-between rounded-md border px-2 py-1">
              <span>{o.label}</span>
              <span className="text-muted-foreground">{o.date}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Support tickets" icon={Ticket}>
        {data.supportTickets.length === 0 ? (
          <p className="text-xs text-muted-foreground">No open tickets.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {data.supportTickets.map((t) => (
              <li key={t.id} className="flex items-center justify-between rounded-md border px-2 py-1">
                <span>{t.subject}</span>
                <Badge variant="outline" className="text-[10px] capitalize">
                  {t.status}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Numbers / PBX status" icon={Phone}>
        <ul className="space-y-1 text-xs">
          {data.assignedNumbers.map((n) => (
            <li key={n.number} className="flex items-center justify-between rounded-md border px-2 py-1">
              <span>
                {n.number} <span className="text-muted-foreground">— {n.label}</span>
              </span>
              <Badge variant="outline" className={cn("text-[10px] capitalize", n.pbxStatus === "active" ? "badge-success" : "badge-warning")}>
                {n.pbxStatus}
              </Badge>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Call history" icon={PhoneMissed}>
        {data.callHistory.length === 0 ? (
          <p className="text-xs text-muted-foreground">No recent calls.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {data.callHistory.map((c) => (
              <li key={c.id} className="flex items-center justify-between rounded-md border px-2 py-1">
                <span>{c.label}</span>
                <span className="text-muted-foreground">{c.timestamp}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Assigned AI employee" icon={Bot}>
        <p className="rounded-md border px-2 py-1 text-xs">{data.assignedClawithAgent}</p>
      </Section>

      <Separator />

      <div>
        <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Contextual actions
        </h4>
        <div className="grid grid-cols-1 gap-1.5">
          {ACTIONS.map((action) => (
            <Button
              key={action}
              type="button"
              variant="outline"
              size="sm"
              className="h-auto justify-between py-1.5 text-xs opacity-70"
              onClick={() => setLastAction(action)}
            >
              {action}
              <Badge variant="secondary" className="ml-2 text-[9px]">
                simulated
              </Badge>
            </Button>
          ))}
        </div>
        {lastAction && (
          <p className="mt-2 flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
            <AlertCircle className="size-3.5 shrink-0" />
            Simulated — &quot;{lastAction}&quot; is not wired to Odoo/PBX in this preview.
          </p>
        )}
      </div>
    </div>
  );
}
