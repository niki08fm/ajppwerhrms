import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { addMonths } from '@ajpwer/shared';
import { api, errorMessage } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { cn, mins, monthLabel, toPaise } from '@/lib/utils';
import { Money, PageHeader } from '@/components/bits';
import { Chip, EmptyState, ErrorState, Notice, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, MoneyInput, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';

interface Row {
  id: string;
  code: string;
  name: string;
  client: string | null;
  contract_value: number;
  budget_labour: number;
  minutes: number;
  people: number;
  labour_cost: number;
  annual_run_rate: number;
  budget_used_pct: number | null;
  margin_at_rate: number;
}

/** The number the rest of the business wants from HR: labour cost by project, from punches, split by minutes. */
export default function Projects() {
  const { data: lk } = useLookups();
  const cur = lk?.today.slice(0, 7) ?? new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(cur);
  const [adding, setAdding] = useState(false);
  const q = useQuery({ queryKey: ['labour-cost', month], queryFn: () => api.get<{ data: Row[]; meta: { source: string; caveat: string; uncosted_people: number } }>('/projects/labour-cost', { month }) });
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Projects"
        description="Each punch carries a site; each site belongs to at most one project. A person who works two projects in a day is split between them by the minutes — nothing to allocate or maintain."
        meta={
          <Select className="w-44" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
            {[0, -1, -2, -3, -4, -5].map((k) => {
              const m = addMonths(cur, k);
              return (
                <option key={m} value={m}>
                  {monthLabel(m)}
                </option>
              );
            })}
          </Select>
        }
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus /> New project
          </Button>
        }
      />
      {q.data && (
        <Notice>
          {q.data.meta.caveat} Source: {q.data.meta.source === 'snapshot' ? 'the payroll snapshot for this month' : 'the live engine (this month has not been run)'}.
          {q.data.meta.uncosted_people > 0 && ` ${q.data.meta.uncosted_people} people punched but could not be costed (no salary).`}
        </Notice>
      )}
      <Card>
        <CardHeader title={`Labour cost — ${monthLabel(month)}`} />
        {q.isLoading ? (
          <SkeletonRows rows={4} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data!.data.length ? (
          <EmptyState title="No projects" body="Create a project, then link sites to it from the Sites screen." />
        ) : (
          <table className="data-table w-full">
            <thead>
              <tr>
                <th>Project</th>
                <th>Client</th>
                <th className="text-right">Hours</th>
                <th className="text-right">People</th>
                <th className="text-right">Labour cost</th>
                <th className="text-right">Annual run rate</th>
                <th className="text-right">Of labour budget</th>
                <th className="text-right">Margin at this rate</th>
              </tr>
            </thead>
            <tbody>
              {q.data!.data.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="font-medium">{p.name}</span> <span className="font-mono text-[11px] text-muted-foreground">{p.code}</span>
                  </td>
                  <td>{p.client ?? '—'}</td>
                  <td className="text-right num">{mins(p.minutes)}</td>
                  <td className="text-right num">{p.people}</td>
                  <td className="text-right font-medium">
                    <Money value={p.labour_cost} />
                  </td>
                  <td className="text-right">
                    <Money value={p.annual_run_rate} />
                  </td>
                  <td className={cn('text-right num', (p.budget_used_pct ?? 0) > 100 && 'text-destructive')}>{p.budget_used_pct !== null ? `${p.budget_used_pct}%` : '—'}</td>
                  <td className="text-right">
                    <Money value={p.margin_at_rate} /> {p.margin_at_rate < 0 && <Chip tone="destructive">Loss</Chip>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {adding && <ProjectDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function ProjectDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ code: '', name: '', client: '', contract_value: '', budget_labour: '', material_cost: '', other_cost: '', started_on: '' });
  const save = useMutation({
    mutationFn: () =>
      api.post('/projects', {
        code: f.code,
        name: f.name,
        client: f.client || null,
        contract_value: toPaise(f.contract_value || '0'),
        budget_labour: toPaise(f.budget_labour || '0'),
        material_cost: toPaise(f.material_cost || '0'),
        other_cost: toPaise(f.other_cost || '0'),
        started_on: f.started_on || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['labour-cost'] });
      qc.invalidateQueries({ queryKey: ['lookups'] });
      toast.success('Project created');
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const money = (k: keyof typeof f, l: string) => <Field label={l}>{(id) => <MoneyInput id={id} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}</Field>;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      wide
      title="New project"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!f.code || !f.name} loading={save.isPending} onClick={() => save.mutate()}>
            Create
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Code">{(id) => <Input id={id} className="font-mono uppercase" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />}</Field>
        <Field label="Name" className="sm:col-span-2">
          {(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}
        </Field>
        <Field label="Client">{(id) => <Input id={id} value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} />}</Field>
        <Field label="Started on">{(id) => <Input id={id} type="date" value={f.started_on} onChange={(e) => setF({ ...f, started_on: e.target.value })} />}</Field>
        {money('contract_value', 'Contract value')}
        {money('budget_labour', 'Labour budget')}
        {money('material_cost', 'Material cost')}
        {money('other_cost', 'Other cost')}
      </div>
    </Dialog>
  );
}
