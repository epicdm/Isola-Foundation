'use client';

import Link from 'next/link';
import { type ColumnDef } from '@tanstack/react-table';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ArrowRight, Bot } from 'lucide-react';

export interface ConversationRow {
  id: string;
  name: string;
  status: string;
  agentTookOver: boolean;
  lastMessage: string | null;
  lastMessageFromAgent: boolean;
  time: string;
  timestamp: number;
}

function initialsOf(name: string) {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

const columns: ColumnDef<ConversationRow, any>[] = [
  {
    accessorKey: 'name',
    header: 'Customer',
    cell: ({ row }) => (
      <div className="flex items-center gap-2.5">
        <Avatar className="size-7">
          <AvatarFallback className="text-[11px]">{initialsOf(row.original.name)}</AvatarFallback>
        </Avatar>
        <div className="flex items-center gap-1.5">
          <span className="font-medium">{row.original.name}</span>
          {row.original.agentTookOver && (
            <Badge variant="secondary" className="text-[10px]">
              Human
            </Badge>
          )}
        </div>
      </div>
    ),
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => (
      <Badge variant={row.original.status === 'open' ? 'default' : 'outline'}>
        {row.original.status}
      </Badge>
    ),
  },
  {
    accessorKey: 'lastMessage',
    header: 'Last message',
    enableSorting: false,
    cell: ({ row }) => (
      <div className="flex max-w-xs items-center gap-1.5 truncate text-muted-foreground">
        {row.original.lastMessageFromAgent && <Bot className="size-3.5 shrink-0" />}
        <span className="truncate">{row.original.lastMessage ?? '—'}</span>
      </div>
    ),
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
        <Link href={`/inbox/${row.original.id}`}>
          View <ArrowRight className="size-3.5" />
        </Link>
      </Button>
    ),
  },
];

export function InboxDataTable({ data }: { data: ConversationRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search conversations…"
      emptyMessage="No conversations yet."
    />
  );
}
