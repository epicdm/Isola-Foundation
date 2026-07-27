'use client';

import { useState, useEffect } from 'react';
import { Wallet, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface Txn {
  id: string;
  type: string;
  amount_usd: number;
  description: string;
  ref: string | null;
  created_at: string;
}

export default function WalletPage() {
  const [balance, setBalance] = useState<number | null>(null);
  const [currency, setCurrency] = useState('EC$');
  const [txns, setTxns] = useState<Txn[]>([]);
  const [loading, setLoading] = useState(true);
  // v7.1 (dec-isola-v7-wallet-read-only-release-2026-07-26): card-entry state removed.
  // The wallet is READ-ONLY for this release. Magnus remains the single balance authority.

  async function loadData() {
    setLoading(true);
    try {
      const [balRes, txnRes] = await Promise.all([
        fetch('/api/wallet/balance'),
        fetch('/api/wallet/txns'),
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

  useEffect(() => { loadData(); }, []);



  // GOLDEN-STANDARD FIX (label consistency only, item 7 alignment): "AI tokens" -> "AI usage
  // (tokens)" to match the wording now used on Dashboard/Plan. No logic or data change.
  const txnTypeLabel: Record<string, string> = {
    topup: 'Top-up',
    debit_minutes: 'Call minutes',
    debit_tokens: 'AI usage (tokens)',
    credit_adjust: 'Adjustment',
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Wallet</h1>
        <p className="text-sm text-muted-foreground">Manage your prepaid balance and payment history.</p>
      </div>

      {/* v7.1 READ-ONLY WALLET — ratified dec-isola-v7-wallet-read-only-release-2026-07-26.
          Raw card number / expiry / CVV fields, the card top-up form, its submit handler and the
          POST to /api/wallet/topup have all been REMOVED. Isola must not receive or process card
          data. Later card payment requires an explicit decision approving provider-hosted checkout
          or provider-tokenized components (bt-isola-wallet-hosted-payment-boundary). No hosted
          payment URL is fabricated here. */}
      <div className="grid gap-4 sm:grid-cols-2">
        {/* Balance card */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Available Balance
            </CardTitle>
            <Wallet className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-9 w-40" />
            ) : (
              <div className="text-3xl font-bold tracking-tight">
                {balance !== null ? `${currency} ${balance.toFixed(2)}` : 'Not configured'}
              </div>
            )}
            <p className="text-xs text-muted-foreground mt-1">Debited automatically for calls and AI usage</p>
          </CardContent>
        </Card>

        {/* Read-only: assisted payment notice (no card capture) */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Info className="size-4" />
              Adding credit
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground leading-relaxed">
              Credit is added by EPIC through an approved payment method. Card self-service is not
              available in this release.
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Contact EPIC to arrange a top-up by invoice, bank receipt, or another approved method.
            </p>
            <Button variant="outline" disabled className="w-fit">
              Card top-up unavailable
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Transaction history */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Transaction History</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {txns.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">No transactions yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Ref</TableHead>
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
                    <TableCell>{t.description}</TableCell>
                    <TableCell className={t.amount_usd >= 0 ? 'text-green-600 font-semibold' : 'text-destructive font-semibold'}>
                      {t.amount_usd >= 0 ? '+' : ''}{t.amount_usd.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{t.ref ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{new Date(t.created_at).toLocaleDateString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
