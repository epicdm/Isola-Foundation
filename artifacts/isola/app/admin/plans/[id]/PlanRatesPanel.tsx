'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronRight, Layers, Pencil, Plus, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { PlanRate } from '@/lib/magnus-rateplan';
import { DEFAULT_ECD_PER_USD, ecdToUsd } from '@/lib/currency';

interface Props {
  planId: string;
  planName: string;
  initialRates: PlanRate[];
}

interface PendingEdit {
  rate: PlanRate;
  newAmount: string;
}

interface PendingCreate {
  prefixQuery: string;
  resolved?: { id: string; prefix: string; destination: string };
  trunkId: string;
  amount: string;
  error?: string;
  loading?: boolean;
}

type BulkMode = 'flat' | 'cost_plus' | 'delta';

function usd(ecd: number, fx: number) {
  return `≈ US$${ecdToUsd(ecd, fx).toFixed(4)}`;
}

export function PlanRatesPanel({ planId, planName, initialRates }: Props) {
  const router = useRouter();
  const [rates, setRates] = useState(initialRates);
  const [search, setSearch] = useState('');
  const [grouped, setGrouped] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fx, setFx] = useState(DEFAULT_ECD_PER_USD);

  const [edit, setEdit] = useState<PendingEdit | null>(null);
  const [confirmEdit, setConfirmEdit] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [create, setCreate] = useState<PendingCreate>({ prefixQuery: '', trunkId: '', amount: '' });
  const [confirmCreate, setConfirmCreate] = useState(false);
  const [trunks, setTrunks] = useState<{ id: string; code: string }[] | null>(null);
  const [banner, setBanner] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // ── Bulk-edit state ────────────────────────────────────────────────────
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkMode, setBulkMode] = useState<BulkMode>('flat');
  const [bulkFlat, setBulkFlat] = useState('');
  const [bulkCost, setBulkCost] = useState('');
  const [bulkMargin, setBulkMargin] = useState('30');
  const [bulkDelta, setBulkDelta] = useState('');
  const [bulkConfirm, setBulkConfirm] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rates;
    return rates.filter((r) => r.destination.toLowerCase().includes(q) || r.prefix.includes(q));
  }, [rates, search]);

  // Group filtered rates by destination name (the "country/destination"
  // grouping the operator asked for — e.g. every "United States" prefix
  // collapses under one header with a count).
  const groups = useMemo(() => {
    const map = new Map<string, PlanRate[]>();
    for (const r of filtered) {
      const key = r.destination || '(no destination)';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return Array.from(map.entries())
      .map(([destination, rows]) => ({ destination, rows: rows.sort((a, b) => a.prefix.localeCompare(b.prefix)) }))
      .sort((a, b) => a.destination.localeCompare(b.destination));
  }, [filtered]);

  const selectedRates = useMemo(() => rates.filter((r) => selected.has(r.id)), [rates, selected]);

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroup(rows: PlanRate[]) {
    const ids = rows.map((r) => r.id);
    const allSelected = ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }

  function toggleCollapsed(destination: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(destination)) next.delete(destination);
      else next.add(destination);
      return next;
    });
  }

  function clearSelection() {
    setSelected(new Set());
  }

  // Compute the from→to preview for the current bulk-edit inputs.
  const bulkPreview = useMemo(() => {
    if (selectedRates.length === 0) return [];
    if (bulkMode === 'flat') {
      const v = parseFloat(bulkFlat);
      if (isNaN(v) || v < 0) return [];
      return selectedRates.map((r) => ({ rate: r, to: v }));
    }
    if (bulkMode === 'cost_plus') {
      const cost = parseFloat(bulkCost);
      const margin = parseFloat(bulkMargin);
      if (isNaN(cost) || cost < 0 || isNaN(margin)) return [];
      const to = cost * (1 + margin / 100);
      return selectedRates.map((r) => ({ rate: r, to }));
    }
    // delta
    const d = parseFloat(bulkDelta);
    if (isNaN(d)) return [];
    return selectedRates.map((r) => ({ rate: r, to: Math.max(0, parseFloat(r.rateinitial) + d) }));
  }, [selectedRates, bulkMode, bulkFlat, bulkCost, bulkMargin, bulkDelta]);

  const bulkComputedSell = bulkMode === 'cost_plus'
    ? (parseFloat(bulkCost) || 0) * (1 + (parseFloat(bulkMargin) || 0) / 100)
    : null;

  async function submitBulk() {
    if (bulkPreview.length === 0) return;
    setBusy(true);
    setBanner(null);
    try {
      const request_id = crypto.randomUUID();
      const res = await fetch(`/api/admin/magnus/plans/${planId}/rates/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id,
          targets: bulkPreview.map((p) => ({ rate_id: p.rate.id, rateinitial: p.to })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: 'error', text: data.error ?? 'Bulk rate update failed' });
        return;
      }
      const results: Array<{ rate_id: string; ok: boolean; rateinitial?: number }> = data.results ?? [];
      const okIds = new Set(results.filter((r) => r.ok).map((r) => r.rate_id));
      const failCount = results.length - okIds.size;
      setRates((prev) =>
        prev.map((r) => {
          const hit = results.find((res2) => res2.rate_id === r.id && res2.ok);
          return hit ? { ...r, rateinitial: hit.rateinitial!.toFixed(6) } : r;
        }),
      );
      setBanner({
        type: failCount === 0 ? 'success' : 'error',
        text: failCount === 0
          ? `Updated ${okIds.size} rate${okIds.size === 1 ? '' : 's'} on ${planName}.`
          : `Updated ${okIds.size} of ${results.length} rates — ${failCount} failed. Check the audit log (audit id ${data.audit_id}) for details.`,
      });
      setBulkOpen(false);
      setBulkConfirm(false);
      clearSelection();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function submitEdit() {
    if (!edit) return;
    setBusy(true);
    setBanner(null);
    try {
      const request_id = crypto.randomUUID();
      const res = await fetch(`/api/admin/magnus/plans/${planId}/rates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rate_id: edit.rate.id, rateinitial: parseFloat(edit.newAmount), request_id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: 'error', text: data.error ?? 'Failed to save rate' });
        return;
      }
      setRates((prev) => prev.map((r) => (r.id === edit.rate.id ? { ...r, rateinitial: parseFloat(edit.newAmount).toFixed(6) } : r)));
      setBanner({ type: 'success', text: `${edit.rate.destination} (${edit.rate.prefix}) updated to EC$${parseFloat(edit.newAmount).toFixed(4)}/min.` });
      setEdit(null);
      setConfirmEdit(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function ensureTrunks() {
    if (trunks) return trunks;
    const res = await fetch('/api/admin/magnus/trunks');
    const data = await res.json();
    const t = data.trunks ?? [];
    setTrunks(t);
    return t;
  }

  async function resolvePrefix() {
    setCreate((c) => ({ ...c, loading: true, error: undefined, resolved: undefined }));
    try {
      const res = await fetch(`/api/admin/magnus/prefixes?prefix=${encodeURIComponent(create.prefixQuery.trim())}`);
      const data = await res.json();
      if (!res.ok) {
        setCreate((c) => ({ ...c, loading: false, error: data.error ?? 'Not found' }));
        return;
      }
      setCreate((c) => ({ ...c, loading: false, resolved: data.prefix }));
    } catch (e: any) {
      setCreate((c) => ({ ...c, loading: false, error: e.message }));
    }
  }

  async function submitCreate() {
    if (!create.resolved || !create.trunkId || !create.amount) return;
    setBusy(true);
    setBanner(null);
    try {
      const request_id = crypto.randomUUID();
      const res = await fetch(`/api/admin/magnus/plans/${planId}/rates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id_prefix: create.resolved.id,
          id_trunk_group: create.trunkId,
          rateinitial: parseFloat(create.amount),
          request_id,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBanner({ type: 'error', text: data.error ?? 'Failed to create rate' });
        return;
      }
      setBanner({ type: 'success', text: `New rate added for ${create.resolved.destination} (${create.resolved.prefix}).` });
      setCreateOpen(false);
      setConfirmCreate(false);
      setCreate({ prefixQuery: '', trunkId: '', amount: '' });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function renderRateRow(r: PlanRate) {
    return (
      <TableRow key={r.id} data-state={selected.has(r.id) ? 'selected' : undefined}>
        <TableCell className="w-8">
          <Checkbox checked={selected.has(r.id)} onCheckedChange={() => toggleOne(r.id)} aria-label={`Select ${r.destination}`} />
        </TableCell>
        <TableCell className="font-medium">{r.destination || '—'}</TableCell>
        <TableCell className="font-mono text-xs">{r.prefix}</TableCell>
        <TableCell>
          <Badge variant="outline">{r.trunkName || '—'}</Badge>
        </TableCell>
        <TableCell className="text-right">
          <div className="font-mono">EC${parseFloat(r.rateinitial).toFixed(4)}</div>
          <div className="text-xs text-muted-foreground">{usd(parseFloat(r.rateinitial), fx)}</div>
        </TableCell>
        <TableCell>
          <Button size="icon" variant="ghost" onClick={() => setEdit({ rate: r, newAmount: parseFloat(r.rateinitial).toFixed(4) })}>
            <Pencil className="size-4" />
          </Button>
        </TableCell>
      </TableRow>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {banner && (
        <Alert variant={banner.type === 'error' ? 'destructive' : 'default'}>
          <AlertDescription>{banner.text}</AlertDescription>
        </Alert>
      )}

      <Alert>
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <span>
            Magnus bills this plan in <strong>EC$ (Eastern Caribbean Dollars / XCD)</strong> — every <code>rateinitial</code> you set here is EC$ per minute,
            debited from the account&apos;s EC$ balance. The US$ figures shown are for reference only.
          </span>
          <span className="flex items-center gap-1.5 whitespace-nowrap">
            <Label htmlFor="fx" className="text-xs font-normal text-muted-foreground">
              Reference FX (EC$ per US$1):
            </Label>
            <Input
              id="fx"
              type="number"
              step="0.01"
              min="0.01"
              value={fx}
              onChange={(e) => setFx(parseFloat(e.target.value) || DEFAULT_ECD_PER_USD)}
              className="h-7 w-20 text-xs"
            />
          </span>
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            placeholder="Search destination, country, or prefix…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>
        <Button size="sm" variant={grouped ? 'secondary' : 'outline'} onClick={() => setGrouped((g) => !g)}>
          <Layers className="size-4" /> {grouped ? 'Grouped' : 'Flat list'}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            await ensureTrunks();
            setCreateOpen(true);
          }}
        >
          <Plus className="size-4" /> Add rate
        </Button>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
          <span className="text-sm font-medium">{selected.size} rate{selected.size === 1 ? '' : 's'} selected</span>
          <Button size="sm" variant="outline" onClick={clearSelection}>
            Clear
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setBulkMode('flat');
              setBulkFlat('');
              setBulkCost('');
              setBulkMargin('30');
              setBulkDelta('');
              setBulkConfirm(false);
              setBulkOpen(true);
            }}
          >
            Set rates for selection…
          </Button>
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Destination</TableHead>
              <TableHead>Prefix</TableHead>
              <TableHead>Trunk</TableHead>
              <TableHead className="text-right">Sell rate</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                  No rates match "{search}".
                </TableCell>
              </TableRow>
            )}
            {!grouped && filtered.map(renderRateRow)}
            {grouped &&
              groups.map(({ destination, rows }) => {
                const ids = rows.map((r) => r.id);
                const selectedCount = ids.filter((id) => selected.has(id)).length;
                const allSelected = selectedCount === ids.length;
                const someSelected = selectedCount > 0 && !allSelected;
                const collapsed = collapsedGroups.has(destination);
                const min = Math.min(...rows.map((r) => parseFloat(r.rateinitial)));
                const max = Math.max(...rows.map((r) => parseFloat(r.rateinitial)));
                return (
                  <>
                    <TableRow key={`group-${destination}`} className="bg-muted/40 hover:bg-muted/60">
                      <TableCell>
                        <Checkbox
                          checked={someSelected ? 'indeterminate' : allSelected}
                          onCheckedChange={() => toggleGroup(rows)}
                          aria-label={`Select all ${destination}`}
                        />
                      </TableCell>
                      <TableCell colSpan={3}>
                        <button
                          type="button"
                          className="flex items-center gap-1.5 font-semibold"
                          onClick={() => toggleCollapsed(destination)}
                        >
                          {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                          {destination}
                          <Badge variant="secondary" className="ml-1">
                            {rows.length}
                          </Badge>
                        </button>
                      </TableCell>
                      <TableCell className="text-right text-xs text-muted-foreground">
                        {min === max ? (
                          <>EC${min.toFixed(4)}</>
                        ) : (
                          <>
                            EC${min.toFixed(4)}–{max.toFixed(4)}
                          </>
                        )}
                      </TableCell>
                      <TableCell />
                    </TableRow>
                    {!collapsed && rows.map(renderRateRow)}
                  </>
                );
              })}
          </TableBody>
        </Table>
      </div>

      {/* Bulk-edit dialog */}
      <Dialog
        open={bulkOpen}
        onOpenChange={(open) => {
          setBulkOpen(open);
          if (!open) setBulkConfirm(false);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Set rates for {selected.size} selected destination{selected.size === 1 ? '' : 's'}</DialogTitle>
            <DialogDescription>
              All values are EC$ per minute (Magnus&apos;s billing currency for {planName}). This writes to every selected rate in Magnus.
            </DialogDescription>
          </DialogHeader>

          {!bulkConfirm ? (
            <>
              <Tabs value={bulkMode} onValueChange={(v) => setBulkMode(v as BulkMode)}>
                <TabsList>
                  <TabsTrigger value="flat">Flat rate</TabsTrigger>
                  <TabsTrigger value="cost_plus">Cost + margin %</TabsTrigger>
                  <TabsTrigger value="delta">Adjust by amount</TabsTrigger>
                </TabsList>
              </Tabs>

              {bulkMode === 'flat' && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="bulkFlat">New rate for every selected destination (EC$/min)</Label>
                  <Input id="bulkFlat" type="number" step="0.0001" min="0" value={bulkFlat} onChange={(e) => setBulkFlat(e.target.value)} />
                  {!isNaN(parseFloat(bulkFlat)) && (
                    <p className="text-xs text-muted-foreground">{usd(parseFloat(bulkFlat), fx)}</p>
                  )}
                </div>
              )}

              {bulkMode === 'cost_plus' && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="bulkCost">Carrier cost basis (EC$/min)</Label>
                    <Input id="bulkCost" type="number" step="0.0001" min="0" value={bulkCost} onChange={(e) => setBulkCost(e.target.value)} />
                    <p className="text-xs text-muted-foreground">
                      Magnus doesn&apos;t expose a per-rate carrier cost field — enter what you know this trunk costs per minute.
                    </p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="bulkMargin">Margin %</Label>
                    <Input id="bulkMargin" type="number" step="1" value={bulkMargin} onChange={(e) => setBulkMargin(e.target.value)} />
                  </div>
                  {bulkComputedSell !== null && (
                    <p className="col-span-2 text-xs text-muted-foreground">
                      Resulting sell rate: <strong>EC${bulkComputedSell.toFixed(4)}/min</strong> ({usd(bulkComputedSell, fx)}) — margin EC$
                      {(bulkComputedSell - (parseFloat(bulkCost) || 0)).toFixed(4)}/min per call on this selection.
                    </p>
                  )}
                </div>
              )}

              {bulkMode === 'delta' && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="bulkDelta">Adjust every selected rate by (EC$/min, use a minus sign to lower)</Label>
                  <Input id="bulkDelta" type="number" step="0.0001" value={bulkDelta} onChange={(e) => setBulkDelta(e.target.value)} />
                  <p className="text-xs text-muted-foreground">Each rate keeps its own current value plus this adjustment (floors at EC$0).</p>
                </div>
              )}

              <div className="max-h-56 overflow-y-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Destination</TableHead>
                      <TableHead>Prefix</TableHead>
                      <TableHead className="text-right">From</TableHead>
                      <TableHead className="text-right">To</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {bulkPreview.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-xs text-muted-foreground">
                          Enter a value above to preview the resulting rates.
                        </TableCell>
                      </TableRow>
                    )}
                    {bulkPreview.map(({ rate, to }) => (
                      <TableRow key={rate.id}>
                        <TableCell className="text-xs">{rate.destination}</TableCell>
                        <TableCell className="font-mono text-xs">{rate.prefix}</TableCell>
                        <TableCell className="text-right font-mono text-xs">EC${parseFloat(rate.rateinitial).toFixed(4)}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-semibold">EC${to.toFixed(4)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setBulkOpen(false)}>
                  Cancel
                </Button>
                <Button disabled={bulkPreview.length === 0} onClick={() => setBulkConfirm(true)}>
                  Continue
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <Alert>
                <AlertDescription>
                  Confirm: write <strong>{bulkPreview.length}</strong> rate change{bulkPreview.length === 1 ? '' : 's'} to Magnus on {planName}, exactly as
                  listed below. This takes effect immediately for future calls.
                </AlertDescription>
              </Alert>
              <div className="max-h-64 overflow-y-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Destination</TableHead>
                      <TableHead>Prefix</TableHead>
                      <TableHead className="text-right">From → To</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {bulkPreview.map(({ rate, to }) => (
                      <TableRow key={rate.id}>
                        <TableCell className="text-xs">{rate.destination}</TableCell>
                        <TableCell className="font-mono text-xs">{rate.prefix}</TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          EC${parseFloat(rate.rateinitial).toFixed(4)} → <strong>EC${to.toFixed(4)}</strong>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setBulkConfirm(false)} disabled={busy}>
                  Back
                </Button>
                <Button onClick={submitBulk} disabled={busy}>
                  {busy ? 'Writing to Magnus…' : `Confirm & write ${bulkPreview.length} rate${bulkPreview.length === 1 ? '' : 's'}`}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog
        open={!!edit}
        onOpenChange={(open) => {
          if (!open) {
            setEdit(null);
            setConfirmEdit(false);
          }
        }}
      >
        <DialogContent>
          {edit && (
            <>
              <DialogHeader>
                <DialogTitle>Edit rate — {edit.rate.destination}</DialogTitle>
                <DialogDescription>
                  Prefix {edit.rate.prefix} on {planName}. This changes the live per-minute EC$ sell rate for every future call to this destination on this
                  plan.
                </DialogDescription>
              </DialogHeader>
              <div className="flex flex-col gap-2">
                <Label htmlFor="amount">New sell rate (EC$/min)</Label>
                <Input
                  id="amount"
                  type="number"
                  step="0.0001"
                  min="0"
                  value={edit.newAmount}
                  onChange={(e) => {
                    setConfirmEdit(false);
                    setEdit({ ...edit, newAmount: e.target.value });
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Current: EC${parseFloat(edit.rate.rateinitial).toFixed(4)}/min ({usd(parseFloat(edit.rate.rateinitial), fx)})
                </p>
                {!isNaN(parseFloat(edit.newAmount)) && (
                  <p className="text-xs text-muted-foreground">New: {usd(parseFloat(edit.newAmount), fx)}</p>
                )}
              </div>
              {!confirmEdit ? (
                <DialogFooter>
                  <Button
                    disabled={!edit.newAmount || isNaN(parseFloat(edit.newAmount))}
                    onClick={() => setConfirmEdit(true)}
                  >
                    Continue
                  </Button>
                </DialogFooter>
              ) : (
                <>
                  <Alert>
                    <AlertDescription>
                      Confirm: set {edit.rate.destination} ({edit.rate.prefix}) on {planName} to <strong>EC${parseFloat(edit.newAmount).toFixed(4)}/min</strong>{' '}
                      (was EC${parseFloat(edit.rate.rateinitial).toFixed(4)}/min)? This takes effect immediately in Magnus.
                    </AlertDescription>
                  </Alert>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setConfirmEdit(false)} disabled={busy}>
                      Back
                    </Button>
                    <Button onClick={submitEdit} disabled={busy}>
                      {busy ? 'Saving…' : 'Confirm & save'}
                    </Button>
                  </DialogFooter>
                </>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Create dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) {
            setConfirmCreate(false);
            setCreate({ prefixQuery: '', trunkId: '', amount: '' });
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a rate — {planName}</DialogTitle>
            <DialogDescription>
              Look up the exact dial prefix (e.g. "44" for UK, "1767225" for Dominica Cellular), pick a trunk, and set the sell rate.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="prefixQuery">Dial prefix (exact)</Label>
              <div className="flex gap-2">
                <Input
                  id="prefixQuery"
                  value={create.prefixQuery}
                  onChange={(e) => setCreate((c) => ({ ...c, prefixQuery: e.target.value, resolved: undefined, error: undefined }))}
                  placeholder="e.g. 1767225"
                />
                <Button type="button" variant="secondary" onClick={resolvePrefix} disabled={!create.prefixQuery.trim() || create.loading}>
                  {create.loading ? '…' : 'Look up'}
                </Button>
              </div>
              {create.error && <p className="text-xs text-destructive">{create.error}</p>}
              {create.resolved && (
                <p className="text-xs text-muted-foreground">
                  Found: <strong>{create.resolved.destination}</strong> (id {create.resolved.id})
                </p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="trunk">Trunk</Label>
              <select
                id="trunk"
                className="h-9 rounded-md border bg-transparent px-3 text-sm"
                value={create.trunkId}
                onChange={(e) => setCreate((c) => ({ ...c, trunkId: e.target.value }))}
              >
                <option value="">Select a trunk…</option>
                {(trunks ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.code}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="createAmount">Sell rate (EC$/min)</Label>
              <Input
                id="createAmount"
                type="number"
                step="0.0001"
                min="0"
                value={create.amount}
                onChange={(e) => setCreate((c) => ({ ...c, amount: e.target.value }))}
              />
              {!isNaN(parseFloat(create.amount)) && (
                <p className="text-xs text-muted-foreground">{usd(parseFloat(create.amount), fx)}</p>
              )}
            </div>
          </div>

          {!confirmCreate ? (
            <DialogFooter>
              <Button
                disabled={!create.resolved || !create.trunkId || !create.amount}
                onClick={() => setConfirmCreate(true)}
              >
                Continue
              </Button>
            </DialogFooter>
          ) : (
            <>
              <Alert>
                <AlertDescription>
                  Confirm: add a rate of <strong>EC${parseFloat(create.amount || '0').toFixed(4)}/min</strong> for{' '}
                  {create.resolved?.destination} ({create.resolved?.prefix}) on {planName}?
                </AlertDescription>
              </Alert>
              <DialogFooter>
                <Button variant="outline" onClick={() => setConfirmCreate(false)} disabled={busy}>
                  Back
                </Button>
                <Button onClick={submitCreate} disabled={busy}>
                  {busy ? 'Saving…' : 'Confirm & add'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
