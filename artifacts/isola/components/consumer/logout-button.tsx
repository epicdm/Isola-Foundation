'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ConsumerLogoutButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    try {
      await fetch('/api/consumer/auth/logout', { method: 'POST' });
      router.replace('/consumer/login');
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button variant="ghost" size="icon" onClick={handleLogout} disabled={loading} aria-label="Sign out">
      <LogOut className="size-4" />
    </Button>
  );
}
