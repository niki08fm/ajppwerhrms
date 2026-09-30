import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { cn, toPaise } from '@/lib/utils';
import { Money } from '@/components/bits';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, MoneyInput, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { useSalaryPreview } from '../SalaryPreview';
import type { Employee } from '../types';

interface SalaryRow {
  id: string;
  valid_from: string;
  valid_to: string | null;
  mode: 'CTC' | 'GROSS';
  amount: number;
  monthly_gross: number;
  structure: { id: string; name: string };
  reason: string;
  created_by: string | null;
}

export function SalaryHistoryTab({ e }: { e: Employee }) {
  const q = useQuery({ queryKey: ['salary-history', e.id], queryFn: () => api.get<{ data: SalaryRow[] }>(`/employees/${e.id}/salary`).then((r) => r.data) });
  const [revising, setRevising] = useState(false);
  return (
    <Card>
      <CardHeader
        title="Salary history"
        description="Effective-dated. A revision closes the current record the day before and inserts a new one — nothing is ever overwritten, and payslips already generated do not move."
        actions={
          !e.read_only && (
            <Button onClick={() => setRevising(true)}>
              <TrendingUp /> Revise salary
            </Button>
          )
        }
      />
      {q.isLoading ? (
        <SkeletonRows rows={4} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data!.length ? (
        <EmptyState title="No salary on record" body="Salary is created when onboarding starts." />
      ) : (
        <table className="data-table w-full">
          <thead>
            <tr>
              <th>From</th>
              <th>To</th>
              <th>Agreed as</th>
              <th className="text-right">Amount</th>
              <th className="text-right">Monthly gross</th>
              <th>Structure</th>
              <th>Reason</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {q.data!.map((r) => (
              <tr key={r.id} className={cn(!r.valid_to && 'font-medium')}>
                <td className="num">{r.valid_from}</td>
                <td className="num">{r.valid_to ?? <Chip tone="success">Current</Chip>}</td>
                <td>{r.mode === 'CTC' ? 'Annual CTC' : 'Monthly gross'}</td>
                <td className="text-right">
                  <Money value={r.amount} />
                </td>
                <td className="text-right">
                  <Money value={r.monthly_gross} />
                </td>
                <td>{r.structure.name}</td>
                <td className="max-w-xs truncate">{r.reason}</td>
                <td className="text-muted-foreground">{r.created_by ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {revising && <ReviseDialog e={e} onClose={() => setRevising(false)} />}
    </Card>
  );
}

/** Anything that changes pay shows a before-and-after preview before it commits. */
function ReviseDialog({ e, onClose }: { e: Employee; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const cur = e.salary!;
  const [f, setF] = useState({ mode: cur.mode, amount: String((cur.mode === 'GROSS' ? cur.monthly_gross : cur.amount) / 100), valid_from: '', structure_id: cur.structure_id, reason: '' });
  const [chosen, setChosen] = useState<number | undefined>();
  const before = useSalaryPreview({ mode: cur.mode, amount: cur.amount, employee_id: e.id, structure_id: cur.structure_id, chosen_gross: cur.monthly_gross });
  const after = useSalaryPreview({ mode: f.mode, amount: toPaise(f.amount), employee_id: e.id, structure_id: f.structure_id, chosen_gross: chosen, date: f.valid_from || undefined });
  const save = useMutation({
    mutationFn: () => api.post(`/employees/${e.id}/salary`, { mode: f.mode, amount: toPaise(f.amount), valid_from: f.valid_from, structure_id: f.structure_id, reason: f.reason, ...(chosen ? { chosen_gross: chosen } : {}) }),
    onSuccess: () => {
      toast.success(`Revised from ${f.valid_from}. Earlier months are untouched.`);
      qc.invalidateQueries({ queryKey: ['salary-history', e.id] });
      qc.invalidateQueries({ queryKey: ['employee', e.id] });
      qc.invalidateQueries({ queryKey: ['employee-pay', e.id] });
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const b = before.data;
  const a = after.data;
  const rows: [string, number | undefined, number | undefined][] = [
    ['Monthly gross', b?.gross, a?.gross],
    ['Take-home', b?.take_home, a?.take_home],
    ['Employer cost per month', b?.ctc.monthly_cost, a?.ctc.monthly_cost],
    ['Annual CTC', b?.ctc.annual_ctc, a?.ctc.annual_ctc],
  ];
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      wide
      title="Revise salary"
      description="The pay valid on the last day of a month applies to the whole month."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!f.valid_from || f.reason.trim().length < 3 || !toPaise(f.amount) || (a?.solution?.ambiguous && !chosen)} onClick={() => save.mutate()}>
            Save revision
          </Button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Agreed as">
            {(id) => (
              <Select id={id} value={f.mode} onChange={(ev) => setF({ ...f, mode: ev.target.value as 'GROSS' | 'CTC' })}>
                <option value="GROSS">Monthly gross</option>
                <option value="CTC">Annual CTC</option>
              </Select>
            )}
          </Field>
          <Field label="Amount">{(id) => <MoneyInput id={id} value={f.amount} onChange={(ev) => setF({ ...f, amount: ev.target.value })} />}</Field>
          <Field label="Effective from" required>
            {(id) => <Input id={id} type="date" value={f.valid_from} onChange={(ev) => setF({ ...f, valid_from: ev.target.value })} />}
          </Field>
          <Field label="Structure">
            {(id) => (
              <Select id={id} value={f.structure_id} onChange={(ev) => setF({ ...f, structure_id: ev.target.value })}>
                {lk?.structures.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} (from {s.valid_from})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Reason" required className="col-span-2">
            {(id) => <Input id={id} value={f.reason} onChange={(ev) => setF({ ...f, reason: ev.target.value })} placeholder="e.g. Annual increment" />}
          </Field>
          {a?.solution?.ambiguous && (
            <div className="col-span-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-[13px]">
              This CTC has two valid grosses.
              {[
                { g: a.solution.gross, l: 'without ESI' },
                { g: a.solution.alternative!.gross, l: 'with ESI' },
              ].map((o) => (
                <label key={o.g} className="mt-1 flex items-center gap-2">
                  <input type="radio" checked={chosen === o.g} onChange={() => setChosen(o.g)} /> <Money value={o.g} /> {o.l}
                </label>
              ))}
            </div>
          )}
        </div>
        <div>
          <table className="w-full text-[13px]">
            <thead className="text-left text-[12px] text-muted-foreground">
              <tr>
                <th className="py-1" />
                <th className="text-right">Before</th>
                <th />
                <th className="text-right">After</th>
                <th className="text-right">Change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, x, y]) => (
                <tr key={label} className="border-t">
                  <td className="py-1.5">{label}</td>
                  <td className="text-right">
                    <Money value={x} />
                  </td>
                  <td className="px-1 text-muted-foreground">
                    <ArrowRight className="size-3" />
                  </td>
                  <td className="text-right">
                    <Money value={y} />
                  </td>
                  <td className={cn('text-right', (y ?? 0) - (x ?? 0) > 0 ? 'text-success' : (y ?? 0) - (x ?? 0) < 0 ? 'text-destructive' : '')}>
                    {x !== undefined && y !== undefined ? <Money value={y - x} /> : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Dialog>
  );
}
