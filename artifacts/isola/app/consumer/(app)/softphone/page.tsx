'use client';

import { useState, useEffect, useMemo } from 'react';
import QRCode from 'qrcode';
import { Download, Wand2, QrCode, PhoneOff } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

type Platform = 'ios' | 'android' | 'other';

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

const STORE_LINKS: Record<'ios' | 'android', { label: string; href: string }> = {
  ios: { label: 'App Store — Cloud Softphone', href: 'https://apps.apple.com/us/app/cloud-softphone/id567475545' },
  android: { label: 'Play Store — Cloud Softphone', href: 'https://play.google.com/store/apps/details?id=cz.acrobits.softphone.cloudphone' },
};

interface LineInfo {
  state: string;
  error: string | null;
  sip_username: string | null;
  sip_password: string | null;
  did_number: string | null;
  registration_server: string;
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={mono ? 'break-all text-right font-mono text-xs' : 'break-all text-right'}>{value}</span>
    </div>
  );
}

function StepTag({ children, tone }: { children: React.ReactNode; tone: 'first' | 'recommended' | 'optional' }) {
  const styles: Record<typeof tone, string> = {
    first: 'bg-primary/15 text-primary',
    recommended: 'bg-primary text-primary-foreground',
    optional: 'bg-muted text-muted-foreground',
  } as const;
  return <span className={cn('ema-pill rounded-full px-2.5 py-1 text-[11px] font-bold', styles[tone])}>{children}</span>;
}

function StepShell({
  index,
  title,
  tag,
  tagTone,
  muted,
  children,
}: {
  index: number;
  title: string;
  tag: string;
  tagTone: 'first' | 'recommended' | 'optional';
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'ema-card ema-shadow flex flex-col gap-3 border border-border bg-card p-4',
        muted && 'opacity-90',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 font-display text-sm font-extrabold text-primary">
            {index}
          </div>
          <span className="font-display text-sm font-extrabold">{title}</span>
        </div>
        <StepTag tone={tagTone}>{tag}</StepTag>
      </div>
      {children}
    </div>
  );
}

export default function ConsumerSoftphonePage() {
  const [line, setLine] = useState<LineInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const platform = useMemo(detectPlatform, []);

  useEffect(() => {
    fetch('/api/consumer/voice/line')
      .then((r) => r.json())
      .then((d: LineInfo) => setLine(d))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (line?.sip_username && line?.sip_password) {
      const cscUrl = `csc:${line.sip_username}:${line.sip_password}@EPIC.VOICE.LITE`;
      QRCode.toDataURL(cscUrl, { width: 240, margin: 1 })
        .then(setQrDataUrl)
        .catch(console.error);
    }
  }, [line?.sip_username, line?.sip_password]);

  const cscUrl = line?.sip_username && line?.sip_password
    ? `csc:${line.sip_username}:${line.sip_password}@EPIC.VOICE.LITE`
    : null;

  const ready = !loading && line?.state === 'completed';

  return (
    <div className="flex flex-col gap-4">
      <div className="ema-rise ema-rise-1">
        <h1 className="font-display text-xl font-extrabold tracking-tight">Softphone setup</h1>
        <p className="text-sm text-muted-foreground">Three quick steps — download, configure, and you're set.</p>
      </div>

      {!loading && line && line.state !== 'completed' && (
        <div className="ema-rise ema-rise-1 ema-card flex flex-col items-center gap-2 border border-dashed border-border bg-card/50 px-4 py-8 text-center text-muted-foreground">
          <PhoneOff className="size-8 opacity-40" />
          <p className="text-sm">
            {line.state === 'pending'
              ? 'Your line is still being set up — check back shortly.'
              : line.state === 'failed'
              ? `Setup failed: ${line.error ?? 'unknown error'}.`
              : 'Your line has not been set up yet.'}
          </p>
        </div>
      )}

      {/* Step 1 — Download first */}
      <div className="ema-rise ema-rise-2">
        <StepShell index={1} title="Download the app" tag="Do this first" tagTone="first">
          <p className="text-sm text-muted-foreground">
            Calls happen in Cloud Softphone (Acrobits), not in this browser tab — install it first.
          </p>
          {platform === 'ios' || platform === 'android' ? (
            <a
              href={STORE_LINKS[platform].href}
              target="_blank"
              rel="noreferrer"
              className="ema-interactive ema-btn flex items-center justify-center gap-2 bg-primary/10 px-4 py-2.5 text-sm font-bold text-primary"
            >
              <Download className="size-4" />
              {STORE_LINKS[platform].label}
            </a>
          ) : (
            <div className="flex gap-2">
              <a
                href={STORE_LINKS.ios.href}
                target="_blank"
                rel="noreferrer"
                className="ema-interactive ema-btn flex flex-1 items-center justify-center gap-2 border border-border px-4 py-2.5 text-sm font-bold"
              >
                App Store
              </a>
              <a
                href={STORE_LINKS.android.href}
                target="_blank"
                rel="noreferrer"
                className="ema-interactive ema-btn flex flex-1 items-center justify-center gap-2 border border-border px-4 py-2.5 text-sm font-bold"
              >
                Google Play
              </a>
            </div>
          )}
        </StepShell>
      </div>

      {/* Step 2 — Configure automatically (primary) */}
      <div className="ema-rise ema-rise-3">
        <StepShell index={2} title="Configure automatically" tag="Recommended" tagTone="recommended">
          {loading ? (
            <Skeleton className="h-11 w-full" />
          ) : ready && cscUrl ? (
            <a
              href={cscUrl}
              className="ema-interactive ema-btn flex items-center justify-center gap-2 bg-primary px-4 py-3 text-sm font-bold text-primary-foreground"
            >
              <Wand2 className="size-4" />
              Configure automatically
            </a>
          ) : (
            <p className="text-sm text-muted-foreground">Available once your line finishes setting up.</p>
          )}
          <p className="text-xs text-muted-foreground">
            Tap this on the same phone where you just installed Cloud Softphone — one tap and you're configured.
          </p>
          {ready && (
            <div className="flex flex-col gap-1.5 border-t border-border pt-3">
              <InfoRow label="SIP username" value={line?.sip_username ?? '—'} mono />
              <InfoRow label="SIP password" value={line?.sip_password ?? '—'} mono />
              <InfoRow label="Registration server" value={line?.registration_server ?? '—'} mono />
            </div>
          )}
        </StepShell>
      </div>

      {/* Step 3 — Scan from another device (optional, muted) */}
      <div className="ema-rise ema-rise-4">
        <StepShell index={3} title="Or scan from another device" tag="Optional" tagTone="optional" muted>
          <p className="text-sm text-muted-foreground">
            Setting up a tablet or a second phone? Scan this from Cloud Softphone on that device instead.
          </p>
          {loading ? (
            <div className="flex justify-center">
              <Skeleton className="h-40 w-40 rounded-lg" />
            </div>
          ) : ready && qrDataUrl ? (
            <div className="flex flex-col items-center gap-2">
              <div className="rounded-lg border border-border bg-white p-3">
                <img src={qrDataUrl} alt="Scan to set up softphone" width={180} height={180} />
              </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <QrCode className="size-3" />
                Scan with Cloud Softphone's QR scanner
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">QR code will appear once your line is ready.</p>
          )}
        </StepShell>
      </div>
    </div>
  );
}
