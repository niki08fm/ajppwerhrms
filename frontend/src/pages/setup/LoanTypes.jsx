import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HandCoins, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useSession } from '@/context/SessionContext';
import { api, errorMessage } from '@/services/api';
import { toPaise, toRupeesInput } from '@/utils';
import { PageHeader } from '@/components/bits';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, MoneyInput, Select } from '@/components/ui/form';
import { Dialog, Switch } from '@/components/ui/overlay';

const METHOD = {
  EQUAL_INSTALMENTS: 'Equal instalments (chosen when granting)',
  FIXED_AMOUNT: 'Fixed amount a month (entered when granting)',
  PCT_OF_GROSS: 'A percentage of gross each month',
};

/** Setup: the kinds of loans and advances HR grants, and the limits each one checks. */
export default function LoanTypes() {
  const { can } = useSession();
  const [editing, setEditing] = useState(null);
  const q = useQuery({ queryKey: ['loan-types'], queryFn: () => api.get('/loan-types').then((r) => r.data) });
  const manage = can('setup.write');
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Loan and advance types"
        description="Each type sets how much can be granted, over how many instalments and how it is recovered. Granting checks these limits; payroll recovers the instalment fixed when granted, within the overall recovery cap."
        actions={manage && <Button onClick={() => setEditing({})}><Plus /> New type</Button>}
      />
      {q.isLoading ? <SkeletonRows rows={4} /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data.length ? (
        <EmptyState title="No types yet" body="Add a type for each kind of loan or advance you give, with its limits." icon={<HandCoins className="size-6" />} />
      ) : (
        ['LOAN', 'ADVANCE'].map((kind) => {
          const rows = q.data.filter((t) => t.kind === kind);
          if (!rows.length) return null;
          return (
            <Card key={kind}>
              <CardHeader title={kind === 'LOAN' ? 'Loans' : 'Advances'} />
              <ul className="divide-y">
                {rows.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{t.name} {!t.active && <Chip tone="muted">Off</Chip>}</p>
                      <p className="mt-1 text-[13px] text-muted-foreground">{t.description}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {t.recovering > 0 && <Chip tone="info">{t.recovering} recovering</Chip>}
                      {manage && <Button size="sm" variant="ghost" aria-label={`Edit ${t.name}`} onClick={() => setEditing(t)}><Pencil /></Button>}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          );
        })
      )}
      {editing && <TypeDialog type={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TypeDialog({ type, onClose }) {
  const qc = useQueryClient();
  const isNew = !type.id;
  const [f, setF] = useState({
    name: type.name ?? '',
    kind: type.kind ?? 'LOAN',
    active: type.active ?? true,
    multiple: type.max_gross_multiple ?? '',
    cap: type.max_amount ? toRupeesInput(type.max_amount) : '',
    instalments: String(type.max_instalments ?? 12),
    method: type.recovery_method ?? 'EQUAL_INSTALMENTS',
    pct: type.recovery_pct ?? '',
    maxPct: type.max_instalment_pct ?? '',
    service: String(type.min_service_months ?? 0),
    oneAtATime: type.one_at_a_time ?? true,
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const num = (v) => (v === '' || v === null ? null : Number(v));
  const body = {
    name: f.name.trim(),
    ...(isNew ? { kind: f.kind } : {}),
    active: f.active,
    max_gross_multiple: num(f.multiple),
    max_amount: f.cap ? toPaise(f.cap) : null,
    max_instalments: Number(f.instalments),
    recovery_method: f.method,
    recovery_pct: f.method === 'PCT_OF_GROSS' ? num(f.pct) : null,
    max_instalment_pct: num(f.maxPct),
    min_service_months: Number(f.service || 0),
    one_at_a_time: f.oneAtATime,
  };
  const save = useMutation({
    mutationFn: () => (isNew ? api.post('/loan-types', body) : api.patch(`/loan-types/${type.id}`, body)),
    onSuccess: () => {
      toast.success(isNew ? 'Type added' : 'Type saved. Loans already granted keep their instalments.');
      qc.invalidateQueries({ queryKey: ['loan-types'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/loan-types/${type.id}`),
    onSuccess: () => { toast.success('Type deleted'); qc.invalidateQueries({ queryKey: ['loan-types'] }); onClose(); },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const valid = body.name.length >= 2 && body.max_instalments >= 1 && body.max_instalments <= 120 && (f.method !== 'PCT_OF_GROSS' || body.recovery_pct > 0);
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title={isNew ? 'New loan or advance type' : `Edit ${type.name}`}
      description="Limits apply when granting. Changing them later does not change loans already granted."
      footer={
        <>
          {!isNew && <Button variant="ghost" className="mr-auto text-destructive" loading={remove.isPending} onClick={() => remove.mutate()}><Trash2 /> Delete</Button>}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!valid} loading={save.isPending} onClick={() => save.mutate()}>{isNew ? 'Add type' : 'Save'}</Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" required>{(id) => <Input id={id} value={f.name} maxLength={40} onChange={set('name')} placeholder="e.g. Personal loan" />}</Field>
        <Field label="Kind">{(id) => (
          <Select id={id} value={f.kind} disabled={!isNew} onChange={set('kind')}>
            <option value="LOAN">Loan</option>
            <option value="ADVANCE">Advance</option>
          </Select>
        )}</Field>
        <Field label="Most: months of gross" hint="1 = one month's gross. Blank: no such limit.">{(id) => <Input id={id} type="number" min={0.1} step={0.5} value={f.multiple} onChange={set('multiple')} className="num" />}</Field>
        <Field label="Most: amount" hint="Blank: no such limit. With both, the lower applies.">{(id) => <MoneyInput id={id} value={f.cap} onChange={set('cap')} />}</Field>
        <Field label="How it is recovered" className="sm:col-span-2">{(id) => (
          <Select id={id} value={f.method} onChange={set('method')}>
            {Object.entries(METHOD).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </Select>
        )}</Field>
        {f.method === 'PCT_OF_GROSS' && (
          <Field label="Recovered each month (% of gross)" required>{(id) => <Input id={id} type="number" min={1} max={100} value={f.pct} onChange={set('pct')} className="num" />}</Field>
        )}
        <Field label="Most instalments" required>{(id) => <Input id={id} type="number" min={1} max={120} value={f.instalments} onChange={set('instalments')} className="num" />}</Field>
        <Field label="A month's instalment at most (% of gross)" hint="Blank: no limit beyond the overall recovery cap.">{(id) => <Input id={id} type="number" min={1} max={100} value={f.maxPct} onChange={set('maxPct')} className="num" />}</Field>
        <Field label="Months of service first">{(id) => <Input id={id} type="number" min={0} max={120} value={f.service} onChange={set('service')} className="num" />}</Field>
        <Field label="One at a time">{(id) => <div className="flex h-8 items-center"><Switch id={id} checked={f.oneAtATime} onCheckedChange={(v) => setF({ ...f, oneAtATime: v })} label="One at a time" /></div>}</Field>
        <Field label="Active">{(id) => <div className="flex h-8 items-center"><Switch id={id} checked={f.active} onCheckedChange={(v) => setF({ ...f, active: v })} label="Active" /></div>}</Field>
      </div>
    </Dialog>
  );
}
