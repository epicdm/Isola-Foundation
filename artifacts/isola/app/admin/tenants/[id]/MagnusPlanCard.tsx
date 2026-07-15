'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface RatePlan {
  id: string;
  name: string;
}

export function MagnusPlanCard({ tenantId, magnusUserId }: { tenantId: string; magnusUserId: string | null }) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [plans, setPlans] = useState<RatePlan[]>([]);
  const [currentPlanId, setCurrentPlanId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');

  useEffect(() => {
    if (!magnusUserId) {
      setLoading(false);
      return;
    }
    fetch(`/api/admin/tenants/${tenantId}/magnus-plan`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
          return;
        }
        setPlans(data.plans ?? []);
        setCurrentPlanId(data.id_plan ?? null);
        setSelected(data.id_plan ?? '');
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [tenantId, magnusUserId]);

  async function submit() {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const request_id = crypto.randomUUID();
      const res = await fetch(`/api/admin/tenants/${tenantId}/magnus-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_plan: selected, request_id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Failed to change plan');
        return;
      }
      setCurrentPlanId(selected);
      setSuccess('Magnus rate plan updated.');
      setConfirming(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const currentPlanName = plans.find((p) => p.id === currentPlanId)?.name;
  const selectedPlanName = plans.find((p) => p.id === selected)?.name;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Magnus rate plan</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!magnusUserId ? (
          <p className="text-sm text-muted-foreground">No linked Magnus account — nothing to bill under a plan yet.</p>
        ) : loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {success && (
              <Alert>
                <AlertDescription>{success}</AlertDescription>
              </Alert>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Current plan</span>
              <span className="font-medium">{currentPlanName ?? currentPlanId ?? '—'}</span>
            </div>
            <div className="flex items-end gap-2">
              <Select
                value={selected}
                onValueChange={(v) => {
                  setSelected(v);
                  setConfirming(false);
                }}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Select a plan" />
                </SelectTrigger>
                <SelectContent>
                  {plans.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!confirming ? (
                <Button size="sm" variant="secondary" disabled={!selected || selected === currentPlanId} onClick={() => setConfirming(true)}>
                  Change
                </Button>
              ) : null}
            </div>
            {confirming && (
              <>
                <Alert>
                  <AlertDescription>
                    Confirm: move this tenant from <strong>{currentPlanName ?? currentPlanId}</strong> to{' '}
                    <strong>{selectedPlanName ?? selected}</strong>? This changes the sell rates applied to every future call immediately.
                  </AlertDescription>
                </Alert>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setConfirming(false)} disabled={saving}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={submit} disabled={saving}>
                    {saving ? 'Saving…' : 'Confirm & save'}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
