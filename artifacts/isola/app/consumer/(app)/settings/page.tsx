'use client';

import { useState, useEffect } from 'react';
import { Phone, PhoneIncoming, PhoneOutgoing, PhoneMissed, Voicemail, Hash } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';

interface LineInfo {
  state: string;
  did_number: string | null;
  sip_username: string | null;
  forward_to_cell: boolean;
  cell_number: string | null;
}

interface Call {
  number: string;
  dir: 'in' | 'out' | 'missed';
  time: string;
  dur: string;
}

function formatDid(did: string): string {
  const d = did.replace(/^1/, '');
  if (d.length !== 10) return `+${did}`;
  return `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export default function ConsumerSettingsPage() {
  const [line, setLine] = useState<LineInfo | null>(null);
  const [lineLoading, setLineLoading] = useState(true);
  const [cellNumber, setCellNumber] = useState('');
  const [forwardLoading, setForwardLoading] = useState(false);
  const [forwardError, setForwardError] = useState('');

  const [calls, setCalls] = useState<Call[]>([]);
  const [callsLoading, setCallsLoading] = useState(true);
  const [magnusConfigured, setMagnusConfigured] = useState(true);

  useEffect(() => {
    fetch('/api/consumer/voice/line')
      .then((r) => r.json())
      .then((d: LineInfo) => {
        setLine(d);
        setCellNumber(d.cell_number ?? '');
      })
      .catch(console.error)
      .finally(() => setLineLoading(false));

    fetch('/api/consumer/voice/calls?limit=15')
      .then((r) => r.json())
      .then((d) => {
        setCalls(d.calls ?? []);
        setMagnusConfigured(d.magnus_configured ?? false);
      })
      .catch(console.error)
      .finally(() => setCallsLoading(false));
  }, []);

  async function toggleForward(nextForward: boolean) {
    setForwardError('');
    if (nextForward && !cellNumber.trim()) {
      setForwardError('Enter a cell number before enabling forward-to-cell.');
      return;
    }
    setForwardLoading(true);
    try {
      const res = await fetch('/api/consumer/voice/forward', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forward_to_cell: nextForward, cell_number: cellNumber.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setForwardError(data.error ?? 'Failed to update routing');
        return;
      }
      setLine((prev) => (prev ? { ...prev, forward_to_cell: data.forward_to_cell, cell_number: data.cell_number } : prev));
    } catch (e: unknown) {
      setForwardError(e instanceof Error ? e.message : 'Failed to update routing');
    } finally {
      setForwardLoading(false);
    }
  }

  const dirIcon = { in: PhoneIncoming, out: PhoneOutgoing, missed: PhoneMissed };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Call settings</h1>
        <p className="text-sm text-muted-foreground">Forwarding, voicemail, and your number.</p>
      </div>

      {/* Number */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Hash className="size-4" />
            Your number
          </CardTitle>
        </CardHeader>
        <CardContent>
          {lineLoading ? (
            <Skeleton className="h-6 w-40" />
          ) : (
            <div className="font-mono text-lg font-semibold">
              {line?.did_number ? formatDid(line.did_number) : 'Not assigned yet'}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Forward to cell */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Phone className="size-4" />
            Call forwarding
          </CardTitle>
        </CardHeader>
        <CardContent>
          {lineLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cellNumber">Fallback cell number</Label>
                <Input
                  id="cellNumber"
                  value={cellNumber}
                  onChange={(e) => setCellNumber(e.target.value)}
                  placeholder="+1767xxxxxxx"
                />
              </div>
              {forwardError && (
                <Alert variant="destructive">
                  <AlertDescription>{forwardError}</AlertDescription>
                </Alert>
              )}
              <div className="flex items-center gap-3">
                <Switch
                  id="forwardToggle"
                  checked={!!line?.forward_to_cell}
                  disabled={forwardLoading || !line || line.state !== 'completed'}
                  onCheckedChange={(checked) => toggleForward(checked)}
                />
                <Label htmlFor="forwardToggle" className="cursor-pointer">
                  {line?.forward_to_cell ? 'Forwarding to cell' : 'Ringing SIP extension'}
                </Label>
              </div>
              <p className="text-xs text-muted-foreground">
                Currently routing to: <strong>{line?.forward_to_cell ? (line.cell_number || 'cell') : 'your softphone'}</strong>
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Voicemail */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Voicemail className="size-4" />
            Voicemail
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Switch id="voicemailToggle" checked={false} disabled />
            <Label htmlFor="voicemailToggle" className="text-muted-foreground">
              Not available yet
            </Label>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Voicemail isn't wired up on your line's Magnus account yet — this control will turn on once that's provisioned.
          </p>
        </CardContent>
      </Card>

      {/* Recent calls */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Recent calls</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {callsLoading ? (
            <div className="flex flex-col gap-2 p-4">
              {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : !magnusConfigured || calls.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
              <Phone className="size-8 opacity-40" />
              <p className="text-sm">No calls yet.</p>
            </div>
          ) : (
            <div className="divide-y">
              {calls.map((c, i) => {
                const Icon = dirIcon[c.dir];
                return (
                  <div key={i} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Icon className={c.dir === 'missed' ? 'size-4 text-destructive' : 'size-4 text-muted-foreground'} />
                      <div className="flex flex-col">
                        <span className="font-mono text-sm">{c.number || '—'}</span>
                        <span className="text-xs text-muted-foreground">{c.time}</span>
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground">{c.dur || '—'}</span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
