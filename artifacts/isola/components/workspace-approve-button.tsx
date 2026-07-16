'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';

export function WorkspaceApproveButton({
  tenantId,
  action,
  requestId,
}: {
  tenantId: string;
  action: string;
  requestId: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenantId, action, request_id: requestId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? 'Approval failed');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach the approvals endpoint');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button size="sm" onClick={approve} disabled={loading} className="self-start">
        {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
        Approve
      </Button>
      {error && <Alert variant="destructive">{error}</Alert>}
    </div>
  );
}
