import { AlertCircle, CircleSlash, Clock, Database } from 'lucide-react';
import { SOURCE_LABELS, type Provenance } from '@/lib/workspace/provenance';
import { relativeTime } from '@/lib/workspace-queue';
import { cn } from '@/lib/utils';

/**
 * States where a panel's data came from and how fresh it is.
 *
 * Chunk 1 requires that nothing unconfigured is shown as if it were real, so
 * anything other than `live` renders its explanation instead of a value.
 */
export function ProvenanceNote({ provenance, className }: { provenance: Provenance; className?: string }) {
  const label = SOURCE_LABELS[provenance.source];
  const asOf = provenance.dataAsOf ? relativeTime(new Date(provenance.dataAsOf)) : null;

  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground', className)}>
      <span className="inline-flex items-center gap-1.5">
        <Database className="size-3.5" />
        {label}
      </span>
      {asOf && (
        <span className="inline-flex items-center gap-1.5">
          <Clock className="size-3.5" />
          Updated {asOf}
        </span>
      )}
      {provenance.availability !== 'live' && provenance.note && (
        <span className="inline-flex items-center gap-1.5 text-warning">
          <AlertCircle className="size-3.5" />
          {provenance.availability === 'not_configured' ? 'Not configured' : 'Unavailable'}
        </span>
      )}
    </div>
  );
}

/**
 * Full-width honest state for a panel that has nothing real to show.
 * Uses the established empty-state chrome so it reads as part of the product,
 * not as an error.
 */
export function HonestState({
  provenance,
  icon: Icon = CircleSlash,
  title,
}: {
  provenance: Provenance;
  icon?: React.ComponentType<{ className?: string }>;
  title?: string;
}) {
  const isGap = provenance.availability === 'not_configured';
  return (
    <div className="flex flex-col items-center gap-2 py-12 text-center">
      <Icon className={cn('size-8', isGap ? 'text-warning' : 'text-muted-foreground')} />
      {title && <div className="font-medium">{title}</div>}
      <p className="max-w-prose text-sm text-muted-foreground">{provenance.note}</p>
      <ProvenanceNote provenance={provenance} className="justify-center pt-1" />
    </div>
  );
}
