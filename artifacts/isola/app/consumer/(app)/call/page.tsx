'use client';

import { Suspense, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { PhoneCall, PhoneOff, Loader2, CheckCircle2, XCircle, Wallet as WalletIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

type Phase = 'idle' | 'starting' | 'ringing' | 'answered' | 'ended' | 'failed';

interface CallStateEvent {
  event?: string;
  [key: string]: unknown;
}

// Maps the BFF's SSE event names to this feature's own phase model. Unknown
// events (including our own proxy's synthetic "stream_error") are ignored
// rather than treated as terminal, so a transient drop degrades to "keep
// waiting for reconnect" instead of a false failure — see the call-state
// route's file header for the production incident this fixed.
function phaseForEvent(eventName: string | undefined, prev: Phase): Phase {
  switch (eventName) {
    case 'ringing':
      return 'ringing';
    case 'answered':
    case 'bridged':
    case 'connected_call': // distinct from the stream-level "connected" event
      return 'answered';
    case 'hangup':
    case 'completed':
      return 'ended';
    case 'timeout':
    case 'failed':
    case 'busy':
    case 'no-answer':
      return 'failed';
    default:
      return prev;
  }
}

// Overall safety net: if we never receive a terminal event within this
// window, stop waiting rather than leaving the UI spinning forever.
const CALL_STATE_MAX_WAIT_MS = 3 * 60_000;

export default function ConsumerCallPage() {
  return (
    <Suspense fallback={null}>
      <ConsumerCallPageInner />
    </Suspense>
  );
}

function ConsumerCallPageInner() {
  const searchParams = useSearchParams();
  // Optional one-tap-redial prefill from Home's "Callback" tile / recent-call
  // rows (?destination=...) — still requires the same manual confirm step
  // below before anything is dialed or billed.
  const [destination, setDestination] = useState(() => searchParams.get('destination') ?? '');
  const [ownerPhone, setOwnerPhone] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<{ message: string; topUp?: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const maxWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeStream = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    if (maxWaitTimerRef.current) {
      clearTimeout(maxWaitTimerRef.current);
      maxWaitTimerRef.current = null;
    }
  }, []);

  function subscribeToCallState(callId: string) {
    closeStream();
    const es = new EventSource(`/api/consumer/voice/callback/call-state/${encodeURIComponent(callId)}`);
    eventSourceRef.current = es;

    // Safety net only — a transient drop should reconnect on its own (see
    // onerror below). If we truly never hear a terminal event in this
    // window, stop waiting instead of spinning forever.
    maxWaitTimerRef.current = setTimeout(() => {
      setPhase((prev) => (prev === 'ringing' || prev === 'answered' ? 'ended' : prev));
      closeStream();
    }, CALL_STATE_MAX_WAIT_MS);

    es.onmessage = (e) => {
      let parsed: CallStateEvent = {};
      try {
        parsed = JSON.parse(e.data);
      } catch {
        return;
      }
      setPhase((prev) => phaseForEvent(parsed.event, prev));
      if (parsed.event === 'hangup' || parsed.event === 'completed' || parsed.event === 'timeout' || parsed.event === 'failed') {
        closeStream();
      }
    };

    // Native EventSource auto-reconnects on a dropped connection as long as
    // we don't close() it ourselves — a mid-call network hiccup (proxy idle
    // timeout, upstream socket reset, etc.) should NOT be treated as the
    // call ending. We deliberately do nothing here beyond logging; the
    // maxWaitTimer above is the only thing allowed to give up.
    es.onerror = () => {
      console.warn('[call] call-state stream error — waiting for automatic reconnect');
    };
  }

  async function startCall() {
    setError(null);
    setPhase('starting');
    try {
      const res = await fetch('/api/consumer/voice/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destination }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setPhase('failed');
        setError({
          message: data.error ?? 'Could not start the call.',
          topUp: data.errorKind === 'insufficient_balance',
        });
        return;
      }

      setOwnerPhone(data.ownerPhone ?? null);
      setPhase('ringing');
      setConfirming(false);
      if (data.callId) subscribeToCallState(data.callId);
    } catch (e) {
      setPhase('failed');
      setError({ message: e instanceof Error ? e.message : 'Network error starting the call.' });
    }
  }

  function reset() {
    closeStream();
    setPhase('idle');
    setError(null);
    setConfirming(false);
  }

  const phaseCopy: Record<Phase, { label: string; icon: React.ReactNode }> = {
    idle: { label: '', icon: null },
    starting: { label: 'Starting call\u2026', icon: <Loader2 className="size-5 animate-spin" /> },
    ringing: { label: `Ringing ${ownerPhone ?? 'your number'}\u2026`, icon: <Loader2 className="size-5 animate-spin" /> },
    answered: { label: `Connecting you to ${destination}\u2026`, icon: <PhoneCall className="size-5 text-primary" /> },
    ended: { label: 'Call ended.', icon: <CheckCircle2 className="size-5 text-primary" /> },
    failed: { label: error?.message ?? 'Call failed.', icon: <XCircle className="size-5 text-destructive" /> },
  };

  const busy = phase === 'starting' || phase === 'ringing' || phase === 'answered';

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Call now</h1>
        <p className="text-sm text-muted-foreground">
          No app to install. We call your number first, then connect you \u2014 billed from your EMA balance.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <PhoneCall className="size-4" />
            Dial a Dominica number
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {phase === 'idle' || phase === 'failed' ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="destination">Destination (Dominica)</Label>
                <Input
                  id="destination"
                  inputMode="tel"
                  placeholder="767-XXX-XXXX"
                  value={destination}
                  onChange={(e) => {
                    setDestination(e.target.value);
                    setConfirming(false);
                    if (phase === 'failed') setError(null);
                  }}
                />
                <p className="text-xs text-muted-foreground">Only Dominica (+1 767) numbers are supported while we finish a carrier fix — more countries are coming soon.</p>
              </div>

              {error && (
                <Alert variant="destructive">
                  <AlertDescription className="flex flex-col gap-2">
                    <span>{error.message}</span>
                    {error.topUp && (
                      <Link href="/consumer/wallet" className="inline-flex w-fit items-center gap-1 text-xs font-medium underline">
                        <WalletIcon className="size-3" />
                        Top up to call
                      </Link>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              {!confirming ? (
                <Button
                  size="lg"
                  className="w-full"
                  disabled={!destination.trim()}
                  onClick={() => setConfirming(true)}
                >
                  <PhoneCall className="size-4" />
                  Call
                </Button>
              ) : (
                <div className="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3">
                  <p className="text-sm">
                    We&apos;ll ring your number first, then connect you to <strong>{destination}</strong>.
                  </p>
                  <div className="flex gap-2">
                    <Button variant="outline" className="flex-1" onClick={() => setConfirming(false)}>
                      Cancel
                    </Button>
                    <Button className="flex-1" onClick={startCall}>
                      Confirm & call
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center gap-4 py-6 text-center">
              <div className="flex flex-col items-center gap-2">
                {phaseCopy[phase].icon}
                <p className="text-sm font-medium">{phaseCopy[phase].label}</p>
              </div>
              {!busy && (
                <Button variant="outline" size="sm" onClick={reset}>
                  <PhoneOff className="size-4" />
                  Done
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
