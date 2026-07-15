'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

export function CreateAgentButton({ tenantId }: { tenantId: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  async function createAgent() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/tenants/${tenantId}/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Failed');
        return;
      }
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button size="sm" onClick={createAgent} disabled={loading} className="self-start">
        <Plus className="size-3.5" /> {loading ? 'Creating…' : 'Create agent record'}
      </Button>
    </div>
  );
}
