'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import {
  PhoneCall,
  PhoneMissed,
  PhoneIncoming,
  PhoneOutgoing,
  RotateCcw,
  Sparkles,
  MessageCircle,
  Send,
  ArrowUpCircle,
  Wallet as WalletIcon,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface LineInfo {
  state: string;
  error: string | null;
  did_number: string | null;
  forward_to_cell: boolean;
  cell_number: string | null;
}

interface Call {
  number: string;
  dir: 'in' | 'out' | 'missed';
  time: string;
  dur: string;
}

interface ChatAction {
  type: 'navigate_topup';
  amount: number;
}

// Same constants as the wallet page — kept in sync there:
// EC$ (XCD) fixed peg to US$ (USD), for the diaspora-facing "≈ US$" hint.
const EC_PER_USD = 2.7;
// EMA's own Dominica per-minute rate, for the "≈ N min to Dominica" hint —
// the only per-minute rate the client actually has (no rate-lookup API
// exists yet), so it's the only rate ever shown, and only for +1767 numbers.
const DOMINICA_MIN_RATE_EC = 0.135;

const ASSISTANT_CHIPS = ['Check my balance', 'Top up EC$25', 'Show my recent calls'];

function formatDid(did: string): string {
  const d = did.replace(/^1/, '');
  if (d.length !== 10) return `+${did}`;
  return `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** Best-effort region label derived from the number's dialing prefix — not
 * a contacts/CRM lookup (EMA has no address book yet), just a courtesy hint
 * so recent-call rows aren't bare digits. */
function guessRegion(rawNumber: string): string {
  const n = rawNumber.replace(/\D/g, '');
  const withoutCountry = n.startsWith('1') ? n.slice(1) : n;
  const npa = withoutCountry.slice(0, 3);
  const CARIBBEAN_NPA: Record<string, string> = {
    '767': 'Dominica',
    '268': 'Antigua & Barbuda',
    '246': 'Barbados',
    '473': 'Grenada',
    '758': 'St. Lucia',
    '784': 'St. Vincent',
    '869': 'St. Kitts & Nevis',
    '876': 'Jamaica',
    '868': 'Trinidad & Tobago',
    '649': 'Turks & Caicos',
  };
  if (CARIBBEAN_NPA[npa]) return CARIBBEAN_NPA[npa];
  if (n.startsWith('1') && n.length === 11) return 'US / Canada';
  if (n.startsWith('44')) return 'UK';
  return 'International';
}

function isDominicaNumber(rawNumber: string): boolean {
  const n = rawNumber.replace(/\D/g, '');
  return n.startsWith('1767') || n.startsWith('767');
}

const callMeta: Record<Call['dir'], { icon: typeof PhoneIncoming; label: string; className: string }> = {
  in: { icon: PhoneIncoming, label: 'Incoming', className: 'text-primary' },
  out: { icon: PhoneOutgoing, label: 'Outgoing', className: 'text-muted-foreground' },
  missed: { icon: PhoneMissed, label: 'Missed', className: 'text-destructive' },
};

export default function ConsumerHomePage() {
  const [line, setLine] = useState<LineInfo | null>(null);
  const [balance, setBalance] = useState<{ balance: number | null; currency: string } | null>(null);
  const [calls, setCalls] = useState<Call[]>([]);
  const [loading, setLoading] = useState(true);
  const [redialing, setRedialing] = useState(false);

  const [reply, setReply] = useState<{ text: string; actions?: ChatAction[] } | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState('');
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/consumer/voice/line').then((r) => r.json()),
      fetch('/api/consumer/wallet/balance').then((r) => r.json()),
      fetch('/api/consumer/voice/calls?limit=5').then((r) => r.json()),
    ])
      .then(([lineData, balData, callsData]) => {
        setLine(lineData);
        setBalance({ balance: balData.balance, currency: balData.currency ?? 'EC$' });
        setCalls(callsData.calls ?? []);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const usdEquivalent = balance?.balance != null ? balance.balance / EC_PER_USD : null;
  const dominicaMinutes = balance?.balance != null ? Math.floor(balance.balance / DOMINICA_MIN_RATE_EC) : null;
  const lastCall = calls[0] ?? null;

  async function redialLast() {
    if (!lastCall || redialing) return;
    setRedialing(true);
    try {
      window.location.href = `/consumer/call?destination=${encodeURIComponent(lastCall.number)}`;
    } finally {
      setRedialing(false);
    }
  }

  async function sendToAssistant(text: string) {
    const trimmed = text.trim();
    if (!trimmed || chatLoading) return;
    setChatLoading(true);
    setChatError('');
    setReply(null);
    setInput('');
    try {
      const res = await fetch('/api/consumer/assistant/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setChatError(data.error ?? 'Assistant is unavailable right now.');
        return;
      }
      setReply({ text: data.reply, actions: data.actions });
    } catch (e: unknown) {
      setChatError(e instanceof Error ? e.message : 'Failed to reach the assistant.');
    } finally {
      setChatLoading(false);
      requestAnimationFrame(() => scrollRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* ── LINE + BALANCE hero ─────────────────────────────────────── */}
      <div className="ema-rise ema-rise-1 ema-card ema-shadow ema-hero-gradient relative overflow-hidden p-5">
        <div className="ema-glow-layer pointer-events-none absolute inset-0 opacity-40" style={{ background: 'radial-gradient(60% 60% at 80% -10%, rgba(255,255,255,0.35), transparent 70%)' }} />
        <div className="relative flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-white/75">Your EMA line</span>
          <div className="relative flex size-8 items-center justify-center">
            <span className="ema-signal-ring" />
            <span className="ema-signal-ring ema-signal-ring-2" />
            <PhoneCall className="relative size-4" />
          </div>
        </div>
        {loading ? (
          <Skeleton className="relative mt-1 h-6 w-40 bg-white/20" />
        ) : (
          <div className="relative mt-1 font-display text-lg font-extrabold tracking-tight">
            {line?.did_number ? formatDid(line.did_number) : 'Setting up…'}
          </div>
        )}

        <div className="relative mt-4">
          {loading ? (
            <Skeleton className="h-10 w-44 bg-white/20" />
          ) : (
            <div className="ema-number-xl font-display text-4xl">
              {balance?.balance != null ? `${balance.currency} ${balance.balance.toFixed(2)}` : '—'}
            </div>
          )}
          {!loading && usdEquivalent != null && (
            <p className="relative mt-1 text-sm text-white/85">
              {'\u2248'} US${usdEquivalent.toFixed(2)} &middot; {'\u2248'}{dominicaMinutes} min to call Dominica
            </p>
          )}
        </div>

        <Link
          href="/consumer/wallet"
          className="ema-interactive relative mt-4 inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-sm font-bold text-[#3f7f1f]"
        >
          <ArrowUpCircle className="size-4" />
          Top up
        </Link>
      </div>

      {/* ── ASSISTANT card ──────────────────────────────────────────── */}
      <div className="ema-rise ema-rise-2 ema-card ema-shadow flex flex-col gap-3 border border-border bg-card p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-full bg-primary/15 text-primary">
              <Sparkles className="size-4.5" />
            </div>
            <span className="font-display text-sm font-extrabold">Your assistant</span>
          </div>
          <span className="ema-whatsapp-pill ema-pill inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold">
            <MessageCircle className="size-3" />
            Continued from WhatsApp
          </span>
        </div>

        <div className="rounded-2xl bg-muted px-3.5 py-2.5 text-sm text-foreground">
          Hi{' '}
          {'\u2014'} same assistant you message on WhatsApp. Ask about your balance, top up, or your recent calls
          without switching apps.
        </div>

        {reply && (
          <div className="flex flex-col gap-2">
            <div className="rounded-2xl bg-primary/10 px-3.5 py-2.5 text-sm text-foreground">{reply.text}</div>
            {reply.actions?.map((action, i) =>
              action.type === 'navigate_topup' ? (
                <Link
                  key={i}
                  href={`/consumer/wallet?amount=${action.amount}`}
                  className="ema-interactive inline-flex w-fit items-center gap-1.5 rounded-full border border-primary/40 px-3 py-1.5 text-xs font-semibold text-primary"
                >
                  <ArrowUpCircle className="size-3.5" />
                  Top up EC${action.amount.toFixed(2)}
                </Link>
              ) : null,
            )}
          </div>
        )}
        {chatLoading && <div className="rounded-2xl bg-muted px-3.5 py-2.5 text-sm text-muted-foreground">Typing…</div>}
        {chatError && <p className="text-xs text-destructive">{chatError}</p>}
        <div ref={scrollRef} />

        <div className="flex flex-wrap gap-2">
          {ASSISTANT_CHIPS.map((chip) => (
            <button
              key={chip}
              onClick={() => sendToAssistant(chip)}
              disabled={chatLoading}
              className="ema-interactive ema-pill rounded-full border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground disabled:opacity-50"
            >
              {chip}
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendToAssistant(input);
          }}
          className="flex items-center gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask your assistant…"
            className="h-10 flex-1 rounded-full border border-border bg-background px-4 text-sm outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={chatLoading || !input.trim()}
            className="ema-interactive flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-50"
          >
            <Send className="size-4" />
          </button>
        </form>
        <Link href="/consumer/assistant" className="text-center text-xs font-semibold text-muted-foreground underline underline-offset-2">
          Continue in full chat
        </Link>
      </div>

      {/* ── CALL + CALLBACK dual tiles ──────────────────────────────── */}
      <div className="ema-rise ema-rise-3 grid grid-cols-2 gap-3">
        <Link
          href="/consumer/call"
          className="ema-interactive ema-card ema-shadow flex flex-col items-start gap-2 bg-primary p-4 text-primary-foreground"
        >
          <PhoneCall className="size-5" />
          <div className="flex flex-col">
            <span className="font-display text-sm font-extrabold">Call</span>
            <span className="text-xs text-primary-foreground/85">We ring you first</span>
          </div>
        </Link>

        {lastCall ? (
          <button
            onClick={redialLast}
            disabled={redialing}
            className="ema-interactive ema-card ema-shadow flex flex-col items-start gap-2 border border-border bg-card p-4 text-left disabled:opacity-60"
          >
            <RotateCcw className="size-5 text-primary" />
            <div className="flex flex-col">
              <span className="font-display text-sm font-extrabold">Callback</span>
              <span className="truncate text-xs text-muted-foreground">Redial {formatDid(lastCall.number)}</span>
            </div>
          </button>
        ) : (
          <div className="ema-card flex flex-col items-start gap-2 border border-dashed border-border bg-card/50 p-4 text-left opacity-60">
            <RotateCcw className="size-5 text-muted-foreground" />
            <div className="flex flex-col">
              <span className="font-display text-sm font-extrabold">Callback</span>
              <span className="text-xs text-muted-foreground">No recent calls yet</span>
            </div>
          </div>
        )}
      </div>

      {/* ── RECENT calls ────────────────────────────────────────────── */}
      <div className="ema-rise ema-rise-4 flex flex-col gap-2">
        <div className="flex items-center justify-between px-1">
          <span className="font-display text-sm font-extrabold">Recent</span>
          <Link href="/consumer/settings" className="text-xs font-semibold text-primary">
            See all
          </Link>
        </div>

        {loading ? (
          <div className="ema-card border border-border bg-card p-4">
            <Skeleton className="h-14 w-full" />
          </div>
        ) : calls.length === 0 ? (
          <div className="ema-card border border-dashed border-border bg-card/50 px-4 py-8 text-center text-sm text-muted-foreground">
            No calls yet — your recent activity will show up here.
          </div>
        ) : (
          <div className="ema-card ema-shadow flex flex-col divide-y divide-border overflow-hidden border border-border bg-card">
            {calls.map((c, i) => {
              const meta = callMeta[c.dir];
              const Icon = meta.icon;
              const dominica = isDominicaNumber(c.number);
              return (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-full bg-muted font-display text-sm font-extrabold', meta.className)}>
                    <Icon className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{formatDid(c.number)}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {guessRegion(c.number)} &middot; {meta.label}
                      {c.dur ? ` \u00b7 ${c.dur}` : ''}
                      {dominica ? ' \u00b7 13.5\u00a2/min local' : ''}
                    </div>
                  </div>
                  <Link
                    href={`/consumer/call?destination=${encodeURIComponent(c.number)}`}
                    className="ema-interactive flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
                    aria-label={`Call ${formatDid(c.number)}`}
                  >
                    <PhoneCall className="size-4" />
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Link
        href="/consumer/wallet"
        className="ema-rise ema-rise-5 ema-interactive ema-card flex items-center justify-between border border-border bg-card px-4 py-3 text-sm font-semibold"
      >
        <span className="flex items-center gap-2">
          <WalletIcon className="size-4 text-primary" />
          Wallet &amp; top-up history
        </span>
        <span className="text-muted-foreground">{'\u2192'}</span>
      </Link>
    </div>
  );
}
