'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { type ColumnDef } from '@tanstack/react-table';
import { RefreshCw } from 'lucide-react';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import type { VoiceHealthReport, VoiceHealthLine } from '@/lib/voice-health-report';

// 'all' means "all live lines" — retired (gray) lines are intentionally
// excluded from the default view (the whole point of retiring a line is
// that it drops off the operator's problem list) and only show up when the
// Retired filter is explicitly selected.
type ColorFilter = 'all' | 'green' | 'amber' | 'red' | 'gray';

const COLOR_DOT: Record<VoiceHealthLine['color'], string> = {
  green: 'bg-green-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  gray: 'bg-gray-400',
};

const COLOR_BADGE_CLASS: Record<VoiceHealthLine['color'], string> = {
  green: 'border-transparent bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  amber: 'border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  red: 'border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  gray: 'border-transparent bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

const FILTERS: { key: ColorFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'green', label: 'Green' },
  { key: 'amber', label: 'Amber' },
  { key: 'red', label: 'Red' },
  { key: 'gray', label: 'Retired' },
];

const columns: ColumnDef<VoiceHealthLine, any>[] = [
  {
    accessorKey: 'ownerName',
    header: 'Owner',
    cell: ({ row }) => <span className="font-semibold">{row.original.ownerName}</span>,
  },
  {
    accessorKey: 'ownerKind',
    header: 'Kind',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.ownerKind}</span>,
  },
  {
    accessorKey: 'did',
    header: 'DID',
    cell: ({ row }) => <span className="font-mono text-[11px]">{row.original.did ?? '—'}</span>,
  },
  {
    id: 'magnus',
    accessorFn: (row) => `${row.magnusUserId ?? '-'} ${row.magnusSipId ?? '-'}`,
    header: 'Magnus user/sip',
    enableSorting: false,
    cell: ({ row }) => (
      <span className="font-mono text-[11px] text-muted-foreground">
        user={row.original.magnusUserId ?? '-'} sip={row.original.magnusSipId ?? '-'}
      </span>
    ),
  },
  {
    accessorKey: 'mode',
    header: 'Routing mode',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.mode}</span>,
  },
  {
    accessorKey: 'status',
    header: 'Health',
    cell: ({ row }) => (
      <Badge className={COLOR_BADGE_CLASS[row.original.color]}>
        <span className={cn('mr-1.5 inline-block size-1.5 rounded-full', COLOR_DOT[row.original.color])} />
        {row.original.status}
      </Badge>
    ),
  },
  {
    accessorKey: 'provisioningState',
    header: 'Provisioning',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.provisioningState}</span>,
  },
  {
    accessorKey: 'createdAt',
    header: 'Created',
    cell: ({ row }) => (
      <span className="text-muted-foreground">{new Date(row.original.createdAt).toLocaleDateString()}</span>
    ),
  },
  {
    id: 'issues',
    accessorFn: (row) => row.issues.join(' '),
    header: 'Issues',
    enableSorting: false,
    cell: ({ row }) =>
      row.original.issues.length === 0 ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <ul className="list-inside list-disc text-[11px] text-muted-foreground">
          {row.original.issues.map((issue, i) => (
            <li key={i}>{issue}</li>
          ))}
        </ul>
      ),
  },
  {
    id: 'actions',
    header: '',
    enableSorting: false,
    cell: ({ row }) =>
      row.original.ownerKind === 'business' && row.original.tenantId ? (
        <Button asChild size="sm" variant="ghost">
          <Link href={`/admin/tenants/${row.original.tenantId}`}>Open →</Link>
        </Button>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
];

export function VoiceHealthTable({ initialReport }: { initialReport: VoiceHealthReport }) {
  const [report, setReport] = useState(initialReport);
  const [colorFilter, setColorFilter] = useState<ColorFilter>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function recheck() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/voice-health');
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Re-check failed');
        return;
      }
      setReport(data);
    } catch (e: any) {
      setError(e?.message ?? 'Re-check failed');
    } finally {
      setLoading(false);
    }
  }

  const filteredLines = useMemo(
    () =>
      colorFilter === 'all'
        ? report.lines.filter((l) => l.color !== 'gray')
        : report.lines.filter((l) => l.color === colorFilter),
    [report.lines, colorFilter],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => {
            const count = f.key === 'all' ? report.summary.total - report.summary.gray : report.summary[f.key];
            return (
              <Button
                key={f.key}
                size="sm"
                variant={colorFilter === f.key ? 'default' : 'outline'}
                onClick={() => setColorFilter(f.key)}
              >
                {f.key !== 'all' && <span className={cn('mr-1.5 inline-block size-1.5 rounded-full', COLOR_DOT[f.key as VoiceHealthLine['color']])} />}
                {f.label} ({count})
              </Button>
            );
          })}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            Last checked: {new Date(report.checkedAt).toLocaleString()}
          </span>
          <Button size="sm" variant="outline" onClick={recheck} disabled={loading}>
            <RefreshCw className={cn('mr-1.5 size-3.5', loading && 'animate-spin')} />
            {loading ? 'Checking…' : 'Re-check'}
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <DataTable columns={columns} data={filteredLines} searchPlaceholder="Search voice lines…" emptyMessage="No voice lines match this filter." />
    </div>
  );
}
