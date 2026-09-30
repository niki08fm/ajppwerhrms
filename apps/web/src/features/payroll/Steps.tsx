import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ADHOC_KINDS, ADHOC_TARGETS, DAY_STATUS_LABELS, type DayStatus } from '@ajpwer/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { mins, monthLabel, toPaise } from '@/lib/utils';
import { Money, PersonLink, Stat } from '@/components/bits';
import { DataTable, type Col } from '@/components/data-table';
import { Chip, EmployeeStatusChip, EmptyState, ErrorState, LockedNotice, Notice, SeverityChip, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, MoneyInput, Select, Textarea } from '@/components/ui/form';
import { Checkbox, Dialog } from '@/components/ui/overlay';
import { CorrectionDrawer } from '../attendance/CorrectionDrawer';
import type { Period } from './RunPayroll';

function useStepActions(ym: string, n: number, onDone?: () => void) {
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['period', ym] });
    qc.invalidateQueries({ queryKey: ['payroll-issues', ym] });
  };
  const submit = useMutation({
    mutationFn: () => api.post(`/payroll/periods/${ym}/steps/${n}/submit`),
    onSuccess: () => {
      toast.success(`Step ${n} submitted`);
      refresh();
      onDone?.();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reopen = useMutation({
    mutationFn: () => api.post(`/payroll/periods/${ym}/steps/${n}/reopen`),
    onSuccess: () => {
      toast.success(`Step ${n} reopened. Later steps were cleared.`);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return { submit, reopen };
}

function StepFooter({ period, n, ym, onDone, label, disabled, note }: { period: Period; n: number; ym: string; onDone?: () => void; label: string; disabled?: boolean; note?: ReactNode }) {
  const { submit, reopen } = useStepActions(ym, n, onDone);
  const submitted = period.steps_submitted.includes(n);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3">
      <div className="text-[12px] text-muted-foreground">{submitted ? 'Submitted. Reopening clears this step and every later one.' : note}</div>
      {submitted ? (
        <Button variant="outline" loading={reopen.isPending} onClick={() => reopen.mutate()}>
          Reopen step {n}
        </Button>
      ) : (
        <Button loading={submit.isPending} disabled={disabled} onClick={() => submit.mutate()}>
          {label}
        </Button>
      )}
    </div>
  );
}

// ─── Step 1 ─────────────────────────────────────────────────────────────────

interface AttRow {
  employee: { id: string; code: string; name: string; department: { name: string } };
  in_run: boolean;
  present: number;
  half_day: number;
  absent: number;
  leave: number;
  off_days: number;
  off_days_worked: number;
  ot_min: number;
  late_days: number;
  late_penalty_days: number;
  paid_days: number;
  lop_days: number;
  lop_in_window: number;
  partial: boolean;
  overridden_days: number;
}

export function StepAttendance({ ym, period, onDone }: { ym: string; period: Period; onDone: () => void }) {
  const q = useQuery({
    queryKey: ['payroll-attendance', ym],
    queryFn: () => api.get<{ data: { rows: AttRow[]; shortlist: { employee: AttRow['employee']; date: string; status: DayStatus; worked_min: number }[] } }>(`/payroll/periods/${ym}/attendance`).then((r) => r.data),
  });
  const [open, setOpen] = useState<{ id: string; date: string } | null>(null);
  const frozen = period.steps_submitted.includes(1);
  const cols: Col<AttRow>[] = [
    { id: 'name', header: 'Name', sticky: true, width: 200, cell: (r) => <PersonLink id={r.employee.id} name={r.employee.name} code={r.employee.code} tab="attendance" /> },
    { id: 'p', header: 'Present', align: 'right', cell: (r) => r.present },
    { id: 'h', header: 'Half', align: 'right', cell: (r) => r.half_day },
    { id: 'a', header: 'Absent', align: 'right', cell: (r) => (r.absent ? <span className="text-destructive">{r.absent}</span> : 0) },
    { id: 'l', header: 'Leave', align: 'right', cell: (r) => r.leave },
    { id: 'o', header: 'Off days', align: 'right', cell: (r) => r.off_days },
    { id: 'ow', header: 'Off worked', align: 'right', cell: (r) => r.off_days_worked || '—' },
    { id: 'ot', header: 'Overtime', align: 'right', cell: (r) => (r.ot_min ? mins(r.ot_min) : '—') },
    { id: 'lp', header: 'Late penalty', align: 'right', cell: (r) => (r.late_penalty_days ? `${r.late_penalty_days} d (${r.late_days} late)` : r.late_days ? `${r.late_days} late, free` : '—') },
    { id: 'pd', header: 'Paid days', align: 'right', cell: (r) => <strong>{r.paid_days}</strong> },
    { id: 'lop', header: 'Loss of pay', align: 'right', cell: (r) => (r.partial ? <span title="Includes days outside employment">{r.lop_days} ({r.lop_in_window} in window)</span> : r.lop_days) },
    { id: 'c', header: 'Corrected', align: 'right', cell: (r) => r.overridden_days || '' },
    { id: 'run', header: '', cell: (r) => (!r.in_run ? <Chip tone="muted">Not in run</Chip> : r.partial ? <Chip tone="info">Part month</Chip> : null) },
  ];
  return (
    <Card>
      <CardHeader title={`Attendance — ${monthLabel(ym)}`} description="The whole month for everyone in the run. Submitting freezes attendance: corrections stop until this step is reopened." />
      {q.isLoading ? (
        <SkeletonRows rows={10} cols={10} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          {q.data!.shortlist.length > 0 && (
            <div className="border-b p-4">
              <h4 className="mb-2 text-[13px] font-semibold">Days that need a look ({q.data!.shortlist.length})</h4>
              {frozen && <LockedNotice title="Attendance is submitted">Reopen step 1 to correct these days.</LockedNotice>}
              <div className="mt-2 flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
                {q.data!.shortlist.map((s) => (
                  <button key={`${s.employee.id}${s.date}`} onClick={() => setOpen({ id: s.employee.id, date: s.date })} className="rounded-md border bg-card px-2 py-1 text-left text-[12px] hover:bg-accent">
                    <span className="font-medium">{s.employee.name}</span> · {s.date.slice(5)} · <span className={s.status === 'SHORT' ? 'text-destructive' : 'text-warning-foreground dark:text-warning'}>{DAY_STATUS_LABELS[s.status]}</span> {s.worked_min ? `(${mins(s.worked_min)})` : ''}
                  </button>
                ))}
              </div>
            </div>
          )}
          <DataTable columns={cols} rows={q.data!.rows} rowId={(r) => r.employee.id} maxHeight="60vh" />
        </>
      )}
      <StepFooter period={period} n={1} ym={ym} onDone={onDone} label="Submit attendance — freeze the month" note="Missing punch-outs pay half a day; short days pay nothing. Correct them above before submitting." />
      {open && <CorrectionDrawer employeeId={open.id} date={open.date} open onOpenChange={(o) => !o && setOpen(null)} />}
    </Card>
  );
}

// ─── Step 2 ─────────────────────────────────────────────────────────────────

interface Joiners {
  joiners: { employee: { id: string; code: string; name: string; department: string; status: string }; joined_on: string; proration: string; onboarding: { required_left: number }; excluded: boolean; joined_after_run: boolean }[];
  leavers: {
    employee: { id: string; code: string; name: string; department: string; status: string };
    last_day: string;
    settlement_id: string | null;
    settlement_state: string | null;
    included: boolean;
    settlement: { net: number; can_pay: boolean; clearance: { code: string; severity: 'BLOCKING' | 'WARNING'; message: string }[] } | { error: string };
  }[];
  notice: { employee: { id: string; code: string; name: string; department: string }; last_day: string; note: string }[];
  pipeline: { employee: { id: string; code: string; name: string; department: string; status: string }; note: string }[];
}

export function StepJoiners({ ym, period, onDone }: { ym: string; period: Period; onDone: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['payroll-joiners', ym], queryFn: () => api.get<{ data: Joiners }>(`/payroll/periods/${ym}/joiners`).then((r) => r.data) });
  const tick = useMutation({
    mutationFn: ({ id, include }: { id: string; include: boolean }) => api.post(`/settlements/${id}/include`, { period_ym: ym, include }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['payroll-joiners', ym] });
      qc.invalidateQueries({ queryKey: ['period', ym] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const locked = period.steps_submitted.includes(2);
  const d = q.data;
  const blocking = d?.leavers.some((l) => l.included && 'clearance' in l.settlement && l.settlement.clearance.some((c) => c.severity === 'BLOCKING' && c.code !== 'ATTENDANCE_NOT_SUBMITTED'));
  return (
    <Card>
      <CardHeader title="Joiners and exits" />
      {q.isLoading ? (
        <SkeletonRows rows={6} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="flex flex-col gap-5 p-4">
          <section>
            <h4 className="mb-2 font-display font-semibold">Joiners this month ({d!.joiners.length})</h4>
            {!d!.joiners.length ? (
              <p className="text-[13px] text-muted-foreground">Nobody joined this month.</p>
            ) : (
              <ul className="divide-y rounded-md border text-[13px]">
                {d!.joiners.map((j) => (
                  <li key={j.employee.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                    <PersonLink id={j.employee.id} name={j.employee.name} code={j.employee.code} tab="onboarding" />
                    <EmployeeStatusChip status={j.employee.status} />
                    <span className="text-muted-foreground">Joined {j.joined_on} · {j.proration}</span>
                    {j.excluded && <Chip tone="warning">Excluded — not activated ({j.onboarding.required_left} required steps left)</Chip>}
                    {j.joined_after_run && <Chip tone="info">Added after the last run</Chip>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h4 className="mb-2 font-display font-semibold">Leavers whose last day is this month ({d!.leavers.length})</h4>
            {!d!.leavers.length ? (
              <p className="text-[13px] text-muted-foreground">Nobody leaves this month.</p>
            ) : (
              <table className="w-full text-[13px]">
                <thead className="text-left text-[12px] text-muted-foreground">
                  <tr>
                    <th className="py-1">Pay with this run</th>
                    <th>Name</th>
                    <th>Last day</th>
                    <th className="text-right">Settlement net</th>
                    <th>Clearance</th>
                  </tr>
                </thead>
                <tbody>
                  {d!.leavers.map((l) => {
                    const s = 'net' in l.settlement ? l.settlement : null;
                    return (
                      <tr key={l.employee.id} className="border-t">
                        <td className="py-2">
                          {l.settlement_id && <Checkbox label={`Include ${l.employee.name}'s settlement`} checked={l.included} disabled={locked || tick.isPending} onCheckedChange={(v) => tick.mutate({ id: l.settlement_id!, include: v })} />}
                        </td>
                        <td>
                          <Link to={`/exits/${l.employee.id}`} className="font-medium hover:underline">
                            {l.employee.name}
                          </Link>
                        </td>
                        <td className="num">{l.last_day}</td>
                        <td className="text-right">{s ? s.net < 0 ? <span className="text-destructive"><Money value={-s.net} /> recoverable</span> : <Money value={s.net} /> : <span className="text-destructive">{'error' in l.settlement && l.settlement.error}</span>}</td>
                        <td>
                          <span className="flex flex-wrap gap-1">
                            {s?.clearance
                              .filter((c) => c.code !== 'ATTENDANCE_NOT_SUBMITTED')
                              .map((c) => (
                                <span key={c.code} title={c.message}>
                                  <SeverityChip severity={c.severity} /> <span className="text-[12px]">{c.message}</span>
                                </span>
                              ))}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-[12px] text-muted-foreground">An unticked settlement stays open and can go out in a later month. The leaver is not paid in this run unless ticked.</p>
          </section>
          <section className="grid gap-4 md:grid-cols-2">
            <div>
              <h4 className="mb-2 font-display font-semibold">On notice, leaving later ({d!.notice.length})</h4>
              <ul className="text-[13px]">
                {d!.notice.map((n) => (
                  <li key={n.employee.id}>
                    <PersonLink id={n.employee.id} name={n.employee.name} /> — last day {n.last_day}. {n.note}.
                  </li>
                ))}
                {!d!.notice.length && <li className="text-muted-foreground">None</li>}
              </ul>
            </div>
            <div>
              <h4 className="mb-2 font-display font-semibold">Not yet activated ({d!.pipeline.length})</h4>
              <ul className="text-[13px]">
                {d!.pipeline.map((n) => (
                  <li key={n.employee.id}>
                    <PersonLink id={n.employee.id} name={n.employee.name} tab="onboarding" /> <EmployeeStatusChip status={n.employee.status} />
                  </li>
                ))}
                {!d!.pipeline.length && <li className="text-muted-foreground">None</li>}
              </ul>
              <p className="mt-1 text-[12px] text-muted-foreground">Excluded — nobody is paid before activation.</p>
            </div>
          </section>
        </div>
      )}
      <StepFooter period={period} n={2} ym={ym} onDone={onDone} label="Submit joiners and exits" disabled={!!blocking} note={blocking ? 'A ticked settlement has a blocking clearance issue. Fix it or untick it.' : undefined} />
    </Card>
  );
}

// ─── Step 3 ─────────────────────────────────────────────────────────────────

interface Issue {
  kind: string;
  severity: 'BLOCKING' | 'WARNING';
  employee_id: string;
  code: string;
  name: string;
  message: string;
  fix_tab: string;
}

export function StepIssues({ ym, period, onDone }: { ym: string; period: Period; onDone: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['payroll-issues', ym],
    queryFn: () => api.get<{ data: { issues: Issue[]; kinds: { kind: string; label: string; severity: 'BLOCKING' | 'WARNING'; count: number }[]; held_back: { employee: { id: string; code: string; name: string }; reason: string }[] } }>(`/payroll/periods/${ym}/issues`).then((r) => r.data),
  });
  const [holding, setHolding] = useState<string[] | null>(null);
  const [reason, setReason] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const hold = useMutation({
    mutationFn: (ids: string[]) => api.post(`/payroll/periods/${ym}/exclusions`, { employee_ids: ids, reason }),
    onSuccess: () => {
      toast.success('Held back. They stay on the standing held-back list until paid in a later run.');
      setHolding(null);
      setReason('');
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['payroll-issues', ym] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const include = useMutation({
    mutationFn: (id: string) => api.del(`/payroll/periods/${ym}/exclusions/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payroll-issues', ym] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const d = q.data;
  const blocking = d?.issues.filter((i) => i.severity === 'BLOCKING').length ?? 0;
  const rows = (d?.issues ?? []).filter((i) => !kindFilter || i.kind === kindFilter);
  const locked = period.steps_submitted.includes(3);
  const cols: Col<Issue>[] = [
    { id: 'sev', header: '', width: 90, cell: (r) => <SeverityChip severity={r.severity} /> },
    { id: 'who', header: 'Person', cell: (r) => <PersonLink id={r.employee_id} name={r.name} code={r.code} tab={r.fix_tab} /> },
    { id: 'what', header: 'Issue', cell: (r) => <span className="whitespace-normal">{r.message}</span> },
    {
      id: 'act',
      header: '',
      align: 'right',
      cell: (r) => (
        <span className="flex justify-end gap-1">
          <Link to={`/people/${r.employee_id}?tab=${r.fix_tab}`} target="_blank" className="rounded-md border px-2 py-1 text-[12px] hover:bg-accent">
            Fix it
          </Link>
          {!locked && (
            <Button size="sm" variant="outline" onClick={() => setHolding([r.employee_id])}>
              Hold back
            </Button>
          )}
        </span>
      ),
    },
  ];
  return (
    <Card>
      <CardHeader title="Issues" description="Blocking issues stop the step until they are fixed or the person is held back. Warnings pass through." actions={<Button size="sm" variant="outline" onClick={() => q.refetch()} loading={q.isFetching}>Recheck</Button>} />
      {q.isLoading ? (
        <SkeletonRows rows={6} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <div className="flex flex-wrap gap-2 border-b p-3">
            <button onClick={() => setKindFilter(null)} className={`rounded-full border px-3 py-1 text-[12px] ${!kindFilter ? 'bg-primary text-primary-foreground' : ''}`}>
              All ({d!.issues.length})
            </button>
            {d!.kinds.map((k) => (
              <button key={k.kind} onClick={() => setKindFilter(k.kind)} className={`flex items-center gap-1 rounded-full border px-3 py-1 text-[12px] ${kindFilter === k.kind ? 'bg-primary text-primary-foreground' : ''}`}>
                {k.label} <span className="num">{k.count}</span> {k.severity === 'BLOCKING' && <span className="size-1.5 rounded-full bg-destructive" aria-label="blocking" />}
              </button>
            ))}
          </div>
          {selected.size > 0 && !locked && (
            <div className="flex items-center gap-2 border-b bg-accent/50 px-3 py-2 text-[13px]">
              {selected.size} selected
              <Button size="sm" variant="outline" onClick={() => setHolding([...new Set(rows.filter((r) => selected.has(`${r.employee_id}${r.kind}`)).map((r) => r.employee_id))])}>
                Hold back selected
              </Button>
            </div>
          )}
          {rows.length === 0 ? (
            <EmptyState title="No issues" body="Every payslip computed cleanly." />
          ) : (
            <DataTable columns={cols} rows={rows} rowId={(r) => `${r.employee_id}${r.kind}`} selectable={!locked} selected={selected} onSelectedChange={setSelected} maxHeight="50vh" />
          )}
          {d!.held_back.length > 0 && (
            <div className="border-t p-3 text-[13px]">
              <h4 className="mb-1 font-semibold">Held back from this run ({d!.held_back.length})</h4>
              {d!.held_back.map((h) => (
                <div key={h.employee.id} className="flex items-center gap-2 py-0.5">
                  <PersonLink id={h.employee.id} name={h.employee.name} code={h.employee.code} /> <span className="text-muted-foreground">— {h.reason}</span>
                  {!locked && (
                    <Button size="sm" variant="ghost" onClick={() => include.mutate(h.employee.id)}>
                      Include again
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <StepFooter period={period} n={3} ym={ym} onDone={onDone} label="Submit issues" disabled={blocking > 0} note={blocking > 0 ? `${blocking} blocking issue${blocking > 1 ? 's' : ''} stand.` : 'Only warnings remain; they pass through.'} />
      <Dialog
        open={!!holding}
        onOpenChange={(o) => !o && setHolding(null)}
        title={`Hold back ${holding?.length ?? 0} ${holding?.length === 1 ? 'person' : 'people'}`}
        description="They are excluded from this run and paid in a later one. They appear on the dashboard's held-back list until then."
        footer={
          <>
            <Button variant="outline" onClick={() => setHolding(null)}>
              Cancel
            </Button>
            <Button disabled={reason.trim().length < 3} loading={hold.isPending} onClick={() => holding && hold.mutate(holding)}>
              Hold back
            </Button>
          </>
        }
      >
        <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why, e.g. bank details pending" aria-label="Reason" />
      </Dialog>
    </Card>
  );
}

// ─── Step 4 ─────────────────────────────────────────────────────────────────

interface Adhoc {
  id: string;
  kind: string;
  name: string;
  amount: number;
  is_taxable: boolean;
  target_type: string;
  target_ids: string[];
  note: string;
  people: number;
  total: number;
}

export function StepAdhoc({ ym, period, onDone }: { ym: string; period: Period; onDone: () => void }) {
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const q = useQuery({ queryKey: ['adhoc', ym], queryFn: () => api.get<{ data: Adhoc[]; meta: { note: string } }>('/adhoc', { period: ym }) });
  const [adding, setAdding] = useState(false);
  const locked = period.steps_submitted.includes(4);
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/adhoc/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['adhoc', ym] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const targetText = (a: Adhoc) =>
    a.target_type === 'ALL'
      ? 'Everyone in the run'
      : a.target_type === 'PAY_GROUP'
        ? `Pay group: ${a.target_ids.map((id) => lk?.pay_groups.find((g) => g.id === id)?.name ?? id).join(', ')}`
        : a.target_type === 'DEPARTMENT'
          ? `Department: ${a.target_ids.map((id) => lk?.departments.find((g) => g.id === id)?.name ?? id).join(', ')}`
          : `${a.target_ids.length} selected people`;
  return (
    <Card>
      <CardHeader
        title="Adhoc items for this month"
        description={q.data?.meta.note}
        actions={
          !locked && (
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add item
            </Button>
          )
        }
      />
      {q.isLoading ? (
        <SkeletonRows rows={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data!.data.length ? (
        <EmptyState title="No adhoc items" body="Bonuses, incentives, reimbursements and one-off deductions for this month go here. Submit the step if there are none." />
      ) : (
        <table className="data-table w-full">
          <thead>
            <tr>
              <th>Item</th>
              <th>Kind</th>
              <th>Tax</th>
              <th>Goes to</th>
              <th className="text-right">Each</th>
              <th className="text-right">People</th>
              <th className="text-right">Total</th>
              <th>Why</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data!.data.map((a) => (
              <tr key={a.id}>
                <td className="font-medium">{a.name}</td>
                <td>{a.kind === 'EARNING' ? 'Earning' : a.kind === 'REIMBURSEMENT' ? 'Reimbursement' : 'Deduction'}</td>
                <td>{a.kind === 'DEDUCTION' ? '—' : a.is_taxable ? 'Taxable' : 'Exempt'}</td>
                <td>{targetText(a)}</td>
                <td className="text-right">
                  <Money value={a.amount} />
                </td>
                <td className="text-right num">{a.people}</td>
                <td className="text-right">
                  <Money value={a.total} />
                </td>
                <td className="max-w-xs truncate" title={a.note}>
                  {a.note}
                </td>
                <td>
                  {!locked && (
                    <Button size="icon" variant="ghost" aria-label={`Delete ${a.name}`} onClick={() => del.mutate(a.id)}>
                      <Trash2 />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <StepFooter period={period} n={4} ym={ym} onDone={onDone} label="Submit adhoc items" />
      {adding && <AdhocDialog ym={ym} onClose={() => setAdding(false)} />}
    </Card>
  );
}

function AdhocDialog({ ym, onClose }: { ym: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const people = useQuery({ queryKey: ['people', 'active-adhoc'], queryFn: () => api.get<{ data: { id: string; name: string; code: string }[] }>('/employees', { 'filter[status]': 'ACTIVE,NOTICE', limit: 200 }).then((r) => r.data) });
  const [f, setF] = useState({ kind: 'EARNING', name: '', amount: '', is_taxable: true, target_type: 'ALL', target_ids: [] as string[], note: '' });
  const save = useMutation({
    mutationFn: () => api.post('/adhoc', { period_ym: ym, ...f, is_taxable: f.kind === 'REIMBURSEMENT' ? false : f.is_taxable, amount: toPaise(f.amount), target_ids: f.target_type === 'ALL' ? [] : f.target_ids }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['adhoc', ym] });
      toast.success('Added');
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : errorMessage(e)),
  });
  const targetOptions = f.target_type === 'PAY_GROUP' ? lk?.pay_groups ?? [] : f.target_type === 'DEPARTMENT' ? lk?.departments ?? [] : (people.data ?? []).map((p) => ({ id: p.id, name: `${p.name} (${p.code})` }));
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add an adhoc item"
      description="Reimbursements are never part of gross or taxable, and never touch PF, ESI or PT. PF stays on salary components alone."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!f.name || !toPaise(f.amount) || f.note.trim().length < 3 || (f.target_type !== 'ALL' && !f.target_ids.length)} onClick={() => save.mutate()}>
            Add
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind">
          {(id) => (
            <Select id={id} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              {ADHOC_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k === 'EARNING' ? 'Bonus or incentive' : k === 'REIMBURSEMENT' ? 'Reimbursement' : 'One-off deduction'}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Diwali bonus" />}</Field>
        <Field label="Amount each">{(id) => <MoneyInput id={id} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />}</Field>
        {f.kind === 'EARNING' && (
          <Field label="Tax">
            {(id) => (
              <Select id={id} value={f.is_taxable ? 'y' : 'n'} onChange={(e) => setF({ ...f, is_taxable: e.target.value === 'y' })}>
                <option value="y">Taxable — adds its own TDS this month</option>
                <option value="n">Exempt</option>
              </Select>
            )}
          </Field>
        )}
        <Field label="Goes to" className="sm:col-span-2">
          {(id) => (
            <Select id={id} value={f.target_type} onChange={(e) => setF({ ...f, target_type: e.target.value, target_ids: [] })}>
              {ADHOC_TARGETS.map((t) => (
                <option key={t} value={t}>
                  {t === 'ALL' ? 'Everyone in the run' : t === 'PAY_GROUP' ? 'A pay group' : t === 'DEPARTMENT' ? 'A department' : 'Selected people'}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {f.target_type !== 'ALL' && (
          <div className="max-h-48 overflow-y-auto rounded border p-2 sm:col-span-2">
            {targetOptions.map((o) => (
              <label key={o.id} className="flex items-center gap-2 py-0.5 text-[13px]">
                <Checkbox label={o.name} checked={f.target_ids.includes(o.id)} onCheckedChange={(v) => setF({ ...f, target_ids: v ? [...f.target_ids, o.id] : f.target_ids.filter((x) => x !== o.id) })} />
                {o.name}
              </label>
            ))}
          </div>
        )}
        <Field label="Why, and who approved it" className="sm:col-span-2">
          {(id) => <Textarea id={id} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />}
        </Field>
      </div>
    </Dialog>
  );
}

// ─── Step 5 ─────────────────────────────────────────────────────────────────

export function StepRun({ ym, period, onStarted }: { ym: string; period: Period; onStarted: (jobId: string) => void }) {
  const q = useQuery({
    queryKey: ['payroll-preview', ym],
    queryFn: () => api.get<{ data: { headcount: number; gross: number; net: number; ctc: number; employer: number; held_back: number; settlements: number; errors: { code: string; name: string; message: string }[] } }>(`/payroll/periods/${ym}/preview`).then((r) => r.data),
  });
  const ready = [1, 2, 3, 4].every((s) => period.steps_submitted.includes(s));
  const run = useMutation({
    mutationFn: () => api.post<{ data: { job_id: string } }>(`/payroll/periods/${ym}/run`, {}, { 'Idempotency-Key': crypto.randomUUID() }),
    onSuccess: (r) => onStarted(r.data.job_id),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const d = q.data;
  return (
    <Card>
      <CardHeader title="Run" description="Running computes every payslip and writes a snapshot, as one transaction. Every report and payslip reads the snapshot afterwards, with the statutory rates and engine version recorded." />
      <div className="p-4">
        {q.isLoading ? (
          <SkeletonRows rows={2} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Stat label="Headcount" value={d!.headcount} />
              <Stat label="Gross" value={<Money value={d!.gross} />} />
              <Stat label="Net" value={<Money value={d!.net} />} />
              <Stat label="Cost to company" value={<Money value={d!.ctc} />} />
              <Stat label="Held back" value={d!.held_back} tone={d!.held_back ? 'warning' : undefined} />
              <Stat label="Settlements going out" value={d!.settlements} />
            </div>
            {d!.errors.length > 0 && (
              <Notice tone="destructive">
                {d!.errors.length} payslip{d!.errors.length > 1 ? 's' : ''} cannot be computed: {d!.errors.map((e) => `${e.name} — ${e.message}`).join('; ')}
              </Notice>
            )}
            {!ready && <Notice tone="warning">Submit steps 1 to 4 first.</Notice>}
            <div className="flex justify-end">
              <Button size="lg" disabled={!ready || d!.errors.length > 0 || period.running} loading={run.isPending || period.running} onClick={() => run.mutate()}>
                <Play /> Run payroll for {monthLabel(ym)}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
