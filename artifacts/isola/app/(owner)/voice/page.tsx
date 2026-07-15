'use client';

import { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { Phone, PhoneIncoming, PhoneOutgoing, PhoneOff, Smartphone, QrCode } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface Call {
  id: string;
  direction: string;
  src: string;
  dst: string;
  billsec: number;
  disposition: string;
  call_date: string;
}

interface LineInfo {
  state: string;
  error: string | null;
  sip_username: string | null;
  sip_password: string | null;
  did_number: string | null;
  registration_server: string;
  forward_to_cell: boolean;
  cell_number: string | null;
}

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatDid(did: string): string {
  // 1767818xxxx -> +1 (767) 818-xxxx
  const d = did.replace(/^1/, '');
  if (d.length !== 10) return `+${did}`;
  return `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export default function VoicePage() {
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(true);

  const [line, setLine] = useState<LineInfo | null>(null);
  const [lineLoading, setLineLoading] = useState(true);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [cellNumber, setCellNumber] = useState('');
  const [forwardLoading, setForwardLoading] = useState(false);
  const [forwardError, setForwardError] = useState('');

  useEffect(() => {
    fetch('/api/voice/calls?limit=50')
      .then((r) => r.json())
      .then((d) => {
        setCalls(d.calls ?? []);
        setConfigured(d.magnus_configured ?? false);
      })
      .catch(console.error)
      .finally(() => setLoading(false));

    fetch('/api/voice/line')
      .then((r) => r.json())
      .then((d: LineInfo) => {
        setLine(d);
        setCellNumber(d.cell_number ?? '');
      })
      .catch(console.error)
      .finally(() => setLineLoading(false));
  }, []);

  useEffect(() => {
    if (line?.sip_username && line?.sip_password) {
      const cscUrl = `csc:${line.sip_username}:${line.sip_password}@EPIC.VOICE.LITE`;
      QRCode.toDataURL(cscUrl, { width: 220, margin: 1 })
        .then(setQrDataUrl)
        .catch(console.error);
    }
  }, [line?.sip_username, line?.sip_password]);

  async function toggleForward(nextForward: boolean) {
    setForwardError('');
    if (nextForward && !cellNumber.trim()) {
      setForwardError('Enter a cell number before enabling forward-to-cell.');
      return;
    }
    setForwardLoading(true);
    try {
      const res = await fetch('/api/voice/forward', {
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

  const dispositionVariant = (d: string): 'default' | 'secondary' | 'destructive' | 'outline' => {
    if (d === 'ANSWERED') return 'default';
    if (d === 'BUSY') return 'secondary';
    return 'destructive';
  };

  const cscUrl = line?.sip_username && line?.sip_password
    ? `csc:${line.sip_username}:${line.sip_password}@EPIC.VOICE.LITE`
    : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Voice</h1>
        <p className="text-sm text-muted-foreground">Your phone line, softphone setup, and recent calls.</p>
      </div>

      {/* Your line card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Phone className="size-4" />
            Your Line
          </CardTitle>
        </CardHeader>
        <CardContent>
          {lineLoading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-5 w-64" />
              <Skeleton className="h-5 w-56" />
            </div>
          ) : !line || line.state !== 'completed' ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground">
              <PhoneOff className="size-8 opacity-40" />
              <p className="text-sm">
                {line?.state === 'pending'
                  ? 'Your voice line is being provisioned — check back shortly.'
                  : line?.state === 'failed'
                  ? `Provisioning failed: ${line.error ?? 'unknown error'}. Contact support.`
                  : 'Your voice line has not been provisioned yet. Contact your administrator.'}
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap gap-8">
              {/* SIP details */}
              <div className="flex flex-1 flex-col gap-4 min-w-[260px]">
                <div className="grid gap-2">
                  <InfoRow label="Your number" value={line.did_number ? formatDid(line.did_number) : '—'} />
                  <InfoRow label="SIP username" value={line.sip_username ?? '—'} mono />
                  <InfoRow label="SIP password" value={line.sip_password ?? '—'} mono />
                  <InfoRow label="Registration server" value={line.registration_server} mono />
                </div>

                {cscUrl && (
                  <Button asChild size="sm" className="self-start">
                    <a href={cscUrl}>
                      <Smartphone className="size-4" />
                      Open in Acrobits softphone
                    </a>
                  </Button>
                )}

                <Separator />

                {/* Forward to cell */}
                <div className="flex flex-col gap-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Forward to Cell</p>
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
                      checked={line.forward_to_cell}
                      disabled={forwardLoading}
                      onCheckedChange={(checked) => toggleForward(checked)}
                    />
                    <Label htmlFor="forwardToggle" className="cursor-pointer">
                      {line.forward_to_cell ? 'Forwarding to cell' : 'Ringing SIP phone'}
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Currently routing to: <strong>{line.forward_to_cell ? (line.cell_number || 'cell') : 'SIP extension'}</strong>
                  </p>
                </div>
              </div>

              {/* QR code */}
              {qrDataUrl && (
                <div className="flex flex-col items-center gap-2">
                  <div className="rounded-lg border bg-white p-3">
                    <img src={qrDataUrl} alt="Scan to set up softphone" width={200} height={200} />
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <QrCode className="size-3" />
                    Scan with your phone to set up Acrobits
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Call history */}
      <div className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Call History</h2>

        {!configured && (
          <Alert>
            <AlertDescription>
              Magnus is not configured — set MAGNUS_URL, MAGNUS_API_KEY, MAGNUS_API_SECRET to see call records.
            </AlertDescription>
          </Alert>
        )}

        {loading ? (
          <Card>
            <CardContent className="pt-6">
              <div className="flex flex-col gap-3">
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            </CardContent>
          </Card>
        ) : calls.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
              <Phone className="size-8 opacity-40" />
              <p className="text-sm">{configured ? 'No calls found.' : 'Configure Magnus to see call records.'}</p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Direction</TableHead>
                    <TableHead>From</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {calls.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <Badge variant={dispositionVariant(c.disposition)}>{c.disposition}</Badge>
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          {c.direction === 'inbound'
                            ? <><PhoneIncoming className="size-3" /> In</>
                            : <><PhoneOutgoing className="size-3" /> Out</>}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{c.src}</TableCell>
                      <TableCell className="font-mono text-xs">{c.dst}</TableCell>
                      <TableCell>{c.billsec > 0 ? formatDuration(c.billsec) : '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{new Date(c.call_date).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className={mono ? 'font-mono text-xs text-right break-all' : 'text-right break-all'}>{value}</span>
    </div>
  );
}
