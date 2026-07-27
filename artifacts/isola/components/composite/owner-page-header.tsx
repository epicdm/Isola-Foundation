import type { ReactNode } from 'react';

export function OwnerPageHeader({ eyebrow, title, actions }: { eyebrow?: string; title: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        {eyebrow && <div className="text-sm text-muted-foreground">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}
