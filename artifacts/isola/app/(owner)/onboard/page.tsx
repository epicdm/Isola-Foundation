'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Smartphone, Settings, ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert } from '@/components/ui/alert';

export default function OnboardPage() {
  const [mode, setMode] = useState<'choice' | 'manual'>('choice');
  const [form, setForm] = useState({
    phone_number_id: '',
    waba_id: '',
    phone_number: '',
    access_token: '',
    display_name: '',
    coex_mode: true,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/onboard/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Failed'); return; }
      router.push('/dashboard');
    } finally {
      setLoading(false);
    }
  }

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const val = key === 'coex_mode' ? (e.target as HTMLInputElement).checked : e.target.value;
      setForm((f) => ({ ...f, [key]: val }));
    };
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Connect WhatsApp</h1>
        <p className="text-muted-foreground text-sm mt-1">Link a WhatsApp Business number to your AI agent.</p>
      </div>

      {mode === 'choice' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 max-w-2xl">
          {/* Meta Embedded Signup */}
          <Card
            className="cursor-pointer hover:border-primary/60 transition-colors"
            onClick={() => {
              // Meta Embedded Signup — FB SDK
              if (typeof window !== 'undefined' && (window as any).FB) {
                (window as any).FB.login(
                  (res: any) => {
                    if (res.authResponse) {
                      // Exchange for long-lived token via your backend if needed.
                      // For now, guide user to manual entry with the returned data.
                      alert('Meta signup complete. Please enter your phone number details manually below.');
                      setMode('manual');
                    }
                  },
                  {
                    config_id: process.env.NEXT_PUBLIC_META_APP_ID ?? '',
                    response_type: 'code',
                    override_default_response_type: true,
                  },
                );
              } else {
                alert('Meta SDK not loaded. Use manual entry below.');
                setMode('manual');
              }
            }}
          >
            <CardHeader className="pb-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 mb-2">
                <Smartphone className="h-5 w-5 text-primary" />
              </div>
              <CardTitle className="text-base">Meta Embedded Signup</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">Connect in 3 clicks via Facebook&apos;s guided setup.</p>
              <Button size="sm">Start →</Button>
            </CardContent>
          </Card>

          {/* Manual entry */}
          <Card
            className="cursor-pointer hover:border-primary/60 transition-colors"
            onClick={() => setMode('manual')}
          >
            <CardHeader className="pb-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted mb-2">
                <Settings className="h-5 w-5 text-muted-foreground" />
              </div>
              <CardTitle className="text-base">Manual entry</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-4">You already have a phone_number_id and access token from Meta.</p>
              <Button variant="outline" size="sm">Enter details →</Button>
            </CardContent>
          </Card>
        </div>
      )}

      {mode === 'manual' && (
        <form onSubmit={handleSubmit} className="max-w-lg space-y-5">
          {error && (
            <Alert variant="destructive">{error}</Alert>
          )}

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-base">Phone Number Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="phone_number_id">Phone Number ID *</Label>
                <Input
                  id="phone_number_id"
                  value={form.phone_number_id}
                  onChange={set('phone_number_id')}
                  placeholder="e.g. 234567890123456"
                  required
                />
                <p className="text-xs text-muted-foreground">Found in Meta Business Manager → WhatsApp → Phone numbers</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="waba_id">WABA ID *</Label>
                <Input
                  id="waba_id"
                  value={form.waba_id}
                  onChange={set('waba_id')}
                  placeholder="WhatsApp Business Account ID"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="phone_number">Phone Number (E.164) *</Label>
                <Input
                  id="phone_number"
                  value={form.phone_number}
                  onChange={set('phone_number')}
                  placeholder="+17678181234"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="display_name">Display Name</Label>
                <Input
                  id="display_name"
                  value={form.display_name}
                  onChange={set('display_name')}
                  placeholder="My Business Name"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="access_token">Access Token *</Label>
                <Input
                  id="access_token"
                  type="password"
                  value={form.access_token}
                  onChange={set('access_token')}
                  placeholder="Long-lived user access token"
                  required
                />
                <p className="text-xs text-muted-foreground">Generate a permanent (never-expiring) system user token in Meta Business Manager.</p>
              </div>
              <div className="flex items-center gap-3 pt-1">
                <Switch
                  id="coex_mode"
                  checked={form.coex_mode}
                  onCheckedChange={(checked) => setForm((f) => ({ ...f, coex_mode: checked }))}
                />
                <div>
                  <Label htmlFor="coex_mode" className="text-sm font-semibold cursor-pointer">Coexistence mode</Label>
                  <p className="text-xs text-muted-foreground">Keep the WhatsApp Business app working alongside the AI agent.</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="flex gap-3">
            <Button type="submit" disabled={loading}>
              {loading ? 'Connecting…' : 'Connect number'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setMode('choice')}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back
            </Button>
          </div>
        </form>
      )}

      {/* Meta FB SDK — loads asynchronously */}
      <script
        dangerouslySetInnerHTML={{
          __html: `
            window.fbAsyncInit = function() {
              FB.init({ appId: '${process.env.NEXT_PUBLIC_META_APP_ID ?? ''}', version: 'v21.0' });
            };
            (function(d,s,id){var js,fjs=d.getElementsByTagName(s)[0];if(d.getElementById(id)){return;}js=d.createElement(s);js.id=id;js.src="https://connect.facebook.net/en_US/sdk.js";fjs.parentNode.insertBefore(js,fjs);}(document,'script','facebook-jssdk'));
          `,
        }}
      />
    </>
  );
}
