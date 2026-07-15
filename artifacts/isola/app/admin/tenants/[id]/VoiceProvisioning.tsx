'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Phone } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface Props {
  tenantId: string;
  state: string;
  error: string | null;
  magnusUserId: string | null;
  sipId: string | null;
  sipUsername: string | null;
  didId: string | null;
  didNumber: string | null;
  diddestinationId: string | null;
  calleridId: string | null;
}

const stateVariant: Record<string, 'outline' | 'secondary' | 'default' | 'destructive'> = {
  none: 'outline',
  pending: 'secondary',
  completed: 'default',
  failed: 'destructive',
};

export function VoiceProvisioning({
  tenantId,
  state,
  error,
  magnusUserId,
  sipId,
  sipUsername,
  didId,
  didNumber,
  diddestinationId,
  calleridId,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState('');
  const router = useRouter();

  async function provision() {
    setLoading(true);
    setLocalError('');
    try {
      const res = await fetch(`/api/admin/tenants/${tenantId}/provision-voice`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setLocalError(data.error ?? 'Provisioning failed');
      }
      router.refresh();
    } catch (e: any) {
      setLocalError(e?.message ?? 'Provisioning failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Phone className="size-4" /> Voice (Magnus PBX)
        </CardTitle>
        <Badge variant={stateVariant[state] ?? 'outline'}>{state}</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Row label="Magnus user" value={magnusUserId ?? '—'} mono />
          <Row label="SIP id / username" value={sipId ? `${sipId} / ${sipUsername}` : '—'} mono />
          <Row label="DID" value={didId ? `${didNumber} (id ${didId})` : '—'} mono />
          <Row label="DID destination" value={diddestinationId ?? '—'} mono />
          <Row label="Caller ID" value={calleridId ?? '—'} mono />
        </div>

        {(error || localError) && (
          <Alert variant="destructive">
            <AlertDescription>{localError || error}</AlertDescription>
          </Alert>
        )}

        <Button size="sm" onClick={provision} disabled={loading} className="self-start">
          {loading ? 'Provisioning…' : state === 'completed' ? 'Re-check / re-run' : 'Provision voice'}
        </Button>
      </CardContent>
    </Card>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? 'break-all text-right font-mono text-[11px]' : 'text-right'}>{value}</span>
    </div>
  );
}
