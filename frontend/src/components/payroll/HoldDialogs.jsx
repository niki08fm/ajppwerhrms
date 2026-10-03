import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { HELD_PAY_STATE_LABELS } from '@ajpwer/shared';
import { api, errorMessage } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { monthLabel } from '@/utils';
import { Money } from '@/components/bits';
import { Notice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { ChoiceCards, Field, Input, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';

function refreshHolds(qc, employeeId) {
  for (const key of [['held-salaries'], ['hold', employeeId], ['dashboard'], ['payroll-issues'], ['payroll-preview'], ['exit', employeeId], ['settlement', employeeId]]) qc.invalidateQueries({ queryKey: key });
}

/** Hold someone's salary from a payroll month not yet run. Without `employee`, HR picks the person. */
export function HoldDialog({ employee, openMonths, onClose }) {
  const qc = useQueryClient();
  const people = useQuery({
    queryKey: ['people', 'active-hold'],
    queryFn: () => api.get('/employees', { 'filter[status]': 'ACTIVE,NOTICE', limit: 200 }).then((r) => r.data),
    enabled: !employee,
  });
  const [f, setF] = useState({ employee_id: employee?.id ?? '', from_ym: openMonths[0] ?? '', reason: '' });
  const save = useMutation({
    mutationFn: () => api.post(`/employees/${f.employee_id}/hold`, { from_ym: f.from_ym, reason: f.reason }),
    onSuccess: () => {
      toast.success(`Salary held from ${monthLabel(f.from_ym)}. It is calculated as usual and kept out of the bank file until released.`);
      refreshHolds(qc, f.employee_id);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={employee ? `Hold ${employee.name}'s salary` : 'Hold a salary'}
      description="Each month while it is held, the salary is calculated as usual — payslip, PF, ESI, TDS — and kept out of the bank file. Nothing is lost: release it later into a payroll, or record it as paid separately."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!f.employee_id || !f.from_ym || f.reason.trim().length < 3} onClick={() => save.mutate()}>
            Hold salary
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {!employee && (
          <Field label="Person">
            {(id) => (
              <Select id={id} value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}>
                <option value="">Choose someone active or leaving…</option>
                {people.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.code}) — {p.designation}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="From the payroll for" hint="A month not run yet. It stays held every month until released.">
          {(id) => (
            <Select id={id} value={f.from_ym} onChange={(e) => setF({ ...f, from_ym: e.target.value })}>
              {openMonths.map((m) => (
                <option key={m} value={m}>
                  {monthLabel(m)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Reason">
          {(id) => <Input id={id} value={f.reason} placeholder="e.g. Documents pending, under inquiry" onChange={(e) => setF({ ...f, reason: e.target.value })} />}
        </Field>
      </div>
    </Dialog>
  );
}

/**
 * Release a held salary: paid with a payroll month — in its bank file, as its own line — or
 * recorded as paid separately, never in a bank file. Each held month is paid once.
 */
export function ReleaseDialog({ hold, openMonths, runMonths, onClose }) {
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const held = hold.months.filter((m) => m.state === 'HELD');
  const last = held.reduce((a, m) => (m.period_ym > a ? m.period_ym : a), '');
  // A held month run but not locked can be paid in that month itself; otherwise a later month not yet run.
  const sameMonth = held.length === 1 && runMonths.includes(held[0].period_ym) ? [held[0].period_ym] : [];
  const months = [...sameMonth, ...openMonths.filter((m) => m > last)];
  const anyRunOnly = held.some((m) => runMonths.includes(m.period_ym));
  const [f, setF] = useState({ mode: 'PAYROLL', pay_ym: months[0] ?? '', paid_on: lk?.today ?? '', payment_ref: '' });
  const total = held.reduce((a, m) => a + m.amount, 0);
  const save = useMutation({
    mutationFn: () =>
      api.post(`/employees/${hold.employee.id}/hold/release`, f.mode === 'PAYROLL' ? { mode: 'PAYROLL', pay_ym: f.pay_ym } : { mode: 'SEPARATE', paid_on: f.paid_on, payment_ref: f.payment_ref }),
    onSuccess: () => {
      toast.success(f.mode === 'PAYROLL' ? `Released: paid with ${monthLabel(f.pay_ym)} payroll.` : 'Released and recorded as paid separately. It will not go in any bank file.');
      refreshHolds(qc, hold.employee.id);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const ok = f.mode === 'PAYROLL' ? !!f.pay_ym : f.paid_on && f.payment_ref.trim().length >= 2;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Release ${hold.employee.name}'s salary`}
      description={
        <>
          {held.map((m) => `${monthLabel(m.period_ym)}`).join(', ')} — <Money value={total} paise={false} /> held. The hold ends; later months are paid as usual.
        </>
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!ok} onClick={() => save.mutate()}>
            Release
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <ChoiceCards
          name="release"
          value={f.mode}
          onChange={(mode) => setF({ ...f, mode })}
          options={[
            { value: 'PAYROLL', label: 'Pay it with a payroll', description: 'Added to that month’s payslip as “Held salary for …” and paid in its bank file.' },
            {
              value: 'SEPARATE',
              label: 'Paid separately',
              description: 'By cheque, cash or a separate transfer. Recorded with its date and reference; it never goes in a bank file.',
              disabled: anyRunOnly,
            },
          ]}
        />
        {f.mode === 'PAYROLL' ? (
          months.length ? (
            <Field label="Payroll month">
              {(id) => (
                <Select id={id} value={f.pay_ym} onChange={(e) => setF({ ...f, pay_ym: e.target.value })}>
                  {months.map((m) => (
                    <option key={m} value={m}>
                      {monthLabel(m)}
                      {sameMonth.includes(m) ? ' — the month itself, run and not yet locked' : ''}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : (
            <Notice tone="warning">No payroll month is open after the held months. Lock or run the payroll first.</Notice>
          )
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Paid on">{(id) => <Input id={id} type="date" value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} />}</Field>
            <Field label="Reference" hint="Cheque or transfer number">
              {(id) => <Input id={id} value={f.payment_ref} onChange={(e) => setF({ ...f, payment_ref: e.target.value })} />}
            </Field>
          </div>
        )}
        {anyRunOnly && <p className="text-[13px] text-muted-foreground">A held month is run but not locked: pay it in that month, or lock that payroll first.</p>}
      </div>
    </Dialog>
  );
}

/** Where a held month stands, in words. */
export function heldMonthStatus(m) {
  if (m.state === 'QUEUED') return `Paid with ${monthLabel(m.pay_ym)} payroll, when it runs`;
  if (m.state === 'PAID') return m.with_settlement ? `Paid with the F&F (${monthLabel(m.pay_ym)})` : `Paid with ${monthLabel(m.pay_ym)} payroll`;
  if (m.state === 'PAID_SEPARATELY') return `Paid separately${m.paid_on ? ` on ${m.paid_on}` : ''}${m.payment_ref ? `, ${m.payment_ref}` : ''}`;
  return HELD_PAY_STATE_LABELS[m.state];
}
