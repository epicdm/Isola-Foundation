import type { Metadata } from "next";
import { AlertTriangle } from "lucide-react";

export const metadata: Metadata = {
  title: "Simulated Chatwoot workspace",
};

/**
 * Route-group layout for the mock Chatwoot workspace preview. This is a
 * design/UX mockup only for an owner visual-review packet — it never talks
 * to a real Chatwoot instance, Odoo, or Magnus/PBX. All data rendered under
 * /chatwoot is hardcoded in components/preview-chatwoot/*.
 */
export default function ChatwootPreviewLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs font-medium text-amber-800 dark:text-amber-300">
        <AlertTriangle className="size-4 shrink-0" />
        <span>
          PREVIEW / MOCK — Simulated Chatwoot workspace for owner visual review. No real
          conversations, no real customer data.
        </span>
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
