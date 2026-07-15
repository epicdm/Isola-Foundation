'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, CheckCircle2 } from 'lucide-react';

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

export function NewTenantForm() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ business_name: '', plan: 'starter', owner_email: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<{ tenant_id: string; agent_id: string; business_name: string } | null>(null);
  const router = useRouter();

  function set(k: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/tenants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Failed');
        return;
      }
      setCreated({ tenant_id: data.tenant.id, agent_id: data.agent.id, business_name: data.tenant.business_name });
      setForm({ business_name: '', plan: 'starter', owner_email: '' });
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  if (created) {
    return (
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="text-sm">Tenant created</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Alert>
            <CheckCircle2 className="size-4" />
            <AlertDescription>
              <strong>{created.business_name}</strong> is live. Foundation ids for wiring (e.g. Flowise
              governance adapter):
            </AlertDescription>
          </Alert>
          <div className="flex flex-col gap-1.5 text-sm">
            <div>
              <span className="text-muted-foreground">Tenant id: </span>
              <span className="font-mono">{created.tenant_id}</span>
            </div>
            <div>
              <span className="text-muted-foreground">Agent id: </span>
              <span className="font-mono">{created.agent_id}</span>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setCreated(null);
                setOpen(false);
              }}
            >
              Done
            </Button>
            <Button variant="ghost" onClick={() => setCreated(null)}>
              Onboard another
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" /> Onboard new tenant
      </Button>
    );
  }

  return (
    <Card className="max-w-lg">
      <CardHeader>
        <CardTitle className="text-sm">Onboard new tenant</CardTitle>
      </CardHeader>
      <CardContent>
        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="business_name">Business name *</Label>
            <Input
              id="business_name"
              value={form.business_name}
              onChange={set('business_name')}
              placeholder="Acme Corp"
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="plan">Plan</Label>
            <Select value={form.plan} onValueChange={(v) => setForm((f) => ({ ...f, plan: v }))}>
              <SelectTrigger id="plan">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="starter">Starter — EC$39/mo</SelectItem>
                <SelectItem value="growth">Growth — EC$89/mo</SelectItem>
                <SelectItem value="pro">Pro — EC$179/mo</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="owner_email">Owner email (optional)</Label>
            <Input
              id="owner_email"
              type="email"
              value={form.owner_email}
              onChange={set('owner_email')}
              placeholder="owner@example.com"
            />
            <p className="text-xs text-muted-foreground">
              If supplied, this user will be auto-linked when they sign in for the first time.
            </p>
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={loading}>
              {loading ? 'Creating…' : 'Create tenant'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
