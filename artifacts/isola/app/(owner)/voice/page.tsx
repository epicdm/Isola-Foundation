'use client';

import { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { Phone, PhoneIncoming, PhoneOutgoing, PhoneOff, Smartphone, QrCode, ShieldAlert, Eye, EyeOff } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
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

/** Wire shape for GET/POST /api/voice/routing — the canonical S5 routing
 *  control API. Mirrors lib/voice-routing-service.ts's response shapes but is
 *  hand-declared (not imported) to keep this client component decoupled from
 *  server-only modules, matching this file's existing LineInfo convention. */
type RoutingMode = 'app' | 'app_then_cell' | 'cell';
type RoutingReadMode = RoutingMode | 'degraded' | 'unknown';

interface RoutingState {
  mode: RoutingReadMode;
  forward_to_cell_number: string | null;
  reason?: string;
}

interface RoutingCritical {
  voiceLineId: string;
  did: string;
  requestedMode: RoutingMode;
  beforeMode: RoutingReadMode;
  observedAfterMode: RoutingReadMode;
  rollbackAttempted: boolean;
  rollbackVerified: boolean;
  operatorActionRequired: true;
}

interface RoutingErrorBody {
  error: string;
  outcome?: string;
  critical?: RoutingCritical;
  rollbackAttempted?: boolean;
  rollbackVerified?: boolean;
  operatorActionRequired?: true;
}

interface RoutingResult {
  ok: boolean;
  message: string;
  rollbackAttempted?: boolean;
  rollbackVerified?: boolean;
  critical?: RoutingCritical;
}

const ROUTING_MODE_OPTIONS: { value: RoutingMode; label: string; description: string }[] = [
  { value: 'app', label: 'App only', description: 'Rings your SIP softphone. No fallback.' },
  { value: 'app_then_cell', label: 'App, then cell', description: 'Rings SIP first, falls back to your cell after the ring timeout.' },
  { value: 'cell', label: 'Cell only', description: 'Rings your cell number immediately.' },
];

function modeLabel(mode: RoutingReadMode): string {
  return ROUTING_MODE_OPTIONS.find((o) => o.value === mode)?.label ?? (mode === 'degraded' ? 'Degraded' : 'Unknown');
}

function maskFallbackNumber(num: string | null): string {
  if (!num) return '—';
  const digits = num.replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  return `•••-•••-${digits.slice(-4)}`;
}

// GOLDEN-STANDARD FIX: SIP credentials are secrets and were previously shown in plaintext
// with no way to hide them. Mask by default; a reveal toggle shows the real value.
function maskSecret(v: string): string {
  if (v.length <= 4) return '•'.repeat(v.length);
  return v.slice(0, 2) + '•'.repeat(Math.max(4, v.length - 4)) + v.slice(-2);
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
  const [revealSip, setRevealSip] = useState(false);

  const [routing, setRouting] = useState<RoutingState | null>(null);
  const [routingLoading, setRoutingLoading] = useState(true);
  const [routingLoadError, setRoutingLoadError] = useState('');
  const [routingSaving, setRoutingSaving] = useState(false);
  const [routingResult, setRoutingResult] = useState<RoutingResult | null>(null);

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
        setCellNumber((prev) => prev || (d.cell_number ?? ''));
      })
      .catch(console.error)
      .finally(() => setLineLoading(false));

    fetch('/api/voice/routing')
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? 'Failed to load routing state');
        return d as RoutingState;
      })
      .then((d) => {
        setRouting(d);
        setCellNumber((prev) => prev || (d.forward_to_cell_number ?? ''));
      })
      .catch((e: unknown) => setRoutingLoadError(e instanceof Error ? e.message : 'Failed to load routing state'))
      .finally(() => setRoutingLoading(false));
  }, []);

  useEffect(() => {
    if (line?.sip_username && line?.sip_password) {
      const cscUrl = `csc:${line.sip_username}:${line.sip_password}@EPIC.VOICE.LITE`;
      QRCode.toDataURL(cscUrl, { width: 220, margin: 1 })
        .then(setQrDataUrl)
        .catch(console.error);
    }
  }, [line?.sip_username, line?.sip_password]);

  async function setRoutingMode(mode: RoutingMode) {
    setRoutingResult(null);
    if (mode !== 'app' && !cellNumber.trim()) {
      setRoutingResult({ ok: false, message: 'Enter a fallback cell number before selecting this mode.' });
      return;
    }
    setRoutingSaving(true);
    try {
      const res = await fetch('/api/voice/routing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, forward_number: cellNumber.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        const body = data as RoutingErrorBody;
        setRoutingResult({
          ok: false,
          message: body.error ?? 'Failed to update routing',
          rollbackAttempted: body.rollbackAttempted,
          rollbackVerified: body.rollbackVerified,
          critical: body.critical,
        });
        return;
      }
      setRouting((prev) => (prev ? { ...prev, mode: data.mode, forward_to_cell_number: data.forward_to_cell_number } : prev));
      setRoutingResult({ ok: true, message: `Routing set to ${modeLabel(data.mode)}.` });
    } catch (e: unknown) {
      setRoutingResult({ ok: false, message: e instanceof Error ? e.message : 'Failed to update routing' });
    } finally {
      setRoutingSaving(false);
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
                  <InfoRow label="SIP username" value={line.sip_username ? (revealSip ? line.sip_username : maskSecret(line.sip_username)) : '—'} mono />
                  <InfoRow label="SIP password" value={line.sip_password ? (revealSip ? line.sip_password : maskSecret(line.sip_password)) : '—'} mono />
                  <InfoRow label="Registration server" value={line.registration_server} mono />
                </div>
                <Button type="button" variant="ghost" size="sm" className="w-fit -mt-1 text-muted-foreground" onClick={() => setRevealSip((v) => !v)}>
                  {revealSip ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />} {revealSip ? 'Hide' : 'Show'} SIP credentials
                </Button>

                {cscUrl && (
                  <Button asChild size="sm" className="self-start">
                    <a href={cscUrl}>
                      <Smartphone className="size-4" />
                      Open in Acrobits softphone
                    </a>
                  </Button>
                )}

                <Separator />

                {/* Routing (S5 canonical control — /api/voice/routing) */}
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Routing</p>
                    {!routingLoading && routing && <RouteHealthBadge mode={routing.mode} />}
                  </div>

                  {routingLoading ? (
                    <Skeleton className="h-16 w-full" />
                  ) : routingLoadError ? (
                    <Alert variant="destructive">
                      <AlertDescription>{routingLoadError}</AlertDescription>
                    </Alert>
                  ) : routing ? (
                    <>
                      <ToggleGroup
                        type="single"
                        variant="outline"
                        value={ROUTING_MODE_OPTIONS.some((o) => o.value === routing.mode) ? routing.mode : undefined}
                        onValueChange={(v) => v && setRoutingMode(v as RoutingMode)}
                        disabled={routingSaving}
                        className="flex-wrap"
                      >
                        {ROUTING_MODE_OPTIONS.map((opt) => (
                          <ToggleGroupItem key={opt.value} value={opt.value} aria-label={opt.label} title={opt.description}>
                            {opt.label}
                          </ToggleGroupItem>
                        ))}
                      </ToggleGroup>

                      <div className="flex flex-col gap-1.5">
                        <Label htmlFor="cellNumber">Fallback cell number</Label>
                        <Input
                          id="cellNumber"
                          value={cellNumber}
                          onChange={(e) => setCellNumber(e.target.value)}
                          placeholder="+1767xxxxxxx"
                        />
                      </div>

                      <p className="text-xs text-muted-foreground">
                        Current mode: <strong>{modeLabel(routing.mode)}</strong> · Fallback: <strong>{maskFallbackNumber(routing.forward_to_cell_number)}</strong>
                        {routing.reason && <> · {routing.reason}</>}
                      </p>

                      {routingResult?.critical && (
                        <Alert variant="destructive" className="border-2">
                          <ShieldAlert className="size-4" />
                          <AlertTitle>Operator action required</AlertTitle>
                          <AlertDescription>
                            <p>
                              The routing change to <strong>{modeLabel(routingResult.critical.requestedMode)}</strong> could not be
                              completed or safely rolled back. Contact support before making further routing changes on this line.
                            </p>
                            <p className="mt-1 text-xs">
                              Before: {modeLabel(routingResult.critical.beforeMode)} · Observed after: {modeLabel(routingResult.critical.observedAfterMode)} ·
                              Rollback attempted: {routingResult.critical.rollbackAttempted ? 'yes' : 'no'} · Rollback verified:{' '}
                              {routingResult.critical.rollbackVerified ? 'yes' : 'no'}
                            </p>
                          </AlertDescription>
                        </Alert>
                      )}

                      {routingResult && !routingResult.critical && (
                        <Alert variant={routingResult.ok ? 'default' : 'destructive'}>
                          <AlertDescription>
                            {routingResult.message}
                            {routingResult.rollbackAttempted && (
                              <> — {routingResult.rollbackVerified ? 'the line was safely restored to its previous state.' : 'rollback could not be verified.'}</>
                            )}
                          </AlertDescription>
                        </Alert>
                      )}
                    </>
                  ) : null}
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

        {/* GOLDEN-STANDARD FIX: previously read "Magnus is not configured — set MAGNUS_URL,
            MAGNUS_API_KEY, MAGNUS_API_SECRET" — exposed the internal engine name and raw
            env var names directly to the customer. Replaced with plain, actionable copy. */}
        {!configured && (
          <Alert>
            <AlertDescription>
              Call history isn't set up yet for this line. Contact support to finish connecting it.
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
              <p className="text-sm">{configured ? 'No calls found.' : 'Call history isn\'t set up yet — contact support.'}</p>
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

function RouteHealthBadge({ mode }: { mode: RoutingReadMode }) {
  if (mode === 'degraded') return <Badge variant="destructive">Degraded</Badge>;
  if (mode === 'unknown') return <Badge variant="outline">Unknown</Badge>;
  return <Badge variant="secondary">Healthy</Badge>;
}
