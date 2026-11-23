import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { formatINR, istDate } from '@ajpwer/shared';
import { useSession } from '@/context/SessionContext';
import { api, errorMessage } from '@/services/api';
import { useDebounced } from '@/hooks';
import { toPaise } from '@/utils';
import { Money as M, PageHeader, PersonLink, Stat } from '@/components/bits';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, MoneyInput, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';

export default function MoneyPage() {
  const { can } = useSession();
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 250);
  const [status, setStatus] = useState('ACTIVE');
  const [granting, setGranting] = useState(null);
  const r = useQuery({
    queryKey: ['advances-loans', 'all', dq, status],
    queryFn: () => api.get('/advances-loans', { q: dq, 'filter[status]': status }).then((x) => x.data),
  });
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Advances and loans"
        description="Record loans and advances, set repayments and track the balance recovered through payroll."
        actions={can('salary.write') && (
          <>
            <Button variant="outline" onClick={() => setGranting('ADVANCE')}>
              <Plus /> New advance
            </Button>
            <Button onClick={() => setGranting('LOAN')}>
              <Plus /> New loan
            </Button>
          </>
        )}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Outstanding" value={r.data ? <M value={r.data.totals.outstanding} /> : '—'} />
        <Stat label="Active" value={r.data?.totals.active ?? '—'} />
        <Stat label="Carried forward" value={r.data ? <M value={r.data.carries.reduce((a, c) => a + c.amount, 0)} /> : '—'} sub={r.data ? `${r.data.carries.length} people` : undefined} />
      </div>
      <Card>
        <div className="flex flex-wrap gap-2 border-b px-3 py-2">
          <Input className="w-64" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or code" aria-label="Search" />
          <Select className="w-40" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="ACTIVE">Recovering</option>
            <option value="CLOSED">Closed</option>
            <option value="">All</option>
          </Select>
        </div>
        {r.isLoading ? (
          <SkeletonRows rows={6} />
        ) : r.isError ? (
          <ErrorState error={r.error} onRetry={() => r.refetch()} />
        ) : !r.data.rows.length ? (
          <EmptyState title={dq ? 'No matching records' : status === 'ACTIVE' ? 'No repayments in progress' : 'No records in this view'} body={dq ? 'Try another employee name or code, or change the status filter.' : 'Use the status filter to see other records. New loans and advances appear here once recorded.'} />
        ) : (
          <div className="overflow-x-auto"><table className="data-table w-full">
            <thead>
              <tr>
                <th>Person</th>
                <th>Type</th>
                <th>Detail</th>
                <th>Started</th>
                <th className="text-right">Amount</th>
                <th className="text-right">Instalment</th>
                <th className="text-right">Recovered</th>
                <th className="text-right">Outstanding</th>
                <th className="text-right">Months left</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {r.data.rows.map((x) => (
                <tr key={x.id}>
                  <td>
                    <PersonLink id={x.employee.id} name={x.employee.name} code={x.employee.code} tab="loans" />
                  </td>
                  <td>{x.type === 'LOAN' ? 'Loan' : 'Advance'}</td>
                  <td>{x.type === 'ADVANCE' && x.type_name ? `${x.type_name} · ${x.label}` : x.label}</td>
                  <td className="num">{x.started_on}</td>
                  <td className="text-right">
                    <M value={x.amount} />
                  </td>
                  <td className="text-right">
                    <M value={x.instalment} />
                  </td>
                  <td className="text-right">
                    <M value={x.recovered} />
                  </td>
                  <td className="text-right font-medium">
                    <M value={x.outstanding} />
                  </td>
                  <td className="text-right num">{x.instalments_left}</td>
                  <td>
                    <Chip tone={x.status === 'ACTIVE' ? 'info' : 'muted'}>{x.status === 'ACTIVE' ? 'Recovering' : 'Closed'}</Chip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
      {r.data && r.data.carries.length > 0 && (
        <Card>
          <CardHeader title="Carry-forward balances" description="Held back by the recovery cap; taken first next month." />
          <ul className="divide-y text-[14px]">
            {r.data.carries.map((c) => (
              <li key={c.id} className="flex justify-between px-4 py-2">
                <PersonLink id={c.employee.id} name={c.employee.name} code={c.employee.code} />
                <span>
                  <M value={c.amount} /> in {c.period_ym}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {granting && <GrantDialog type={granting} onClose={() => setGranting(null)} />}
    </div>
  );
}

export function GrantDialog({ type, employee, onClose }) {
  const qc = useQueryClient();
  const people = useQuery({ queryKey: ['people', 'active-money'], queryFn: () => api.get('/employees', { 'filter[status]': 'ACTIVE,NOTICE', limit: 200 }).then((r) => r.data), enabled: !employee });
  const types = useQuery({ queryKey: ['loan-types'], queryFn: () => api.get('/loan-types').then((r) => r.data) });
  const choices = (types.data ?? []).filter((t) => t.kind === type && t.active);
  const today = istDate(new Date());
  const [f, setF] = useState({ employee_id: employee?.id ?? '', type_id: '', amount: '', instalments: '', instalment: '', reason: '', date: today });
  const kind = choices.find((t) => t.id === f.type_id) ?? null;
  const amount = toPaise(f.amount);
  const instalments = Number(f.instalments);
  const instalment = toPaise(f.instalment);
  const ready = !!f.employee_id && !!kind && amount > 0
    && (kind.recovery_method !== 'EQUAL_INSTALMENTS' || (Number.isInteger(instalments) && instalments >= 1))
    && (kind.recovery_method !== 'FIXED_AMOUNT' || instalment > 0);
  const debounced = useDebounced(JSON.stringify({ e: f.employee_id, t: f.type_id, a: amount, n: f.instalments, i: instalment, d: f.date }), 300);
  const plan = useQuery({
    queryKey: ['loan-plan', debounced],
    queryFn: () => api.post('/loans/preview', { type_id: f.type_id, employee_id: f.employee_id, amount, granted_on: f.date, ...(kind?.recovery_method === 'EQUAL_INSTALMENTS' ? { instalments } : {}), ...(kind?.recovery_method === 'FIXED_AMOUNT' ? { instalment } : {}) }).then((r) => r.data),
    enabled: ready,
  });
  const ok = ready && plan.data && !plan.data.errors.length && (type === 'LOAN' || f.reason.trim().length >= 3);
  const save = useMutation({
    mutationFn: () =>
      type === 'LOAN'
        ? api.post('/loans', { employee_id: f.employee_id, type_id: f.type_id, principal: amount, started_on: f.date, ...(kind.recovery_method === 'EQUAL_INSTALMENTS' ? { months: instalments } : {}), ...(kind.recovery_method === 'FIXED_AMOUNT' ? { instalment } : {}) })
        : api.post('/advances', { employee_id: f.employee_id, type_id: f.type_id, amount, reason: f.reason.trim(), granted_on: f.date, ...(kind.recovery_method === 'EQUAL_INSTALMENTS' ? { instalments } : {}), ...(kind.recovery_method === 'FIXED_AMOUNT' ? { instalment } : {}) }),
    onSuccess: () => {
      toast.success(type === 'LOAN' ? 'Loan recorded' : 'Advance recorded');
      for (const key of ['advances-loans', 'settlement', 'payroll-preview', 'payroll-summary', 'payroll-issues', 'payroll-fnf', 'loan-types']) qc.invalidateQueries({ queryKey: [key] });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !save.isPending && onClose()}
      title={type === 'LOAN' ? 'New loan' : 'New advance'}
      description="Choose the type: its limits are checked against this person's salary. This records the recovery through payroll; it does not transfer money."
      footer={
        <>
          <Button variant="outline" disabled={save.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!ok} onClick={() => save.mutate()}>
            {type === 'LOAN' ? 'Record loan' : 'Record advance'}
          </Button>
        </>
      }
    >
      {save.isError && <p role="alert" className="mb-3 text-sm text-destructive">{errorMessage(save.error)}{save.error?.code === 'NETWORK' && ' Check the records before trying again; the server may have received this request.'}</p>}
      {!employee && people.isError && <ErrorState error={people.error} onRetry={() => people.refetch()} />}
      {types.data && !choices.length && <p className="mb-3 text-sm text-muted-foreground">No active {type === 'LOAN' ? 'loan' : 'advance'} types. Add one under Setup → Loan and advance types.</p>}
      <fieldset disabled={save.isPending} className="grid gap-3 sm:grid-cols-2">
        {employee ? (
          <p className="sm:col-span-2 text-[14px]">For {employee.name}</p>
        ) : (
          <Field label="Person" className="sm:col-span-2">
            {(id) => (
              <Select id={id} value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}>
                <option value="">{people.isLoading ? 'Loading employees…' : 'Choose an employee…'}</option>
                {people.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.code})
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label={type === 'LOAN' ? 'Loan type' : 'Advance type'} className="sm:col-span-2" hint={kind ? (plan.data?.description ?? kind.description) : undefined}>
          {(id) => (
            <Select id={id} value={f.type_id} onChange={(e) => setF({ ...f, type_id: e.target.value })}>
              <option value="">Choose a type…</option>
              {choices.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label={type === 'LOAN' ? 'Principal' : 'Amount'} hint={plan.data?.limit != null ? `Most for this person: ${formatINR(plan.data.limit)}` : undefined}>{(id) => <MoneyInput id={id} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />}</Field>
        {kind?.recovery_method === 'EQUAL_INSTALMENTS' && (
          <Field label="Instalments" hint={`At most ${kind.max_instalments}`}>{(id) => <Input id={id} type="number" min={1} max={kind.max_instalments} value={f.instalments} onChange={(e) => setF({ ...f, instalments: e.target.value })} className="num" />}</Field>
        )}
        {kind?.recovery_method === 'FIXED_AMOUNT' && (
          <Field label="Instalment per month">{(id) => <MoneyInput id={id} value={f.instalment} onChange={(e) => setF({ ...f, instalment: e.target.value })} />}</Field>
        )}
        {type === 'ADVANCE' && <Field label="Reason">{(id) => <Input id={id} maxLength={300} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}</Field>}
        <Field label={type === 'LOAN' ? 'First EMI month from' : 'Granted on'}>{(id) => <Input id={id} type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />}</Field>
      </fieldset>
      {ready && plan.data && (
        <div className="mt-4 rounded-md border p-3 text-[14px]" role="status">
          {plan.data.errors.length ? (
            <ul className="list-disc space-y-1 pl-5 text-destructive">{plan.data.errors.map((e) => <li key={e}>{e}</li>)}</ul>
          ) : (
            <p>
              Recovers <strong>{formatINR(plan.data.instalment)}</strong> a month for <strong>{plan.data.months}</strong> month{plan.data.months === 1 ? '' : 's'}
              {plan.data.last_instalment !== plan.data.instalment ? ` (last ${formatINR(plan.data.last_instalment)})` : ''}. Monthly gross {formatINR(plan.data.gross)}.
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
