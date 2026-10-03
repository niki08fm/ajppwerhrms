import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
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
        description="Recovered through payroll after statutory deductions, capped at 40% of gross minus statutory. What the cap holds back carries into next month."
        actions={
          <>
            <Button variant="outline" onClick={() => setGranting('ADVANCE')}>
              <Plus /> New advance
            </Button>
            <Button onClick={() => setGranting('LOAN')}>
              <Plus /> New loan
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Stat label="Outstanding" value={<M value={r.data?.totals.outstanding ?? 0} />} />
        <Stat label="Active" value={r.data?.totals.active ?? 0} />
        <Stat label="Carried forward" value={<M value={(r.data?.carries ?? []).reduce((a, c) => a + c.amount, 0)} />} sub={`${r.data?.carries.length ?? 0} people`} />
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
          <EmptyState title="Nothing lent" body="Grant an advance or a loan to someone; it is recovered through payroll." />
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
                  <td>{x.label}</td>
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
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ employee_id: employee?.id ?? '', amount: '', months: '6', instalment: '', reason: '', loan_type: 'Personal loan', date: today });
  const emi = toPaise(f.amount) && Number(f.months) ? Math.ceil(toPaise(f.amount) / Number(f.months)) : 0;
  const save = useMutation({
    mutationFn: () =>
      type === 'LOAN'
        ? api.post('/loans', { employee_id: f.employee_id, loan_type: f.loan_type, principal: toPaise(f.amount), months: Number(f.months), started_on: f.date })
        : api.post('/advances', { employee_id: f.employee_id, amount: toPaise(f.amount), reason: f.reason, granted_on: f.date, instalment: toPaise(f.instalment) }),
    onSuccess: () => {
      toast.success(type === 'LOAN' ? 'Loan granted' : 'Advance granted');
      qc.invalidateQueries({ queryKey: ['advances-loans'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={type === 'LOAN' ? 'New loan' : 'New advance'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!f.employee_id || !toPaise(f.amount) || (type === 'ADVANCE' && (!toPaise(f.instalment) || f.reason.length < 3))} onClick={() => save.mutate()}>
            Grant
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {employee ? (
          <p className="sm:col-span-2 text-[14px]">For {employee.name}</p>
        ) : (
          <Field label="Person" className="sm:col-span-2">
            {(id) => (
              <Select id={id} value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}>
                <option value="">Choose…</option>
                {people.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.code})
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {type === 'LOAN' ? (
          <>
            <Field label="Loan type">{(id) => <Input id={id} value={f.loan_type} onChange={(e) => setF({ ...f, loan_type: e.target.value })} />}</Field>
            <Field label="Principal">{(id) => <MoneyInput id={id} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />}</Field>
            <Field label="Months" hint={emi ? `EMI ₹${Math.round(emi / 100).toLocaleString('en-IN')}` : undefined}>
              {(id) => <Input id={id} type="number" min={1} value={f.months} onChange={(e) => setF({ ...f, months: e.target.value })} />}
            </Field>
            <Field label="First EMI month from">{(id) => <Input id={id} type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />}</Field>
          </>
        ) : (
          <>
            <Field label="Amount">{(id) => <MoneyInput id={id} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />}</Field>
            <Field label="Instalment per month">{(id) => <MoneyInput id={id} value={f.instalment} onChange={(e) => setF({ ...f, instalment: e.target.value })} />}</Field>
            <Field label="Reason">{(id) => <Input id={id} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}</Field>
            <Field label="Granted on">{(id) => <Input id={id} type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />}</Field>
          </>
        )}
      </div>
    </Dialog>
  );
}
