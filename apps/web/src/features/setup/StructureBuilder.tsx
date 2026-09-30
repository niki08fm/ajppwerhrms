import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { CALC_TYPES, CALC_TYPE_LABELS, MONTH_NAMES, type CalcType } from '@ajpwer/shared';
import { api, errorMessage } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { toPaise } from '@/lib/utils';
import { Money, PageHeader, ProportionBar } from '@/components/bits';
import { Notice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, Input, MoneyInput, Select } from '@/components/ui/form';
import { Switch } from '@/components/ui/overlay';
import type { Component, Structure } from './Structures';

type Row = Omit<Component, 'calc_value'> & { value: string };

const blank = (seq: number, over: Partial<Row> = {}): Row => ({ seq, name: '', calc_type: 'FIXED', value: '', frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: false, colour: `chart-${((seq - 1) % 5) + 1}`, ...over });

const DEFAULT: Row[] = [
  blank(1, { name: 'Basic', calc_type: 'PCT_GROSS', value: '50', counts_as_wages: true }),
  blank(2, { name: 'HRA', calc_type: 'PCT_BASIC', value: '40' }),
  blank(3, { name: 'Special allowance', calc_type: 'BALANCE', value: '0' }),
];

function toComponent(r: Row, i: number) {
  return {
    seq: i + 1,
    name: r.name.trim(),
    calc_type: r.calc_type,
    calc_value: r.calc_type === 'FIXED' ? toPaise(r.value) : r.calc_type === 'BALANCE' ? 0 : Number(r.value) || 0,
    frequency: r.frequency,
    pay_month: r.frequency === 'YEARLY' ? r.pay_month ?? 3 : null,
    is_taxable: r.is_taxable,
    counts_as_wages: r.frequency === 'MONTHLY' && r.counts_as_wages,
    colour: r.colour,
  };
}

export default function StructureBuilder() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [sp] = useSearchParams();
  const from = sp.get('from');
  const src = useQuery({ queryKey: ['structure', from], queryFn: () => api.get<{ data: Structure }>(`/structures/${from}`).then((r) => r.data), enabled: !!from });
  const [name, setName] = useState('');
  const [validFrom, setValidFrom] = useState(new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<Row[]>(DEFAULT);
  const [sample, setSample] = useState('24000');
  useEffect(() => {
    const s = src.data;
    if (!s) return;
    setName(`${s.name} (copy)`);
    setRows(s.components.map((c) => ({ ...c, value: c.calc_type === 'FIXED' ? String(c.calc_value / 100) : String(c.calc_value) })));
  }, [src.data]);

  const comps = rows.map(toComponent);
  const debounced = useDebounced({ comps, gross: toPaise(sample) }, 200);
  // Live preview at a sample gross, updating as the user types.
  const preview = useQuery({
    queryKey: ['structure-validate', debounced],
    queryFn: () => api.post<{ data: { errors: string[]; warnings: string[]; expanded: { monthly: { name: string; amount: number; colour: string }[]; yearly: { name: string; amount: number }[]; gross: number; yearly_total: number } } }>('/structures/validate', { components: debounced.comps, sample_gross: debounced.gross || 100 }).then((r) => r.data),
    enabled: debounced.comps.every((c) => c.name) && debounced.gross > 0,
    placeholderData: (p) => p,
  });
  const save = useMutation({
    mutationFn: () => api.post('/structures', { name, valid_from: validFrom, components: comps, ...(from ? { duplicated_from: from } : {}) }),
    onSuccess: () => {
      toast.success('Structure created');
      qc.invalidateQueries({ queryKey: ['structures'] });
      qc.invalidateQueries({ queryKey: ['lookups'] });
      nav('/setup/structures');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) =>
    setRows((rs) => {
      const n = [...rs];
      const [x] = n.splice(i, 1);
      n.splice(i + d, 0, x);
      return n;
    });
  const p = preview.data;
  const blankNames = rows.some((r) => !r.name.trim());

  return (
    <div className="flex flex-col gap-4">
      <PageHeader crumbs={[{ label: 'Salary structures', to: '/setup/structures' }, { label: from ? 'Duplicate and edit' : 'New structure' }]} title={from ? 'Duplicate and edit' : 'New salary structure'} description="A new structure with its own effective date. The original is untouched." />
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Components" description="Basic is computed first, then the rest; the balance takes whatever is left of gross and is never negative." />
          <CardBody className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" required>
                {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Site staff 2027" />}
              </Field>
              <Field label="Effective from">{(id) => <Input id={id} type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />}</Field>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-[13px]">
                <thead className="text-left text-[12px] text-muted-foreground">
                  <tr>
                    <th className="py-1" />
                    <th>Name</th>
                    <th>Rule</th>
                    <th>Value</th>
                    <th>Paid</th>
                    <th>Taxable</th>
                    <th title="Tick on Basic, and on a dearness allowance if you use one. It decides which components form the PF base, and nothing else.">Counts as wages*</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-t align-top">
                      <td className="py-1.5 pr-1">
                        <div className="flex flex-col">
                          <button disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up" className="disabled:opacity-30">
                            <ArrowUp className="size-3.5" />
                          </button>
                          <button disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Move down" className="disabled:opacity-30">
                            <ArrowDown className="size-3.5" />
                          </button>
                        </div>
                      </td>
                      <td className="py-1.5 pr-2">
                        <Input value={r.name} onChange={(e) => set(i, { name: e.target.value })} aria-label="Component name" aria-invalid={!r.name.trim()} />
                      </td>
                      <td className="py-1.5 pr-2">
                        <Select value={r.calc_type} onChange={(e) => set(i, { calc_type: e.target.value as CalcType })} aria-label="Rule">
                          {CALC_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {CALC_TYPE_LABELS[t]}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="w-32 py-1.5 pr-2">
                        {r.calc_type === 'BALANCE' ? (
                          <span className="text-[12px] text-muted-foreground">Remainder</span>
                        ) : r.calc_type === 'FIXED' ? (
                          <MoneyInput value={r.value} onChange={(e) => set(i, { value: e.target.value })} aria-label="Amount" />
                        ) : (
                          <div className="relative">
                            <Input value={r.value} onChange={(e) => set(i, { value: e.target.value })} className="pr-6 num" aria-label="Percent" />
                            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground">%</span>
                          </div>
                        )}
                      </td>
                      <td className="py-1.5 pr-2">
                        <div className="flex gap-1">
                          <Select value={r.frequency} onChange={(e) => set(i, { frequency: e.target.value as 'MONTHLY' | 'YEARLY', pay_month: e.target.value === 'YEARLY' ? r.pay_month ?? 10 : null })} aria-label="Frequency">
                            <option value="MONTHLY">Monthly</option>
                            <option value="YEARLY">Yearly</option>
                          </Select>
                          {r.frequency === 'YEARLY' && (
                            <Select value={r.pay_month ?? 10} onChange={(e) => set(i, { pay_month: Number(e.target.value) })} aria-label="Payout month">
                              {MONTH_NAMES.map((m, k) => (
                                <option key={m} value={k + 1}>
                                  {m.slice(0, 3)}
                                </option>
                              ))}
                            </Select>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5">
                        <Switch checked={r.is_taxable} onCheckedChange={(v) => set(i, { is_taxable: v })} label="Taxable" />
                      </td>
                      <td className="py-2.5">
                        <Switch checked={r.counts_as_wages} disabled={r.frequency === 'YEARLY'} onCheckedChange={(v) => set(i, { counts_as_wages: v })} label="Counts as wages (PF base)" />
                      </td>
                      <td className="py-1.5">
                        <Button size="icon" variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={`Remove ${r.name || 'component'}`}>
                          <Trash2 />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between">
              <Button variant="outline" size="sm" onClick={() => setRows([...rows, blank(rows.length + 1)])}>
                <Plus /> Add component
              </Button>
              <p className="max-w-md text-right text-[12px] text-muted-foreground">* Counts as wages: tick it on Basic, and on a dearness allowance if you use one. It decides which components form the PF base, and nothing else.</p>
            </div>
          </CardBody>
        </Card>
        <Card className="h-fit xl:sticky xl:top-4">
          <CardHeader title="Preview" description="Updates as you type." />
          <CardBody className="flex flex-col gap-3">
            <Field label="Sample monthly gross">{(id) => <MoneyInput id={id} value={sample} onChange={(e) => setSample(e.target.value)} />}</Field>
            {blankNames && <Notice tone="warning">Every component needs a name.</Notice>}
            {p?.errors.map((e) => (
              <Notice key={e} tone="destructive">
                {e}
              </Notice>
            ))}
            {p?.warnings.map((w) => (
              <Notice key={w} tone="warning">
                {w}
              </Notice>
            ))}
            {p && (
              <>
                <ProportionBar parts={p.expanded.monthly.map((c) => ({ label: c.name, value: c.amount, colour: c.colour }))} />
                <table className="w-full text-[13px]">
                  <tbody>
                    {p.expanded.monthly.map((c) => (
                      <tr key={c.name} className="border-t">
                        <td className="py-1">{c.name}</td>
                        <td className="text-right">
                          <Money value={c.amount} />
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t font-semibold">
                      <td className="py-1">Monthly gross</td>
                      <td className="text-right">
                        <Money value={p.expanded.gross} />
                      </td>
                    </tr>
                    {p.expanded.yearly.map((c) => (
                      <tr key={c.name} className="border-t text-muted-foreground">
                        <td className="py-1">{c.name} (yearly)</td>
                        <td className="text-right">
                          <Money value={c.amount} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            <Button size="lg" disabled={!name.trim() || blankNames || !!p?.errors.length} loading={save.isPending} onClick={() => save.mutate()}>
              Create structure
            </Button>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
