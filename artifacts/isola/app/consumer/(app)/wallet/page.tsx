'use client';

import { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { Wallet, CreditCard, ArrowUpCircle, QrCode, RefreshCw, Copy, Check, Landmark } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type TopupCurrency = 'EC$' | 'US$';

interface BffBundle {
  id: string;
  paidAmount: number; // amount charged, in `currency`
  creditAmount: number; // always EC$ — the wallet credit (== paidAmount for EC$ bundles, the USD→EC$ equivalent for US$ bundles)
  minutes?: number;
  label?: string;
  currency?: TopupCurrency;
}

interface NbdManualAccount {
  configured: boolean;
  bank: string;
  accountName: string | null;
  accountNumber: string | null;
}

// EMA's own Dominica per-minute rate — NOT the BFF's Lite-rate assumption
// (BFF's `minutes`/`label` fields assume EC$0.10/min, which is wrong for EMA).
// International/US calling uses higher per-minute rates than this, so this
// number is a Dominica-only estimate and must not be shown as a flat "N min".
const DOMINICA_MIN_RATE_EC = 0.135;

// EC$ (XCD) is pegged to US$ (USD) at this fixed rate — used only for the
// diaspora-facing "≈ US$" display equivalent. EC$ stays the primary/billing
// currency everywhere; this is a secondary hint only.
const EC_PER_USD = 2.7;

function dominicaMinutesFor(bundle: BffBundle): number {
  return Math.floor(bundle.creditAmount / DOMINICA_MIN_RATE_EC);
}

function usdEquivalent(balanceEc: number): number {
  return balanceEc / EC_PER_USD;
}

function dominicaMinutesForBalance(balanceEc: number): number {
  return Math.floor(balanceEc / DOMINICA_MIN_RATE_EC);
}

function fmtAmount(n: number): string {
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

interface Txn {
  id: string;
  type: string;
  amount_usd: number;
  description: string;
  ref: string | null;
  created_at: string;
}

export default function ConsumerWalletPage() {
  const [balance, setBalance] = useState<number | null>(null);
  const [currency, setCurrency] = useState('EC$');
  const [txns, setTxns] = useState<Txn[]>([]);
  const [loading, setLoading] = useState(true);

  const [bundles, setBundles] = useState<BffBundle[]>([]);
  const [selectedBundle, setSelectedBundle] = useState<BffBundle | null>(null);
  const [optionsError, setOptionsError] = useState('');
  const [optionsLoading, setOptionsLoading] = useState(true);

  // Top-up currency toggle — defaults by the account's own number country
  // (server tells us via `defaultCurrency`), user can switch freely
  // afterward. US$ stays disabled ("coming shortly") until the BFF options
  // response actually contains a US$ bundle.
  const [topupCurrency, setTopupCurrency] = useState<TopupCurrency>('EC$');
  const [usdAvailable, setUsdAvailable] = useState(false);

  const [cardLoading, setCardLoading] = useState(false);
  const [cardError, setCardError] = useState('');

  const [mobankingLoading, setMobankingLoading] = useState(false);
  const [mobankingError, setMobankingError] = useState('');
  const [mobankingQr, setMobankingQr] = useState<string | null>(null);
  const [mobankingAmount, setMobankingAmount] = useState<number | null>(null);
  const [mobankingNote, setMobankingNote] = useState<string | null>(null);

  const [nbdManual, setNbdManual] = useState<NbdManualAccount | null>(null);
  const [copiedField, setCopiedField] = useState<'account' | 'amount' | null>(null);

  const visibleBundles = bundles.filter((b) => (b.currency ?? 'EC$') === topupCurrency);

  async function loadOptions() {
    setOptionsLoading(true);
    setOptionsError('');
    try {
      const res = await fetch('/api/consumer/wallet/topup/bff/options');
      const data = await res.json();
      if (!res.ok) {
        setOptionsError(data.error ?? 'Could not load top-up bundles');
        return;
      }
      const loadedBundles: BffBundle[] = data.bundles ?? [];
      setBundles(loadedBundles);
      setUsdAvailable(!!data.usdAvailable);
      setNbdManual(data.nbdManual ?? null);

      // Default currency is by number country, but never land on a
      // currency with no bundles (e.g. USD not live yet) — fall back to EC$.
      const initialCurrency: TopupCurrency =
        data.defaultCurrency === 'US$' && data.usdAvailable ? 'US$' : 'EC$';
      setTopupCurrency(initialCurrency);
      setSelectedBundle(loadedBundles.find((b) => (b.currency ?? 'EC$') === initialCurrency) ?? loadedBundles[0] ?? null);
    } catch (e: any) {
      setOptionsError(e.message ?? 'Could not load top-up bundles');
    } finally {
      setOptionsLoading(false);
    }
  }

  async function loadData() {
    setLoading(true);
    try {
      const [balRes, txnRes] = await Promise.all([
        fetch('/api/consumer/wallet/balance'),
        fetch('/api/consumer/wallet/txns'),
      ]);
      const balData = await balRes.json();
      setBalance(balData.balance);
      setCurrency(balData.currency ?? 'EC$');
      const txnData = txnRes.ok ? await txnRes.json() : { txns: [] };
      setTxns(txnData.txns ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    loadOptions();
  }, []);

  function handleSelectCurrency(next: TopupCurrency) {
    if (next === topupCurrency) return;
    if (next === 'US$' && !usdAvailable) return; // "coming shortly" — not selectable
    setTopupCurrency(next);
    setCardError('');
    const nextBundles = bundles.filter((b) => (b.currency ?? 'EC$') === next);
    setSelectedBundle(nextBundles[0] ?? null);
  }

  async function handleCardTopup() {
    if (!selectedBundle) return;
    setCardLoading(true);
    setCardError('');
    try {
      const res = await fetch('/api/consumer/wallet/topup/bff/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bundleId: selectedBundle.id,
          method: 'card',
          currency: selectedBundle.currency ?? 'EC$',
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setCardError(data.error ?? 'Could not start card payment');
        return;
      }
      window.location.href = data.url;
    } catch (e: any) {
      setCardError(e.message ?? 'Could not start card payment');
    } finally {
      setCardLoading(false);
    }
  }

  async function handleMobankingTopup() {
    if (!selectedBundle) return;
    setMobankingLoading(true);
    setMobankingError('');
    setMobankingQr(null);
    setMobankingAmount(null);
    setMobankingNote(null);
    try {
      const res = await fetch('/api/consumer/wallet/topup/bff/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundleId: selectedBundle.id, method: 'mobanking' }),
      });
      const data = await res.json();
      if (!res.ok || !data.qrUrl) {
        setMobankingError(data.error ?? 'Could not generate NBD MoBanking QR');
        return;
      }
      const dataUrl = await QRCode.toDataURL(data.qrUrl, { width: 240, margin: 1 });
      setMobankingQr(dataUrl);
      setMobankingAmount(data.amountEc ?? selectedBundle.paidAmount);
      setMobankingNote(data.note ?? null);
    } catch (e: any) {
      setMobankingError(e.message ?? 'Could not generate NBD MoBanking QR');
    } finally {
      setMobankingLoading(false);
    }
  }

  async function copyToClipboard(text: string, field: 'account' | 'amount') {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField((f) => (f === field ? null : f)), 1500);
    } catch {
      // Clipboard API can be unavailable (e.g. insecure context) — silently ignore,
      // the value is still shown as selectable text.
    }
  }

  const txnTypeLabel: Record<string, string> = {
    topup: 'Top-up',
    debit_minutes: 'Call minutes',
    debit_tokens: 'AI usage',
    credit_adjust: 'Adjustment',
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Wallet</h1>
          <p className="text-sm text-muted-foreground">Your balance and top-up history.</p>
        </div>
        <Button variant="ghost" size="icon" onClick={loadData} disabled={loading} title="Refresh balance">
          <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Wallet className="size-4" />
            Available balance
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-9 w-40" />
          ) : (
            <div className="text-3xl font-bold tracking-tight">
              {balance !== null ? `${currency} ${balance.toFixed(2)}` : 'Not configured'}
            </div>
          )}
          {balance !== null && currency === 'EC$' && (
            <p className="mt-0.5 text-sm text-muted-foreground">
              {'\u2248'} US${usdEquivalent(balance).toFixed(2)} &middot; {'\u2248'}
              {dominicaMinutesForBalance(balance)} min to Dominica
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">Debited automatically for calls</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <ArrowUpCircle className="size-4" />
            Add credit
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {optionsError && (
            <Alert variant="destructive">
              <AlertDescription>{optionsError}</AlertDescription>
            </Alert>
          )}

          {optionsLoading ? (
            <div className="grid grid-cols-4 gap-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : bundles.length > 0 ? (
            <>
              {/* ── Currency toggle ───────────────────────────────────── */}
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={topupCurrency === 'EC$' ? 'default' : 'outline'}
                  size="sm"
                  className="flex-1"
                  onClick={() => handleSelectCurrency('EC$')}
                >
                  EC$
                </Button>
                <Button
                  type="button"
                  variant={topupCurrency === 'US$' ? 'default' : 'outline'}
                  size="sm"
                  className="flex-1"
                  disabled={!usdAvailable}
                  title={usdAvailable ? undefined : 'US$ top-up is coming shortly'}
                  onClick={() => handleSelectCurrency('US$')}
                >
                  {usdAvailable ? 'US$' : 'US$ — coming shortly'}
                </Button>
              </div>

              {visibleBundles.length > 0 ? (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {visibleBundles.map((b) => {
                      const isUsd = (b.currency ?? 'EC$') === 'US$';
                      return (
                        <Button
                          key={b.id}
                          type="button"
                          variant={selectedBundle?.id === b.id ? 'default' : 'outline'}
                          className="h-auto min-w-0 flex-col gap-0.5 whitespace-normal px-1.5 py-2 text-center leading-tight"
                          onClick={() => setSelectedBundle(b)}
                        >
                          <span className="w-full truncate text-xs font-semibold sm:text-sm">
                            {isUsd
                              ? `US$${fmtAmount(b.paidAmount)} → EC$${fmtAmount(b.creditAmount)} credit`
                              : `EC$${fmtAmount(b.creditAmount)} credit`}
                          </span>
                          <span className="w-full truncate text-[10px] font-normal opacity-80 sm:text-[11px]">
                            ≈{dominicaMinutesFor(b)} min to Dominica
                          </span>
                        </Button>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Minute estimates use EMA's Dominica rate. Calls to other countries (including the US) use higher per-minute rates, so you'll get fewer minutes on those calls.
                  </p>

                  {/* ── Card — the only active top-up method ────────────── */}
                  <div className="flex flex-col gap-2">
                    {cardError && (
                      <Alert variant="destructive">
                        <AlertDescription>{cardError}</AlertDescription>
                      </Alert>
                    )}
                    <Button
                      type="button"
                      className="h-auto w-full min-w-0 whitespace-normal py-2 text-center"
                      disabled={!selectedBundle || cardLoading}
                      onClick={handleCardTopup}
                    >
                      <CreditCard className="size-4 shrink-0" />
                      <span className="truncate">
                        {cardLoading
                          ? 'Opening secure checkout…'
                          : `Pay with card${selectedBundle ? ` — ${selectedBundle.currency ?? 'EC$'}${fmtAmount(selectedBundle.paidAmount)}` : ''}`}
                      </span>
                    </Button>
                  </div>
                </>
              ) : (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  US$ top-up is coming shortly — switch to EC$ for now.
                </p>
              )}

              {/* ── NBD MoBanking — launch-paused, coming soon ─────────────
                  Card is the only active method for launch. The NBD flow
                  (QR + manual account transfer, handleMobankingTopup, the
                  bff/start "mobanking" method, and the account-name/number
                  config) is intentionally left intact below/server-side so
                  this can be re-enabled later without a rebuild — only the
                  active UI is hidden behind this disabled row. */}
              <div className="border-t pt-4">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full cursor-not-allowed opacity-60"
                  disabled
                  aria-disabled="true"
                >
                  <QrCode className="size-4" />
                  NBD MoBanking — Coming Soon
                </Button>
              </div>
            </>
          ) : (
            !optionsError && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Top-up is not available right now.
              </p>
            )
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">History</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {txns.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No transactions yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {txns.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell>
                        <Badge variant={t.amount_usd >= 0 ? 'default' : 'destructive'}>
                          {txnTypeLabel[t.type] ?? t.type}
                        </Badge>
                      </TableCell>
                      <TableCell className={t.amount_usd >= 0 ? 'font-semibold text-green-600' : 'font-semibold text-destructive'}>
                        {t.amount_usd >= 0 ? '+' : ''}{t.amount_usd.toFixed(2)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{new Date(t.created_at).toLocaleDateString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
