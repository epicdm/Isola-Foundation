'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Props {
  tenantId: string;
  tenantName: string;
  currentPlan: string;
  currentStatus: string;
  isActingAs: boolean;
}

export function TenantActions({ tenantId, tenantName, currentPlan, currentStatus, isActingAs }: Props) {
  const [creditsForm, setCreditsForm] = useState({ amount: '', description: '' });
  const [planForm, setPlanForm] = useState({ plan: currentPlan });
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const router = useRouter();

  async function actAs() {
    setLoading('actas');
    try {
      await fetch(`/api/admin/tenants/${tenantId}/act-as`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !isActingAs }),
      });
      router.push(isActingAs ? '/admin' : '/dashboard');
    } finally {
      setLoading(null);
    }
  }

  async function adjustCredits(e: React.FormEvent) {
    e.preventDefault();
    setLoading('credits');
    setError('');
    setSuccess('');
    try {
      // A fresh request_id per submit — the backend uses it to dedupe retries
      // so a double-click or network retry never double-funds Magnus.
      const request_id = crypto.randomUUID();
      const res = await fetch(`/api/admin/tenants/${tenantId}/credits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: parseFloat(creditsForm.amount), description: creditsForm.description, request_id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Failed');
        return;
      }
      const magnusNote = data.magnus_synced
        ? ' (synced to Magnus voice balance)'
        : ' (local wallet only — no linked Magnus account)';
      setSuccess(`Done. New cached balance: ${data.new_balance_cache.toFixed(2)}${magnusNote}`);
      setCreditsForm({ amount: '', description: '' });
      router.refresh();
    } finally {
      setLoading(null);
    }
  }

  async function changePlan(e: React.FormEvent) {
    e.preventDefault();
    setLoading('plan');
    setError('');
    setSuccess('');
    try {
      const res = await fetch(`/api/admin/tenants/${tenantId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: planForm.plan }),
      });
      if (!res.ok) {
        setError('Failed to update plan');
        return;
      }
      setSuccess('Plan updated.');
      router.refresh();
    } finally {
      setLoading(null);
    }
  }

  async function toggleStatus() {
    setLoading('status');
    setError('');
    const newStatus = currentStatus === 'active' ? 'suspended' : 'active';
    try {
      await fetch(`/api/admin/tenants/${tenantId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      router.refresh();
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="flex min-w-[280px] flex-col gap-4">
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

      {/* Act-as */}
      <div className="flex flex-wrap gap-2">
        <Button variant={isActingAs ? 'destructive' : 'default'} onClick={actAs} disabled={loading === 'actas'}>
          {isActingAs ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          {loading === 'actas' ? '…' : isActingAs ? 'Exit act-as' : 'Act as this tenant'}
        </Button>
        <Button
          variant={currentStatus === 'active' ? 'destructive' : 'secondary'}
          size="sm"
          onClick={toggleStatus}
          disabled={loading === 'status'}
        >
          {currentStatus === 'active' ? 'Suspend' : 'Reactivate'}
        </Button>
      </div>

      {/* Change plan */}
      <form onSubmit={changePlan} className="flex flex-wrap items-end gap-2">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label>Plan</Label>
          <Select value={planForm.plan} onValueChange={(v) => setPlanForm({ plan: v })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="starter">Starter</SelectItem>
              <SelectItem value="growth">Growth</SelectItem>
              <SelectItem value="pro">Pro</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" variant="secondary" size="sm" disabled={loading === 'plan'}>
          {loading === 'plan' ? '…' : 'Save plan'}
        </Button>
      </form>

      {/* Credit adjustment */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Credit adjustment</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={adjustCredits} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="amount">Amount (positive = add, negative = debit)</Label>
              <Input
                id="amount"
                type="number"
                step="0.01"
                value={creditsForm.amount}
                onChange={(e) => setCreditsForm((f) => ({ ...f, amount: e.target.value }))}
                placeholder="e.g. 20 or -5"
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="description">Reason / description</Label>
              <Input
                id="description"
                value={creditsForm.description}
                onChange={(e) => setCreditsForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="e.g. Goodwill credit"
                required
              />
            </div>
            <Button type="submit" size="sm" disabled={loading === 'credits'} className="self-start">
              {loading === 'credits' ? 'Applying…' : 'Apply adjustment'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
