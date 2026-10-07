import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { cn, longDate } from '@/utils';
import { Money } from '@/components/bits';
import { Chip, EmptyState, ErrorState, Notice, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { useSalaryPreview } from '../SalaryPreview';
import { agreement, annualText, SalaryAmountFields } from '../SalaryEntry';

export function refreshEmployeePay(qc, employeeId) {
  for (const key of ['employee', 'salary-history', 'employee-pay', 'employee-tax', 'payslip-preview', 'timeline', 'emp-attendance', 'emp-leave'])
    qc.invalidateQueries({ queryKey: [key, employeeId] });
  for (const key of [
    'people',
    'pay-groups',
    'pay-group',
    'pay-group-employees',
    'salary-preview',
    'period',
    'periods',
    'payroll-summary',
    'payroll-preview',
    'payroll-attendance',
    'payroll-joiners',
    'payroll-issues',
  ])
    qc.invalidateQueries({ queryKey: [key] });
}

/** Group policies and an employee's salary structure are saved independently. */
export function PayGroupControl({ e }) {
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const [group, setGroup] = useState(e.pay_group.id);
  useEffect(() => setGroup(e.pay_group.id), [e.pay_group.id]);
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/employees/${e.id}`, {
        pay_group_id: group,
        updated_at: e.updated_at,
      }),
    onSuccess: () => {
      toast.success('Pay group changed. Salary amount and structure are unchanged.');
      refreshEmployeePay(qc, e.id);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Pay group" className="min-w-0 flex-[1_1_12rem]">
          {(id) => (
            <Select id={id} value={group} disabled={e.read_only || save.isPending} onChange={(ev) => setGroup(ev.target.value)}>
              {(lk?.pay_groups ?? [e.pay_group]).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {!e.read_only && (
          <Button variant="outline" loading={save.isPending} disabled={!group || group === e.pay_group.id} onClick={() => save.mutate()}>
            Save pay group
          </Button>
        )}
      </div>
      <p className="text-[13px] text-muted-foreground">
        Saved separately. The group's shift, attendance, overtime and leave rules apply. Salary amount and salary structure stay unchanged.
      </p>
    </div>
  );
}

export function SalaryHistoryTab({ e, compact = false }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['salary-history', e.id],
    queryFn: () => api.get(`/employees/${e.id}/salary`).then((r) => r.data),
  });
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const remove = useMutation({
    mutationFn: () => api.del(`/employees/${e.id}/salary/${removing.id}`),
    onSuccess: () => {
      toast.success('Salary revision removed. Adjacent salary periods have been updated.');
      refreshEmployeePay(qc, e.id);
      setRemoving(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const rows = (q.data ?? []).slice().sort((a, b) => b.valid_from.localeCompare(a.valid_from));
  const controls = (r) => {
    const canDelete = !e.read_only && rows.length > 1 && r.can_delete !== false;
    const deletionReason = rows.length < 2 ? 'At least one salary agreement must remain.' : r.deletion_reason;
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!e.read_only && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={r.can_edit === false}
              title={r.protection_reason ?? undefined}
              aria-label={`Edit salary from ${r.valid_from}`}
              onClick={() => setEditing(r)}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={!canDelete}
              title={deletionReason ?? undefined}
              aria-label={`Delete salary from ${r.valid_from}`}
              onClick={() => setRemoving(r)}
            >
              Delete
            </Button>
          </>
        )}
        {(r.protection_reason || deletionReason) && <span className="text-[12px] text-muted-foreground">{r.protection_reason || deletionReason}</span>}
      </div>
    );
  };
  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader
        title="Salary revisions"
        description="Effective dates, amounts and selected structures. At least one salary agreement is retained; locked or paid payroll protects related revisions."
      />
      {q.isLoading ? (
        <SkeletonRows rows={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !rows.length ? (
        <EmptyState title="No salary yet" body="Add an agreement with its effective date and salary structure." />
      ) : compact ? (
        <div className="max-h-[620px] overflow-y-auto px-5">
          {rows.map((r) => (
            <div key={r.id} className="border-b py-4 last:border-0">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="font-medium text-[14px]">
                  {longDate(r.valid_from)} {!r.valid_to && <Chip tone="success">Latest</Chip>}
                </div>
                <b className="num">
                  <Money value={r.monthly_gross} />
                  <span className="font-normal text-[12px] text-muted-foreground"> / month</span>
                </b>
              </div>
              <div className="mt-1 text-[13px] text-muted-foreground">
                {r.valid_to ? `Through ${longDate(r.valid_to)} · ` : ''}
                {r.structure?.name ?? 'No structure'} · {r.mode === 'CTC' ? 'Annual CTC' : 'Annual gross'}{' '}
                <Money value={r.mode === 'CTC' ? r.amount : r.monthly_gross * 12} />
              </div>
              <p className="mt-1 text-[13px] break-words">{r.reason || '—'}</p>
              {controls(r)}
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table w-full">
            <thead>
              <tr>
                <th>From / through</th>
                <th>Agreed as</th>
                <th className="text-right">Annual amount</th>
                <th className="text-right">Monthly gross</th>
                <th>Structure / reason</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="num">
                    {r.valid_from}
                    <div className="text-[12px] text-muted-foreground">{r.valid_to ?? 'Latest agreement'}</div>
                  </td>
                  <td>{r.mode === 'CTC' ? 'CTC' : 'Gross'}</td>
                  <td className="text-right">
                    <Money value={r.mode === 'CTC' ? r.amount : r.monthly_gross * 12} />
                  </td>
                  <td className="text-right">
                    <Money value={r.monthly_gross} />
                  </td>
                  <td>
                    {r.structure?.name ?? '—'}
                    <div className="text-[12px] text-muted-foreground">{r.reason}</div>
                  </td>
                  <td>{controls(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <ReviseDialog e={e} revision={editing} onClose={() => setEditing(null)} />}
      <Dialog
        open={!!removing}
        onOpenChange={(open) => !open && !remove.isPending && setRemoving(null)}
        title="Delete salary revision"
        description="Removing this agreement adjusts adjacent salary periods. At least one agreement must remain."
        footer={
          <>
            <Button variant="outline" disabled={remove.isPending} onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button className="bg-destructive text-destructive-foreground" loading={remove.isPending} onClick={() => remove.mutate()}>
              Delete revision
            </Button>
          </>
        }
      >
        {removing && (
          <p>
            Salary from <strong>{longDate(removing.valid_from)}</strong>: <Money value={removing.monthly_gross} /> monthly gross.
          </p>
        )}
      </Dialog>
    </Card>
  );
}

/** Add an explicitly structured first agreement, revise it, or correct an unlocked history row. */
export function ReviseDialog({ e, initialSalary = e.salary, revision = null, onClose }) {
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const cur = revision ?? initialSalary;
  const [f, setF] = useState({
    mode: cur?.mode ?? 'GROSS',
    amount: cur ? annualText(cur.mode, cur.amount, cur.monthly_gross) : '',
    valid_from: revision?.valid_from ?? '',
    structure_id: cur?.structure_id ?? cur?.structure?.id ?? '',
    reason: revision?.reason ?? '',
  });
  const [chosen, setChosen] = useState(cur?.mode === 'CTC' ? cur.monthly_gross : undefined);
  const before = useSalaryPreview(
    {
      mode: cur?.mode ?? 'GROSS',
      amount: cur?.amount ?? 0,
      employee_id: e.id,
      structure_id: cur?.structure_id ?? cur?.structure?.id,
      chosen_gross: cur?.monthly_gross,
      date: revision?.valid_from,
    },
    !!cur,
  );
  const after = useSalaryPreview(
    {
      ...agreement(f.mode, f.amount),
      employee_id: e.id,
      structure_id: f.structure_id || undefined,
      chosen_gross: chosen,
      date: f.valid_from || undefined,
    },
    !!f.structure_id && !!f.valid_from,
  );
  const change = (field, value) => {
    setF((old) => ({ ...old, [field]: value }));
    setChosen(undefined);
  };
  const save = useMutation({
    mutationFn: () => {
      const body = {
        ...agreement(f.mode, f.amount),
        valid_from: f.valid_from,
        structure_id: f.structure_id,
        reason: f.reason.trim(),
        ...(chosen !== undefined ? { chosen_gross: chosen } : {}),
      };
      return revision ? api.patch(`/employees/${e.id}/salary/${revision.id}`, body) : api.post(`/employees/${e.id}/salary`, body);
    },
    onSuccess: () => {
      toast.success(revision ? 'Salary revision updated.' : cur ? `Salary revised from ${f.valid_from}.` : `Salary added from ${f.valid_from}.`);
      refreshEmployeePay(qc, e.id);
      onClose();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const b = before.data;
  const a = after.data;
  const amounts = [
    ['Annual gross', b && b.gross * 12, a && a.gross * 12],
    ['Monthly gross', b?.gross, a?.gross],
    ['Take-home', b?.take_home, a?.take_home],
    ['Employer cost per month', b?.ctc.monthly_cost, a?.ctc.monthly_cost],
    ['Annual CTC', b?.ctc.annual_ctc, a?.ctc.annual_ctc],
  ];
  const disabled =
    !f.structure_id ||
    !f.valid_from ||
    f.valid_from < e.joined_on ||
    f.reason.trim().length < 3 ||
    f.reason.trim().length > 300 ||
    agreement(f.mode, f.amount).amount <= 0 ||
    (a?.solution?.ambiguous && chosen === undefined) ||
    (f.mode === 'CTC' && (!a || after.isInputPending || after.isFetching || after.isError)) ||
    e.read_only;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !save.isPending && onClose()}
      wide
      title={revision ? 'Edit salary revision' : cur ? 'Revise salary' : 'Add salary'}
      description="Choose the employee's salary structure explicitly. The pay valid on the last day of a month applies to that month."
      footer={
        <>
          <Button variant="outline" disabled={save.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={disabled} onClick={() => save.mutate()}>
            {revision ? 'Save changes' : cur ? 'Save revision' : 'Add salary'}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-2">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <SalaryAmountFields mode={f.mode} annual={f.amount} onMode={(mode) => change('mode', mode)} onAnnual={(amount) => change('amount', amount)} />
            <Field label="Effective from" required hint={`On or after ${longDate(e.joined_on)}`}>
              {(id) => <Input id={id} type="date" min={e.joined_on} value={f.valid_from} onChange={(ev) => change('valid_from', ev.target.value)} />}
            </Field>
            <Field label="Salary structure" required>
              {(id) => (
                <Select id={id} value={f.structure_id} onChange={(ev) => change('structure_id', ev.target.value)}>
                  <option value="">Choose a structure</option>
                  {(lk?.structures ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Reason" required className="col-span-2">
              {(id) => (
                <Input
                  id={id}
                  maxLength={300}
                  value={f.reason}
                  onChange={(ev) => setF((old) => ({ ...old, reason: ev.target.value }))}
                  placeholder={cur ? 'e.g. Annual increment' : 'e.g. Initial salary agreement'}
                />
              )}
            </Field>
          </div>
          <div className="rounded-md border bg-muted/30 p-3">
            <PayGroupControl e={e} />
          </div>
          {a?.solution?.ambiguous && (
            <Notice tone="warning">
              This CTC has two valid monthly grosses. Choose one.
              {[
                { g: a.solution.gross, label: 'without ESI' },
                { g: a.solution.alternative.gross, label: 'with ESI' },
              ].map((o) => (
                <label key={o.g} className="mt-1 flex items-center gap-2">
                  <input type="radio" name="revision-gross" checked={chosen === o.g} onChange={() => setChosen(o.g)} />
                  <Money value={o.g} /> {o.label}
                </label>
              ))}
            </Notice>
          )}
        </div>
        <div className="min-w-0">
          <h4 className="mb-2 font-medium">Salary preview</h4>
          {!f.amount || !f.valid_from || !f.structure_id ? (
            <p className="text-sm text-muted-foreground">Enter the amount, effective date and salary structure to see the calculation.</p>
          ) : after.isError ? (
            <>
              <ErrorState error={after.error} compact onRetry={() => after.refetch()} />
              {f.mode === 'GROSS' && (
                <p className="mt-2 text-[13px] text-muted-foreground">
                  The gross agreement can still be saved. Deductions will be calculated when the applicable statutory rates are available.
                </p>
              )}
            </>
          ) : (
            <div className={cn('overflow-x-auto', after.isFetching && 'opacity-60')}>
              <table className="w-full text-[14px]">
                <thead className="text-left text-[13px] text-muted-foreground">
                  <tr>
                    <th className="py-1" />
                    {cur && <th className="text-right">Before</th>}
                    {cur && <th />}
                    <th className="text-right">{cur ? 'After' : 'Amount'}</th>
                  </tr>
                </thead>
                <tbody>
                  {amounts.map(([label, x, y]) => (
                    <tr key={label} className="border-t">
                      <td className="py-2">{label}</td>
                      {cur && (
                        <td className="text-right">
                          <Money value={x} />
                        </td>
                      )}
                      {cur && (
                        <td className="px-1 text-muted-foreground">
                          <ArrowRight className="size-3" />
                        </td>
                      )}
                      <td className="text-right">
                        <Money value={y} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
