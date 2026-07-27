'use client';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';

export interface ContextWorkspaceHeaderProps {
  name: string; initials: string; meta: string;
  onOpenConversation: () => void; primaryLabel: string; onPrimary: () => void;
}

// ContextWorkspaceHeader — identity/context for one business, customer or account.
// Fix (review item 5): "Open in Chatwoot" renamed to customer-facing language
// ("View full conversation") since this workspace is not an internal-only surface;
// marked 'use client' for its callback props.
export function ContextWorkspaceHeader(p: ContextWorkspaceHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 border-b px-6 py-5 sm:px-8">
      <div className="flex items-center gap-3.5">
        <Avatar className="size-11"><AvatarFallback className="text-sm font-semibold">{p.initials}</AvatarFallback></Avatar>
        <div>
          <div className="text-lg font-bold tracking-tight">{p.name}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{p.meta}</div>
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={p.onOpenConversation}>View full conversation &rarr;</Button>
        <Button size="sm" onClick={p.onPrimary}>{p.primaryLabel}</Button>
      </div>
    </div>
  );
}
