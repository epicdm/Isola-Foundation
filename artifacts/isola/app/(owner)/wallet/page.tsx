'use client';

import { useState, useEffect } from 'react';
import { Wallet, CreditCard, ArrowUpCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  const [form, setForm] = useState({ cardNumber: '', expMonth: '', expYear: '', cvv: '', amount: '', payerName: '', payerEmail: '' });
  const [topupLoading, setTopupLoading] = useState(false);
  const [topupError, setTopupError] = useState('');
  const [topupSuccess, setTopupSuccess] = useState('');

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

  function set(k: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  }

  async function handleTopup(e: React.FormEvent) {
    e.preventDefault();
    setTopupLoading(true); setTopupError(''); setTopupSuccess('');
    try {
      const res = await fetch('/api/wallet/topup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, amount: parseFloat(form.amount) }),
      });
      const data = await res.json();
      if (!res.ok) { setTopupError(data.error ?? 'Payment failed'); return; }
      setTopupSuccess(`Payment successful! Ref: ${data.ref}`);
      setForm({ cardNumber: '', expMonth: '', expYear: '', cvv: '', amount: '', payerName: '', payerEmail: '' });
      loadData();
    } finally {
      setTopupLoading(false);
    }
  }

  const txnTypeLabel: Record<string, string> = {
    topup: 'Top-up',
    debit_minutes: 'Call minutes',
    debit_tokens: 'AI tokens',
    credit_adjust: 'Adjustment',
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Wallet</h1>
        <p className="text-sm text-muted-foreground">Manage your prepaid balance and payment history.</p>
      </div>

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

        {/* Top-up form */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <CreditCard className="size-4" />
              Add Credit
            </CardTitle>
          </CardHeader>
          <CardContent>
            {topupError && (
              <Alert variant="destructive" className="mb-4">
                <AlertDescription>{topupError}</AlertDescription>
              </Alert>
            )}
            {topupSuccess && (
              <Alert className="mb-4 border-green-500/50 text-green-700 dark:text-green-400">
                <AlertDescription>{topupSuccess}</AlertDescription>
              </Alert>
            )}
            <form onSubmit={handleTopup} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="payerName">Cardholder name</Label>
                <Input id="payerName" value={form.payerName} onChange={set('payerName')} placeholder="Jane Doe" required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="cardNumber">Card number</Label>
                <Input id="cardNumber" value={form.cardNumber} onChange={set('cardNumber')} placeholder="4111 1111 1111 1111" maxLength={19} required />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="expMonth">Exp month</Label>
                  <Input id="expMonth" value={form.expMonth} onChange={set('expMonth')} placeholder="MM" maxLength={2} required />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="expYear">Exp year</Label>
                  <Input id="expYear" value={form.expYear} onChange={set('expYear')} placeholder="YY" maxLength={2} required />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cvv">CVV</Label>
                  <Input id="cvv" type="password" value={form.cvv} onChange={set('cvv')} placeholder="123" maxLength={4} required />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="amount">Amount (EC$)</Label>
                <Input id="amount" type="number" min="10" step="0.01" value={form.amount} onChange={set('amount')} placeholder="50.00" required />
              </div>
              <Button type="submit" className="w-full" disabled={topupLoading}>
                <ArrowUpCircle className="size-4" />
                {topupLoading ? 'Processing…' : 'Add credit'}
              </Button>
            </form>
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
