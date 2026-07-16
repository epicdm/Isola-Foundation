'use client';

import Link from 'next/link';
import { type ColumnDef } from '@tanstack/react-table';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowRight, Briefcase, MessageCircle, PhoneMissed, ShieldCheck } from 'lucide-react';
import type { WorkQueueItem, WorkQueueItemType } from '@/lib/workspace-queue';
import { cn } from '@/lib/utils';

const TYPE_META: Record<WorkQueueItemType, { label: string; icon: typeof Briefcase }> = {
  odoo_task: { label: 'Task', icon: Briefcase },
  conversation: { label: 'Conversation', icon: MessageCircle },
  voicemail: { label: 'Voicemail', icon: PhoneMissed },
  approval: { label: 'Approval', icon: ShieldCheck },
};

const columns: ColumnDef<WorkQueueItem, any>[] = [
  {
    accessorKey: 'type',
    header: 'Type',
    cell: ({ row }) => {
      const meta = TYPE_META[row.original.type];
      const Icon = meta.icon;
      return (
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Icon className="size-3.5" />
          <span className="text-xs">{meta.label}</span>
        </div>
      );
    },
  },
  {
    accessorKey: 'title',
    header: 'Item',
    cell: ({ row }) => (
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5 font-medium">
          {row.original.title}
          {row.original.urgent && (
            <Badge variant="destructive" className="text-[10px]">
              Urgent
            </Badge>
          )}
        </div>
        <div className="max-w-md overflow-hidden text-ellipsis whitespace-nowrap text-xs text-muted-foreground">
          {row.original.subtitle}
        </div>
      </div>
    ),
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => <Badge variant="outline">{row.original.status}</Badge>,
  },
  {
    accessorKey: 'timestamp',
    header: 'Time',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.time}</span>,
  },
  {
    id: 'actions',
    header: '',
    enableSorting: false,
    cell: ({ row }) => (
      <Button asChild size="sm" variant="ghost">
        <Link href={row.original.href}>
          View <ArrowRight className="size-3.5" />
        </Link>
      </Button>
    ),
  },
];

export function WorkspaceQueueTable({ data, className }: { data: WorkQueueItem[]; className?: string }) {
  return (
    <div className={cn(className)}>
      <DataTable
        columns={columns}
        data={data}
        searchPlaceholder="Search your work queue…"
        emptyMessage="Nothing in your queue right now."
      />
    </div>
  );
}
