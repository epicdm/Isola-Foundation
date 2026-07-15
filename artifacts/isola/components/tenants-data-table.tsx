'use client';

import Link from 'next/link';
import { type ColumnDef } from '@tanstack/react-table';
import { DataTable } from '@/components/data-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export interface TenantRow {
  id: string;
  business_name: string;
  plan: string;
  status: string;
  balance: string | null;
  users: number;
  conversations: number;
  createdAt: string;
  agents: { id: string; label: string }[];
}

function planVariant(plan: string): 'default' | 'secondary' | 'outline' {
  if (plan === 'pro') return 'default';
  if (plan === 'growth') return 'secondary';
  return 'outline';
}

const columns: ColumnDef<TenantRow, any>[] = [
  {
    accessorKey: 'business_name',
    header: 'Business',
    cell: ({ row }) => <span className="font-semibold">{row.original.business_name}</span>,
  },
  {
    accessorKey: 'id',
    header: 'Tenant id',
    cell: ({ row }) => <span className="font-mono text-[11px] text-muted-foreground">{row.original.id}</span>,
    enableSorting: false,
  },
  {
    id: 'agentId',
    accessorFn: (row) => row.agents.map((a) => a.id).join(' '),
    header: 'Agent id',
    enableSorting: false,
    cell: ({ row }) =>
      row.original.agents.length === 0 ? (
        <span className="text-muted-foreground">none</span>
      ) : (
        <div className="flex flex-col gap-0.5">
          {row.original.agents.map((a) => (
            <span key={a.id} title={a.label} className="font-mono text-[11px] text-muted-foreground">
              {a.id}
            </span>
          ))}
        </div>
      ),
  },
  {
    accessorKey: 'plan',
    header: 'Plan',
    cell: ({ row }) => <Badge variant={planVariant(row.original.plan)}>{row.original.plan}</Badge>,
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => (
      <Badge variant={row.original.status === 'active' ? 'default' : 'destructive'}>
        {row.original.status}
      </Badge>
    ),
  },
  {
    accessorKey: 'balance',
    header: 'Balance',
    cell: ({ row }) => row.original.balance ?? '—',
  },
  { accessorKey: 'users', header: 'Users' },
  { accessorKey: 'conversations', header: 'Convs' },
  {
    accessorKey: 'createdAt',
    header: 'Created',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.createdAt}</span>,
  },
  {
    id: 'actions',
    header: '',
    enableSorting: false,
    cell: ({ row }) => (
      <Button asChild size="sm" variant="ghost">
        <Link href={`/admin/tenants/${row.original.id}`}>View</Link>
      </Button>
    ),
  },
];

export function TenantsDataTable({ data }: { data: TenantRow[] }) {
  return (
    <DataTable
      columns={columns}
      data={data}
      searchPlaceholder="Search tenants…"
      emptyMessage="No tenants yet. Onboard one below."
    />
  );
}
