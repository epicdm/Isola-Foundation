'use client';

import { UserPlus } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { TEAM } from '../../_lib/mock-data';
import { useMockCta } from '../../_lib/use-mock-cta';
import { MockCtaStatus } from '../../_components/mock-cta-status';

function roleVariant(role: string) {
  if (role === 'Owner') return 'default' as const;
  if (role === 'Manager') return 'secondary' as const;
  return 'outline' as const;
}

export default function TeamPage() {
  const invite = useMockCta('Invite sent — the teammate will get a WhatsApp link to accept.');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Team &amp; Permissions</h1>
          <p className="mt-1 text-sm text-muted-foreground">Who can access this business&apos;s Isola workspace.</p>
        </div>
        <Button size="sm" onClick={() => invite.run()} disabled={invite.state.phase === 'loading'}>
          <UserPlus className="size-3.5" /> Invite teammate (mock)
        </Button>
      </div>

      <MockCtaStatus state={invite.state} />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {TEAM.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">{m.name}</TableCell>
                  <TableCell className="text-muted-foreground">{m.email}</TableCell>
                  <TableCell>
                    <Badge variant={roleVariant(m.role)}>{m.role}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">How roles are enforced</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Chatwoot Community Edition only distinguishes <span className="font-medium text-foreground">administrator</span>{' '}
          and <span className="font-medium text-foreground">agent</span> — it has no custom roles. Finer-grained
          permission (Owner vs. Manager vs. Agent, shown above) is actually enforced here, in Isola&apos;s control
          plane, not inside Chatwoot itself.
        </CardContent>
      </Card>
    </div>
  );
}
