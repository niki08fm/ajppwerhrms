import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Lock, LockOpen, PauseCircle, Play, Plus, RotateCcw, Undo2, Users, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { DAY_STATUS_LABELS, LAST_REVIEW_STEP } from '@ajpwer/shared';
import { api, ApiError, errorMessage } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { cn, inr, longDate, mins, monthLabel, toPaise } from '@/utils';
import { Money, PersonLink, Stat } from '@/components/bits';
import { DataTable } from '@/components/data-table';
import { Chip, EmployeeStatusChip, EmptyState, ErrorState, LockedNotice, Notice, SeverityChip, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Input, MoneyInput, Segmented, Select } from '@/components/ui/form';
import { Checkbox, Dialog, Drawer } from '@/components/ui/overlay';
import { CorrectionDrawer } from '../attendance/CorrectionDrawer';
import { SettlementPanel } from '../../pages/people/SettlementStatement';
import { heldMonthStatus, HoldDialog, ReleaseDialog } from './HoldDialogs';
import { Reports } from './Reports';
import { stepLabel, submittedBy } from './Tracker';

function refreshPeriod(qc, ym) {
  for (const key of [['period', ym], ['periods'], ['payroll-summary', ym], ['payroll-issues', ym], ['payroll-preview', ym], ['payroll-fnf', ym], ['payroll-joiners', ym], ['held-salaries']]) qc.invalidateQueries({ queryKey: key });
}

/**
 * The bar under every step: submit it (and go on), or — once submitted — who did it, with
 * reopen and the way on. Reopening clears this step and every later one.
 */
export function StepFooter({ period, n, ym, onNext, label, blocked, blockedNote, note }) {
  const qc = useQueryClient();
  const submitted = period.steps_submitted.includes(n);
  const locked = period.state !== 'DRAFT';
  const by = submittedBy(period, n);
  const submit = useMutation({
    mutationFn: () => api.post(`/payroll/periods/${ym}/steps/${n}/submit`),
    onSuccess: () => {
      toast.success(`${stepLabel(n)} submitted`);
      refreshPeriod(qc, ym);
      onNext();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reopen = useMutation({
    mutationFn: () => api.post(`/payroll/periods/${ym}/steps/${n}/reopen`),
    onSuccess: () => {
      toast.success(`${stepLabel(n)} reopened. The steps after it were cleared.`);
      refreshPeriod(qc, ym);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const nextLabel = n === LAST_REVIEW_STEP ? 'Go to generate' : `Next: ${stepLabel(n + 1)}`;
  return (
    <Card className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 px-5 py-3.5 shadow-md">
      <div className="min-w-60 flex-1">
        {submitted ? (
          <>
            <div className="font-semibold">Submitted{by ? ` ${longDate(by.on)} by ${by.by}` : ''}</div>
            <div className="text-[13px] text-muted-foreground">
              {locked ? 'The payroll has been generated. Go back to the steps from Generate to change this.' : 'Reopening clears this step and every step after it.'}
            </div>
          </>
        ) : (
          <>
            <div className="font-semibold">{blocked ? blockedNote : 'Reviewed?'}</div>
            <div className="text-[13px] text-muted-foreground">{note ?? (blocked ? 'Submit once everything above is settled.' : `Submitting locks this step and opens ${stepLabel(n + 1)}.`)}</div>
          </>
        )}
      </div>
      {submitted ? (
        <>
          {!locked && (
            <Button variant="outline" className="border-destructive/40 text-destructive hover:bg-destructive/10" loading={reopen.isPending} onClick={() => reopen.mutate()}>
              Reopen this step
            </Button>
          )}
          <Button onClick={onNext}>
            {nextLabel} <ArrowRight />
          </Button>
        </>
      ) : (
        <Button loading={submit.isPending} disabled={blocked || locked} onClick={() => submit.mutate()}>
          {label} <ArrowRight />
        </Button>
      )}
    </Card>
  );
}

// ─── Step 1: attendance ─────────────────────────────────────────────────────

export function StepAttendance({ ym, period, onNext }) {
  const q = useQuery({
    queryKey: ['payroll-attendance', ym],
    queryFn: () => api.get(`/payroll/periods/${ym}/attendance`).then((r) => r.data),
  });
  const [open, setOpen] = useState(null);
  const frozen = period.steps_submitted.includes(1);
  const rows = q.data?.rows ?? [];
  const sum = (k) => Math.round(rows.reduce((a, r) => a + (Number(r[k]) || 0), 0) * 100) / 100;
  const cols = [
    { id: 'name', header: 'Name', sticky: true, width: 200, cell: (r) => <PersonLink id={r.employee.id} name={r.employee.name} code={r.employee.code} tab="attendance" /> },
    { id: 'p', header: 'Present', align: 'right', cell: (r) => r.present },
    { id: 'h', header: 'Half', align: 'right', cell: (r) => r.half_day },
    { id: 'a', header: 'Absent', align: 'right', cell: (r) => (r.absent ? <span className="text-destructive">{r.absent}</span> : 0) },
    {
      id: 'l',
      header: 'Paid leave',
      align: 'right',
      cell: (r) => (r.leave_days ? <span title={r.auto_leave_days ? `${r.auto_leave_days} of them paid automatically for absences` : undefined}>{r.leave_days}{r.auto_leave_days ? ` (${r.auto_leave_days} auto)` : ''}</span> : '—'),
    },
    { id: 'o', header: 'Off days', align: 'right', cell: (r) => r.off_days },
    { id: 'ow', header: 'Off worked', align: 'right', cell: (r) => r.off_days_worked || '—' },
    { id: 'ot', header: 'Overtime', align: 'right', cell: (r) => (r.ot_min ? mins(r.ot_min) : '—') },
    { id: 'pd', header: 'Paid days', align: 'right', cell: (r) => <strong>{r.paid_days}</strong> },
    { id: 'lop', header: 'Loss of pay', align: 'right', cell: (r) => (r.partial ? <span title="Includes days outside employment">{r.lop_days} ({r.lop_in_window} in window)</span> : r.lop_days) },
    { id: 'c', header: 'Corrected', align: 'right', cell: (r) => r.overridden_days || '' },
    { id: 'run', header: '', cell: (r) => (!r.in_run ? <Chip tone="muted">Not in run</Chip> : r.partial ? <Chip tone="info">Part month</Chip> : null) },
  ];
  return (
    <>
      {q.data && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label="People in this payroll" value={rows.filter((r) => r.in_run).length} sub={`${rows.filter((r) => r.partial).length} part month`} />
          <Stat label="Paid days" value={sum('paid_days')} />
          <Stat label="Loss of pay" value={`${sum('lop_days')} days`} tone={sum('lop_days') ? 'destructive' : undefined} />
          <Stat label="Days to look at" value={q.data.shortlist.length} sub="missing punch-outs, short days" tone={q.data.shortlist.length ? 'warning' : undefined} />
        </div>
      )}
      <Card>
        <CardHeader title={`Attendance — ${monthLabel(ym)}`} description="The whole month for everyone in this payroll. Submitting freezes attendance: corrections stop until this step is reopened." />
        {q.isLoading ? (
          <SkeletonRows rows={10} cols={10} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <>
            {q.data.shortlist.length > 0 && (
              <div className="border-b p-4">
                <h4 className="mb-2 text-[14px] font-semibold">Days that need a look ({q.data.shortlist.length})</h4>
                {frozen && <LockedNotice title="Attendance is submitted">Reopen step 1 to correct these days.</LockedNotice>}
                <div className="mt-2 flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
                  {q.data.shortlist.map((s) => (
                    <button
                      key={`${s.employee.id}${s.date}`}
                      onClick={() => setOpen({ id: s.employee.id, date: s.date })}
                      className="rounded-md border bg-card px-2 py-1 text-left text-[13px] hover:bg-accent"
                    >
                      <span className="font-medium">{s.employee.name}</span> · {s.date.slice(5)} ·{' '}
                      <span className={s.status === 'SHORT' ? 'text-destructive' : 'text-warning-foreground dark:text-warning'}>{DAY_STATUS_LABELS[s.status]}</span> {s.worked_min ? `(${mins(s.worked_min)})` : ''}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <DataTable columns={cols} rows={rows} rowId={(r) => r.employee.id} maxHeight="60vh" />
          </>
        )}
      </Card>
      <StepFooter period={period} n={1} ym={ym} onNext={onNext} label="Submit attendance" note="Missing punch-outs pay half a day; short days pay nothing. Correct them above before submitting." />
      {open && <CorrectionDrawer employeeId={open.id} date={open.date} open onOpenChange={(o) => !o && setOpen(null)} />}
    </>
  );
}

// ─── Step 2: joiners and exits ──────────────────────────────────────────────

export function StepJoiners({ ym, period, onNext }) {
  const q = useQuery({ queryKey: ['payroll-joiners', ym], queryFn: () => api.get(`/payroll/periods/${ym}/joiners`).then((r) => r.data) });
  const d = q.data;
  return (
    <>
      {q.isLoading ? (
        <SkeletonRows rows={6} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <Card className="overflow-hidden">
            <CardHeader title={`Joined in ${monthLabel(ym).split(' ')[0]} · ${d.joiners.length}`} description="Paid from the day they joined. Someone whose onboarding is not finished is not paid until it is." />
            {!d.joiners.length ? (
              <p className="m-0 px-5 pb-4 text-[14px] text-muted-foreground">Nobody joined this month.</p>
            ) : (
              <ul className="divide-y">
                {d.joiners.map((j) => (
                  <li key={j.employee.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <div className="min-w-48 flex-1">
                      <PersonLink id={j.employee.id} name={j.employee.name} code={j.employee.code} tab="onboarding" />
                      <div className="text-[12px] text-muted-foreground">
                        {j.employee.department} · joined {longDate(j.joined_on)} · {j.days_in_month} days this month
                      </div>
                    </div>
                    {j.excluded ? (
                      <Chip tone="warning">Not paid · {j.onboarding.required_left} onboarding steps left</Chip>
                    ) : (
                      <Chip tone="success">In this payroll</Chip>
                    )}
                    {j.joined_after_run && <Chip tone="info">Added after the last run</Chip>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card className="overflow-hidden">
            <CardHeader title={`Leaving · ${d.leavers.length}`} description="Paid up to the last working day. Their full and final settlement is decided in step 4." />
            {!d.leavers.length ? (
              <p className="m-0 px-5 pb-4 text-[14px] text-muted-foreground">Nobody leaves this month.</p>
            ) : (
              <ul className="divide-y">
                {d.leavers.map((l) => (
                  <li key={l.employee.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <div className="min-w-48 flex-1">
                      <Link to={`/people/${l.employee.id}?tab=exit`} className="font-medium hover:underline">
                        {l.employee.name}
                      </Link>{' '}
                      <span className="font-mono text-[12px] text-muted-foreground">{l.employee.code}</span>
                      <div className="text-[12px] text-muted-foreground">
                        {l.employee.department} · last day {longDate(l.last_day)}
                      </div>
                    </div>
                    <Chip tone="info">F&F in step 4</Chip>
                  </li>
                ))}
              </ul>
            )}
            {d.leaving_later.length > 0 && (
              <div className="border-t px-5 py-3 text-[13px] text-muted-foreground">
                Leaving later, paid a normal month: {d.leaving_later.map((n) => `${n.employee.name} (last day ${longDate(n.last_day)})`).join(', ')}.
              </div>
            )}
          </Card>
          {d.pipeline.length > 0 && (
            <Card className="lg:col-span-2">
              <CardHeader title={`Not yet activated · ${d.pipeline.length}`} description="Offers and onboarding in progress. Nobody is paid before activation." />
              <div className="flex flex-wrap gap-2 px-5 pb-4">
                {d.pipeline.map((n) => (
                  <span key={n.employee.id} className="flex items-center gap-2 rounded-md border px-2.5 py-1 text-[14px]">
                    <PersonLink id={n.employee.id} name={n.employee.name} tab="onboarding" /> <EmployeeStatusChip status={n.employee.status} />
                  </span>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
      <StepFooter period={period} n={2} ym={ym} onNext={onNext} label="Submit joiners and exits" />
    </>
  );
}

// ─── Step 3: held salary ────────────────────────────────────────────────────

export function StepHeld({ ym, period, onNext }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['payroll-issues', ym], queryFn: () => api.get(`/payroll/periods/${ym}/issues`).then((r) => r.data) });
  const holds = useQuery({ queryKey: ['held-salaries'], queryFn: () => api.get('/held-salaries').then((r) => r.data) });
  const [holding, setHolding] = useState(null);
  const [holdingAny, setHoldingAny] = useState(false);
  const [releasing, setReleasing] = useState(null);
  const [reason, setReason] = useState('');
  const [kindFilter, setKindFilter] = useState(null);
  const locked = period.steps_submitted.includes(3) || period.state !== 'DRAFT';
  const act = useMutation({
    mutationFn: async ({ ids, how }) => {
      if (how === 'LEAVE_OUT') return api.post(`/payroll/periods/${ym}/exclusions`, { employee_ids: ids, reason });
      for (const id of ids) await api.post(`/employees/${id}/hold`, { from_ym: ym, reason });
    },
    onSuccess: (_r, { how }) => {
      toast.success(how === 'LEAVE_OUT' ? 'Left out of this month: no payslip.' : `Salary held from ${monthLabel(ym)}: worked out as usual and kept out of the bank file until released.`);
      setHolding(null);
      setReason('');
      refreshPeriod(qc, ym);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const include = useMutation({
    mutationFn: (id) => api.del(`/payroll/periods/${ym}/exclusions/${id}`),
    onSuccess: () => refreshPeriod(qc, ym),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const stop = useMutation({
    mutationFn: (h) => api.post(`/employees/${h.employee.id}/hold/stop`, {}),
    onSuccess: () => {
      toast.success('Hold stopped.');
      refreshPeriod(qc, ym);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const d = q.data;
  const blocking = d?.issues.filter((i) => i.severity === 'BLOCKING').length ?? 0;
  const rows = (d?.issues ?? []).filter((i) => !kindFilter || i.kind === kindFilter);
  const h = holds.data;
  const standing = (h?.holds ?? []).filter((x) => !x.released_at || x.months.some((m) => m.state === 'HELD'));

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader
          title={`Settle before paying${d ? ` · ${d.issues.length}` : ''}`}
          description="Something would stop pay going out, or needs a look. Fix it, hold the salary (worked out, paid when released — enough for a missing bank account), or leave the person out of this month. Warnings pass through."
          actions={
            <span className="flex items-center gap-2">
              {d && <Chip tone={blocking ? 'warning' : 'success'}>{blocking ? `${blocking} blocking` : 'Nothing blocking'}</Chip>}
              <Button size="sm" variant="outline" onClick={() => q.refetch()} loading={q.isFetching}>
                Check again
              </Button>
            </span>
          }
        />
        {q.isLoading ? (
          <SkeletonRows rows={5} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <>
            {d.kinds.length > 1 && (
              <div className="flex flex-wrap gap-2 border-b px-5 pb-3">
                <button onClick={() => setKindFilter(null)} className={cn('rounded-full border px-3 py-1 text-[13px]', !kindFilter && 'bg-primary text-primary-foreground')}>
                  All ({d.issues.length})
                </button>
                {d.kinds.map((k) => (
                  <button key={k.kind} onClick={() => setKindFilter(k.kind)} className={cn('flex items-center gap-1 rounded-full border px-3 py-1 text-[13px]', kindFilter === k.kind && 'bg-primary text-primary-foreground')}>
                    {k.label} <span className="num">{k.count}</span> {k.severity === 'BLOCKING' && <span className="size-1.5 rounded-full bg-destructive" aria-label="blocking" />}
                  </button>
                ))}
              </div>
            )}
            {rows.length === 0 ? (
              <EmptyState title="Nothing to settle" body="Every payslip works out cleanly." />
            ) : (
              <ul className="max-h-[50vh] divide-y overflow-y-auto">
                {rows.map((r) => (
                  <li key={`${r.employee_id}${r.kind}`} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <SeverityChip severity={r.severity} />
                    <div className="min-w-56 flex-1">
                      <PersonLink id={r.employee_id} name={r.name} code={r.code} tab={r.fix_tab} />
                      <div className="text-[13px] text-muted-foreground">{r.message}</div>
                    </div>
                    <span className="flex flex-wrap gap-1.5">
                      <Link to={`/people/${r.employee_id}?tab=${r.fix_tab}`} target="_blank" className="rounded-md border px-2.5 py-1 text-[13px] hover:bg-accent">
                        Fix it
                      </Link>
                      {!locked && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => setHolding({ ids: [r.employee_id], how: 'HOLD', name: r.name })}>
                            Hold salary
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setHolding({ ids: [r.employee_id], how: 'LEAVE_OUT', name: r.name })}>
                            Leave out
                          </Button>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {d.held_back.length > 0 && (
              <div className="border-t px-5 py-3 text-[14px]">
                <h4 className="mb-1 font-semibold">Left out of this month ({d.held_back.length})</h4>
                {d.held_back.map((x) => (
                  <div key={x.employee.id} className="flex flex-wrap items-center gap-2 py-0.5">
                    <PersonLink id={x.employee.id} name={x.employee.name} code={x.employee.code} /> <span className="text-muted-foreground">— {x.reason}</span>
                    {!locked && (
                      <Button size="sm" variant="ghost" onClick={() => include.mutate(x.employee.id)}>
                        Include again
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title={`Held salaries${h ? ` · ${standing.length}` : ''}`}
          description="Worked out every month but not paid. Hold anyone's salary here; release a held month to pay it in a payroll, or record it as paid separately."
          actions={
            <Button variant="outline" disabled={!h || locked} onClick={() => setHoldingAny(true)}>
              <PauseCircle /> Hold someone's salary
            </Button>
          }
        />
        {holds.isLoading ? (
          <SkeletonRows rows={3} />
        ) : holds.isError ? (
          <ErrorState error={holds.error} onRetry={() => holds.refetch()} />
        ) : !standing.length ? (
          <p className="m-0 px-5 pb-4 text-[14px] text-muted-foreground">Nobody's salary is on hold.</p>
        ) : (
          <ul className="divide-y">
            {standing.map((x) => {
              const heldMonths = x.months.filter((m) => m.state === 'HELD');
              return (
                <li key={x.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <div className="min-w-56 flex-1">
                    <PersonLink id={x.employee.id} name={x.employee.name} code={x.employee.code} tab="salary" />
                    <div className="text-[13px] text-muted-foreground">
                      Held since {monthLabel(x.from_ym)} · {x.reason}
                    </div>
                    {x.months.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {x.months.map((m) => (
                          <Chip key={m.id} tone={m.state === 'HELD' ? 'warning' : 'muted'}>
                            {monthLabel(m.period_ym)} · {inr(m.amount)} · {heldMonthStatus(m)}
                          </Chip>
                        ))}
                      </div>
                    )}
                  </div>
                  {heldMonths.length > 0 && (
                    <Button size="sm" onClick={() => setReleasing(x)}>
                      Release
                    </Button>
                  )}
                  {!x.released_at && !x.months.length && (
                    <Button size="sm" variant="outline" loading={stop.isPending && stop.variables?.id === x.id} onClick={() => stop.mutate(x)}>
                      Stop holding
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <StepFooter
        period={period}
        n={3}
        ym={ym}
        onNext={onNext}
        label="Submit held salaries"
        blocked={blocking > 0}
        blockedNote={`${blocking} blocking issue${blocking === 1 ? '' : 's'} still to settle`}
      />
      <Dialog
        open={!!holding}
        onOpenChange={(o) => !o && setHolding(null)}
        title={holding?.how === 'LEAVE_OUT' ? `Leave ${holding?.name} out of ${monthLabel(ym)}` : `Hold ${holding?.name}'s salary`}
        description={
          holding?.how === 'LEAVE_OUT'
            ? 'No payslip this month: nothing is worked out, so no PF or ESI either. Use it only when the payslip cannot be worked out.'
            : `Worked out in ${monthLabel(ym)} as usual — payslip, PF, ESI, TDS — and kept out of the bank file until released.`
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setHolding(null)}>
              Cancel
            </Button>
            <Button disabled={reason.trim().length < 3} loading={act.isPending} onClick={() => holding && act.mutate(holding)}>
              {holding?.how === 'LEAVE_OUT' ? 'Leave out' : 'Hold salary'}
            </Button>
          </>
        }
      >
        <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why, e.g. bank details pending" aria-label="Reason" />
      </Dialog>
      {holdingAny && h && <HoldDialog openMonths={h.open_months} onClose={() => { setHoldingAny(false); refreshPeriod(qc, ym); }} />}
      {releasing && h && <ReleaseDialog hold={releasing} openMonths={h.open_months} runMonths={h.run_months} onClose={() => { setReleasing(null); refreshPeriod(qc, ym); }} />}
    </>
  );
}

// ─── Step 4: F&F ────────────────────────────────────────────────────────────

const MODES = [
  { value: 'PAYROLL', label: 'This payroll' },
  { value: 'SEPARATE', label: 'Paid separately' },
  { value: 'LATER', label: 'Later' },
];

export function StepFnf({ ym, period, onNext }) {
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const q = useQuery({ queryKey: ['payroll-fnf', ym], queryFn: () => api.get(`/payroll/periods/${ym}/fnf`).then((r) => r.data) });
  const [editing, setEditing] = useState(null);
  const [separate, setSeparate] = useState(null);
  const [sep, setSep] = useState({ paid_on: '', payment_ref: '' });
  const change = useMutation({
    mutationFn: async ({ row, mode, paid }) => {
      const id = row.employee.id;
      if (row.mode !== 'LATER') await api.del(`/employees/${id}/exit/process`);
      if (mode === 'PAYROLL') await api.post(`/employees/${id}/exit/process`, { period_ym: ym });
      if (mode === 'SEPARATE') await api.post(`/employees/${id}/exit/process`, { period_ym: ym, paid_separately: paid });
    },
    onSuccess: (_r, { row, mode }) => {
      toast.success(mode === 'LATER' ? `${row.employee.name}'s F&F stays open for a later month.` : mode === 'SEPARATE' ? `${row.employee.name}'s F&F recorded as paid separately.` : `${row.employee.name}'s F&F goes out with this payroll.`);
      setSeparate(null);
      refreshPeriod(qc, ym);
      qc.invalidateQueries({ queryKey: ['exit', row.employee.id] });
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      refreshPeriod(qc, ym);
    },
  });
  const d = q.data;
  const closed = d?.closed;
  const rows = d?.rows ?? [];
  const blocked = rows.some((r) => r.mode !== 'LATER' && r.blocking.length);
  const pick = (row, mode) => {
    if (mode === row.mode) return;
    if (mode === 'SEPARATE') {
      setSep({ paid_on: lk?.today ?? '', payment_ref: '' });
      setSeparate(row);
      return;
    }
    change.mutate({ row, mode });
  };

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader
          title={`Full and final settlements · ${rows.length}`}
          description="Everyone whose F&F this payroll can settle — paid in its bank file, paid separately and recorded here, or kept open for a later month. Edit opens the statement to add an earning or a deduction."
        />
        {closed && (
          <div className="px-5 pb-3">
            <LockedNotice title={closed}>Reopen this step to change how settlements are paid.</LockedNotice>
          </div>
        )}
        {q.isLoading ? (
          <SkeletonRows rows={4} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !rows.length ? (
          <EmptyState title="No settlements this month" body="Someone leaving appears here once their last day falls in this month or earlier." />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Last day</th>
                  <th>Checklist</th>
                  <th className="text-right">Owed</th>
                  <th className="text-right">Recovered</th>
                  <th className="text-right">Net</th>
                  <th>How it is paid</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const notReady = r.checklist_open.length > 0 || r.blocking.length > 0 || !!r.error;
                  return (
                    <tr key={r.employee.id}>
                      <td>
                        <Link to={`/people/${r.employee.id}?tab=exit`} className="font-medium hover:underline">
                          {r.employee.name}
                        </Link>{' '}
                        <span className="font-mono text-[12px] text-muted-foreground">{r.employee.code}</span>
                        <div className="text-[12px] text-muted-foreground">{r.employee.department}</div>
                      </td>
                      <td className="num">{longDate(r.last_day)}</td>
                      <td>
                        {r.checklist_open.length ? (
                          <Chip tone="warning" title={r.checklist_open.join(', ')}>
                            {r.checklist_open.length} task{r.checklist_open.length > 1 ? 's' : ''} open
                          </Chip>
                        ) : (
                          <Chip tone="success">Done</Chip>
                        )}
                      </td>
                      <td className="text-right num">{r.total_earnings === null ? '—' : inr(r.total_earnings)}</td>
                      <td className="text-right text-destructive num">{r.total_deductions === null ? '—' : `−${inr(r.total_deductions)}`}</td>
                      <td className={cn('text-right font-semibold num', r.net < 0 && 'text-destructive')}>{r.net === null ? '—' : inr(r.net)}</td>
                      <td>
                        {r.processed_elsewhere ? (
                          <Chip tone="muted">In {monthLabel(r.processed_elsewhere)} payroll</Chip>
                        ) : (
                          <Segmented
                            label={`How ${r.employee.name}'s F&F is paid`}
                            value={r.mode}
                            onChange={(m) => pick(r, m)}
                            options={MODES.map((m) => ({
                              ...m,
                              disabled: !!closed || change.isPending || (m.value !== 'LATER' && notReady) || (m.value === 'SEPARATE' && r.net < 0),
                            }))}
                          />
                        )}
                        <div className="mt-1 text-[12px] text-muted-foreground">
                          {r.error
                            ? r.error
                            : r.blocking.length
                              ? r.blocking.join(' ')
                              : r.mode === 'SEPARATE'
                                ? `Paid ${r.paid_separately?.paid_on ? longDate(r.paid_separately.paid_on) : ''} · ref ${r.paid_separately?.payment_ref ?? ''}`
                                : r.mode === 'PAYROLL'
                                  ? `In ${monthLabel(ym)}'s bank file`
                                  : r.checklist_open.length
                                    ? 'Finish the exit checklist to settle it'
                                    : 'Stays open for a later month'}
                        </div>
                      </td>
                      <td className="text-right">
                        <Button size="sm" variant="outline" onClick={() => setEditing(r)}>
                          Edit
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <StepFooter
        period={period}
        n={4}
        ym={ym}
        onNext={onNext}
        label="Submit F&F"
        blocked={blocked}
        blockedNote="A settlement in this payroll has a blocking issue"
        note={blocked ? 'Fix it, or move that settlement to Later.' : undefined}
      />
      <Drawer
        open={!!editing}
        onOpenChange={(o) => {
          if (!o) {
            setEditing(null);
            refreshPeriod(qc, ym);
          }
        }}
        title={editing ? `${editing.employee.name}'s F&F` : ''}
        description={editing ? `${editing.employee.code} · last day ${longDate(editing.last_day)}` : ''}
      >
        {editing && <SettlementPanel employeeId={editing.employee.id} />}
      </Drawer>
      <Dialog
        open={!!separate}
        onOpenChange={(o) => !o && setSeparate(null)}
        title={separate ? `${separate.employee.name}'s F&F, paid separately` : ''}
        description={`By cheque, cash or a separate transfer. It is recorded in ${monthLabel(ym)}'s payroll — register, PF, ESI — but never goes in the bank file.`}
        footer={
          <>
            <Button variant="outline" onClick={() => setSeparate(null)}>
              Cancel
            </Button>
            <Button loading={change.isPending} disabled={!sep.paid_on || sep.payment_ref.trim().length < 2} onClick={() => change.mutate({ row: separate, mode: 'SEPARATE', paid: sep })}>
              Record as paid separately
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Paid on">{(id) => <Input id={id} type="date" value={sep.paid_on} onChange={(e) => setSep({ ...sep, paid_on: e.target.value })} />}</Field>
          <Field label="Reference" hint="Cheque or transfer number">
            {(id) => <Input id={id} value={sep.payment_ref} onChange={(e) => setSep({ ...sep, payment_ref: e.target.value })} />}
          </Field>
        </div>
      </Dialog>
    </>
  );
}

// ─── Step 5: adhoc ──────────────────────────────────────────────────────────

const KIND_LABEL = { EARNING: 'Bonus or incentive', REIMBURSEMENT: 'Reimbursement', DEDUCTION: 'Deduction' };
const KIND_TONE = { EARNING: 'success', REIMBURSEMENT: 'info', DEDUCTION: 'destructive' };
const TARGETS = [
  { value: 'ALL', label: 'Everyone' },
  { value: 'PAY_GROUP', label: 'A pay group' },
  { value: 'DEPARTMENT', label: 'A department' },
  { value: 'EMPLOYEE', label: 'Selected people' },
];

/** Active people who could get an adhoc item, with their group and department. */
function usePeople() {
  return useQuery({ queryKey: ['people', 'active-adhoc'], queryFn: () => api.get('/employees', { 'filter[status]': 'ACTIVE,NOTICE', limit: 200 }).then((r) => r.data), staleTime: 60_000 });
}

export function StepAdhoc({ ym, period, onNext }) {
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const q = useQuery({ queryKey: ['adhoc', ym], queryFn: () => api.get('/adhoc', { period: ym }) });
  const people = usePeople();
  const loans = useQuery({ queryKey: ['advances-loans', 'all'], queryFn: () => api.get('/advances-loans').then((r) => r.data), retry: false });
  const [adding, setAdding] = useState(false);
  const [viewing, setViewing] = useState(null);
  const locked = period.steps_submitted.includes(5) || period.state !== 'DRAFT';
  const del = useMutation({
    mutationFn: (id) => api.del(`/adhoc/${id}`),
    onSuccess: () => {
      toast.success('Item removed');
      setViewing(null);
      qc.invalidateQueries({ queryKey: ['adhoc', ym] });
      qc.invalidateQueries({ queryKey: ['payroll-summary', ym] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const nameOf = (list, id) => list?.find((g) => g.id === id)?.name ?? 'Unknown';
  const targetText = (a) =>
    a.target_type === 'ALL'
      ? 'Everyone in this payroll'
      : a.target_type === 'PAY_GROUP'
        ? `Pay group: ${a.target_ids.map((id) => nameOf(lk?.pay_groups, id)).join(', ')}`
        : a.target_type === 'DEPARTMENT'
          ? `Department: ${a.target_ids.map((id) => nameOf(lk?.departments, id)).join(', ')}`
          : a.target_ids.length === 1 && people.data?.some((p) => p.id === a.target_ids[0])
            ? people.data.find((p) => p.id === a.target_ids[0]).name
            : `${a.target_ids.length} selected people`;
  const items = q.data?.data ?? [];
  const plus = items.filter((a) => a.kind !== 'DEDUCTION').reduce((t, a) => t + a.total, 0);
  const minus = items.filter((a) => a.kind === 'DEDUCTION').reduce((t, a) => t + a.total, 0);
  const active = (loans.data?.rows ?? []).filter((r) => r.status === 'ACTIVE' && r.outstanding > 0 && String(r.started_on).slice(0, 7) <= ym);
  const recov = active.reduce((t, r) => t + Math.min(r.instalment, r.outstanding), 0);

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Extra earnings" value={inr(plus)} sub="bonus, incentive, reimbursement" tone={plus ? 'success' : undefined} />
        <Stat label="One-off deductions" value={minus ? `−${inr(minus)}` : inr(0)} sub="damage, canteen, other" tone={minus ? 'destructive' : undefined} />
        <Stat label="Recoveries (automatic)" value={loans.isError ? '—' : inr(recov)} sub={loans.isError ? 'from advance and loan plans' : `${active.length} advance or loan instalment${active.length === 1 ? '' : 's'}, from their plans`} />
      </div>
      <Card className="overflow-hidden">
        <CardHeader
          title={`One-off items for ${monthLabel(ym)} · ${items.length}`}
          description="Paid or deducted once, in this month only. Click an item to see who gets it."
          actions={
            !locked &&
            !adding && (
              <Button onClick={() => setAdding(true)}>
                <Plus /> Add item
              </Button>
            )
          }
        />
        {adding && <AddAdhoc ym={ym} onClose={() => setAdding(false)} />}
        {q.isLoading ? (
          <SkeletonRows rows={3} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !items.length && !active.length ? (
          <EmptyState title="No one-off items" body="Bonuses, incentives, reimbursements and one-off deductions for this month go here. Submit the step if there are none." />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Goes to</th>
                  <th className="text-right">Each</th>
                  <th className="text-right">Total</th>
                  <th>Added by</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id} className="cursor-pointer hover:bg-accent/40" onClick={() => setViewing(a)}>
                    <td>
                      <div className="font-medium">{a.name}</div>
                      <Chip tone={KIND_TONE[a.kind]}>{KIND_LABEL[a.kind]}</Chip>
                    </td>
                    <td>
                      <div>{targetText(a)}</div>
                      <div className="text-[12px] text-muted-foreground">
                        {a.people} {a.people === 1 ? 'person' : 'people'}
                      </div>
                    </td>
                    <td className="text-right num">{inr(a.amount)}</td>
                    <td className={cn('text-right font-semibold num', a.kind === 'DEDUCTION' ? 'text-destructive' : 'text-success')}>
                      {a.kind === 'DEDUCTION' ? '−' : '+'}
                      {inr(a.total)}
                    </td>
                    <td className="text-[13px] text-muted-foreground">
                      {a.created_by} · {longDate(String(a.created_at).slice(0, 10))}
                    </td>
                    <td className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(e) => {
                          e.stopPropagation();
                          setViewing(a);
                        }}
                      >
                        <Users /> View people
                      </Button>
                    </td>
                  </tr>
                ))}
                {active.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <div className="font-medium">{r.type === 'LOAN' ? 'Loan instalment' : 'Advance instalment'}</div>
                      <Chip tone="muted">Recovery · automatic</Chip>
                    </td>
                    <td>
                      <div>{r.employee.name}</div>
                      <div className="text-[12px] text-muted-foreground">from the recovery plan</div>
                    </td>
                    <td className="text-right num">{inr(Math.min(r.instalment, r.outstanding))}</td>
                    <td className="text-right font-semibold text-destructive num">−{inr(Math.min(r.instalment, r.outstanding))}</td>
                    <td className="text-[13px] text-muted-foreground">System</td>
                    <td />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <StepFooter period={period} n={5} ym={ym} onNext={onNext} label="Submit adhoc" />
      <AdhocPeople item={viewing} text={viewing ? targetText(viewing) : ''} canRemove={!locked} removing={del.isPending} onRemove={() => viewing && del.mutate(viewing.id)} onClose={() => setViewing(null)} />
    </>
  );
}

/** The add form, in place: what it is, how much each, who it goes to, and why. */
function AddAdhoc({ ym, onClose }) {
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const people = usePeople();
  const [f, setF] = useState({ kind: 'EARNING', name: '', amount: '', is_taxable: true, target_type: 'ALL', target_ids: [], note: '' });
  const [search, setSearch] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.post('/adhoc', { period_ym: ym, ...f, is_taxable: f.kind === 'EARNING' ? f.is_taxable : false, amount: toPaise(f.amount), target_ids: f.target_type === 'ALL' ? [] : f.target_ids }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['adhoc', ym] });
      qc.invalidateQueries({ queryKey: ['payroll-summary', ym] });
      toast.success('Added');
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : errorMessage(e)),
  });
  const list = people.data ?? [];
  const groups = useMemo(() => {
    const src = f.target_type === 'PAY_GROUP' ? (lk?.pay_groups ?? []) : f.target_type === 'DEPARTMENT' ? (lk?.departments ?? []) : [];
    const key = f.target_type === 'PAY_GROUP' ? 'pay_group' : 'department';
    return src.map((g) => ({ ...g, count: list.filter((p) => p[key]?.id === g.id).length }));
  }, [f.target_type, lk, list]);
  const toggle = (id) => setF({ ...f, target_ids: f.target_ids.includes(id) ? f.target_ids.filter((x) => x !== id) : [...f.target_ids, id] });
  const reach =
    f.target_type === 'ALL'
      ? list.length
      : f.target_type === 'EMPLOYEE'
        ? f.target_ids.length
        : groups.filter((g) => f.target_ids.includes(g.id)).reduce((t, g) => t + g.count, 0);
  const each = toPaise(f.amount);
  const s = search.trim().toLowerCase();
  const shown = list.filter((p) => !s || p.name.toLowerCase().includes(s) || p.code.toLowerCase().includes(s));
  const ok = f.name.trim().length >= 2 && each > 0 && f.note.trim().length >= 3 && (f.target_type === 'ALL' || f.target_ids.length > 0);

  return (
    <div className="flex flex-col gap-4 border-y bg-muted/40 px-5 py-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] font-medium">What it is</span>
          <Segmented label="Kind" value={f.kind} onChange={(kind) => setF({ ...f, kind })} options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))} />
        </div>
        <Field label="Name" className="min-w-52 flex-1">
          {(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Diwali bonus" />}
        </Field>
        <Field label="Amount each" className="w-40">
          {(id) => <MoneyInput id={id} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />}
        </Field>
        {f.kind === 'EARNING' && (
          <Field label="Tax" className="w-60">
            {(id) => (
              <Select id={id} value={f.is_taxable ? 'y' : 'n'} onChange={(e) => setF({ ...f, is_taxable: e.target.value === 'y' })}>
                <option value="y">Taxable — adds its own TDS</option>
                <option value="n">Exempt</option>
              </Select>
            )}
          </Field>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium">Goes to</span>
        <Segmented label="Goes to" value={f.target_type} onChange={(target_type) => setF({ ...f, target_type, target_ids: [] })} options={TARGETS} className="self-start" />
        {(f.target_type === 'PAY_GROUP' || f.target_type === 'DEPARTMENT') && (
          <div className="flex flex-wrap gap-2">
            {groups.map((g) => {
              const on = f.target_ids.includes(g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(g.id)}
                  className={cn('rounded-md border px-3 py-1.5 text-[13px] font-medium', on ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-accent')}
                >
                  {g.name} · {g.count}
                </button>
              );
            })}
          </div>
        )}
        {f.target_type === 'EMPLOYEE' && (
          <div className="max-w-xl rounded-lg border bg-card">
            <div className="flex items-center gap-2 border-b p-2">
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or code" aria-label="Search people" />
              <span className="whitespace-nowrap text-[13px] text-muted-foreground">{f.target_ids.length} picked</span>
            </div>
            <div className="max-h-56 overflow-y-auto">
              {people.isLoading ? (
                <SkeletonRows rows={4} />
              ) : (
                shown.map((p) => (
                  <label key={p.id} className={cn('flex cursor-pointer items-center gap-2.5 border-b px-3 py-2 text-[14px] last:border-0', f.target_ids.includes(p.id) && 'bg-primary/5')}>
                    <Checkbox label={p.name} checked={f.target_ids.includes(p.id)} onCheckedChange={() => toggle(p.id)} />
                    <span className="flex-1">
                      {p.name} <span className="font-mono text-[12px] text-muted-foreground">{p.code}</span>
                    </span>
                    <span className="text-[12px] text-muted-foreground">{p.pay_group?.name}</span>
                  </label>
                ))
              )}
            </div>
          </div>
        )}
        <div className="flex items-center gap-2 self-start rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-[14px]">
          <Users className="size-4 text-primary" />
          {reach
            ? `Goes to ${reach} ${reach === 1 ? 'person' : 'people'}${each > 0 ? ` · ${inr(each)} each · total ${inr(each * reach)}` : ''}`
            : f.target_type === 'EMPLOYEE'
              ? 'Pick the people it goes to'
              : 'Pick at least one group'}
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Why, and who approved it" className="min-w-72 flex-1">
          {(id) => <Input id={id} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. Approved by the MD, 2 Oct" />}
        </Field>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button loading={save.isPending} disabled={!ok} onClick={() => save.mutate()}>
          Add item
        </Button>
      </div>
    </div>
  );
}

/** Who an adhoc item goes to, who added it and why. */
function AdhocPeople({ item, text, canRemove, removing, onRemove, onClose }) {
  const q = useQuery({ queryKey: ['adhoc-people', item?.id], queryFn: () => api.get(`/adhoc/${item.id}/people`).then((r) => r.data), enabled: !!item });
  const neg = item?.kind === 'DEDUCTION';
  return (
    <Drawer
      open={!!item}
      onOpenChange={(o) => !o && onClose()}
      title={item?.name ?? ''}
      description={item ? `${KIND_LABEL[item.kind]} · ${text} · ${inr(item.amount)} each` : ''}
      footer={
        canRemove && (
          <Button variant="outline" className="border-destructive/40 text-destructive hover:bg-destructive/10" loading={removing} onClick={onRemove}>
            Remove this item
          </Button>
        )
      }
    >
      {item && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border px-3 py-2">
              <div className="text-[12px] text-muted-foreground">People</div>
              <div className="text-lg font-semibold num">{item.people}</div>
            </div>
            <div className="rounded-lg border px-3 py-2">
              <div className="text-[12px] text-muted-foreground">Total</div>
              <div className={cn('text-lg font-semibold num', neg ? 'text-destructive' : 'text-success')}>
                {neg ? '−' : '+'}
                {inr(item.total)}
              </div>
            </div>
          </div>
          <div>
            <h4 className="mb-1.5 text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">Who gets it</h4>
            {q.isError ? (
              <ErrorState error={q.error} onRetry={() => q.refetch()} compact />
            ) : !q.data ? (
              <SkeletonRows rows={5} />
            ) : (
              <ul className="divide-y rounded-lg border">
                {q.data.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-[14px]">
                    <span>
                      <PersonLink id={p.id} name={p.name} code={p.code} />
                      <span className="block text-[12px] text-muted-foreground">{[p.pay_group, p.department].filter(Boolean).join(' · ')}</span>
                    </span>
                    <span className={cn('num', neg ? 'text-destructive' : 'text-success')}>
                      {neg ? '−' : '+'}
                      {inr(item.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-[14px]">
            <div>
              <span className="text-muted-foreground">Added by</span> <b>{item.created_by}</b> on {longDate(String(item.created_at).slice(0, 10))}
            </div>
            <div>
              <span className="text-muted-foreground">Why</span> {item.note}
            </div>
            <div className="text-[12px] text-muted-foreground">A group is worked out again when the payroll is generated: someone who moves group before then is paid by where they are then.</div>
          </div>
        </div>
      )}
    </Drawer>
  );
}

// ─── Step 6: generate ───────────────────────────────────────────────────────

/** Watches a running job, then refreshes everything that read the old figures. */
function JobProgress({ jobId, ym, onEnd }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.get(`/jobs/${jobId}`).then((r) => r.data),
    refetchInterval: (query) => (query.state.data && ['DONE', 'FAILED'].includes(query.state.data.status) ? false : 700),
  });
  const j = q.data;
  useEffect(() => {
    if (j?.status === 'DONE') {
      toast.success(`${monthLabel(ym)} payroll generated. Every report now reads from it.`);
      refreshPeriod(qc, ym);
      qc.invalidateQueries({ queryKey: ['report'] });
      onEnd();
    }
    if (j?.status === 'FAILED') {
      toast.error(j.error ?? 'Generating failed. Nothing was written.');
      refreshPeriod(qc, ym);
      onEnd();
    }
  }, [j?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!j || j.status === 'DONE' || j.status === 'FAILED') return null;
  const pct = j.total ? Math.round((j.progress / j.total) * 100) : 5;
  return (
    <div className="rounded-lg border bg-card p-3" role="status" aria-live="polite">
      <div className="mb-1 flex justify-between text-[14px]">
        <span>Working out payslips…</span>
        <span className="num">{j.total ? `${j.progress} of ${j.total}` : 'starting'}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const CONFIRM = (ym, p) => ({
  lock: { title: `Lock ${monthLabel(ym)}`, body: 'Payslips become final. A later change to salaries or attendance does not move them unless the month is unlocked and generated again.', action: 'Lock' },
  unlock: { title: `Unlock ${monthLabel(ym)}`, body: 'Returns it to generated, so it can be generated again. The current figures stay until you do.', action: 'Unlock' },
  'unmark-paid': {
    title: 'The transfer has already gone',
    body: `${monthLabel(ym)} was marked paid with reference ${p.payment_ref}. Unmarking returns it to locked and reverses loan and advance recoveries and settlements. The bank transfer itself is not reversed. It is recorded in the audit log.`,
    action: 'Unmark paid anyway',
    destructive: true,
  },
  'back-to-steps': {
    title: 'Back to the steps',
    body: `Discards the generated payroll for ${monthLabel(ym)} (${p.totals?.headcount ?? 0} payslips) and reopens the steps. Nothing has left the building; you can generate again.`,
    action: 'Discard and go back',
    destructive: true,
  },
  rerun: { title: `Generate ${monthLabel(ym)} again`, body: 'Works out every payslip again from current data and replaces the generated figures.', action: 'Generate again' },
});

export function StepGenerate({ ym, period, company, onBack }) {
  const qc = useQueryClient();
  const generated = period.state !== 'DRAFT';
  const [jobId, setJobId] = useState(period.running_job_id ?? null);
  const [confirm, setConfirm] = useState(null);
  const [paymentRef, setPaymentRef] = useState('');
  useEffect(() => {
    if (period.running_job_id) setJobId(period.running_job_id);
  }, [period.running_job_id]);
  const q = useQuery({ queryKey: ['payroll-preview', ym], queryFn: () => api.get(`/payroll/periods/${ym}/preview`).then((r) => r.data), enabled: !generated });
  const ready = [1, 2, 3, 4, 5].every((s) => period.steps_submitted.includes(s));
  const run = useMutation({
    mutationFn: () => api.post(`/payroll/periods/${ym}/run`, {}, { 'Idempotency-Key': crypto.randomUUID() }),
    onSuccess: (r) => setJobId(r.data.job_id),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const transition = useMutation({
    mutationFn: (action) =>
      action === 'rerun'
        ? api.post(`/payroll/periods/${ym}/run`, {}, { 'Idempotency-Key': crypto.randomUUID() })
        : api.post(`/payroll/periods/${ym}/${action}`, action === 'mark-paid' ? { payment_ref: paymentRef } : {}, action === 'mark-paid' ? { 'Idempotency-Key': `pay-${ym}-${paymentRef}` } : {}),
    onSuccess: (r, action) => {
      setConfirm(null);
      if (action === 'rerun') setJobId(r.data.job_id);
      else toast.success('Done. The change is in the audit log.');
      refreshPeriod(qc, ym);
      qc.invalidateQueries({ queryKey: ['report'] });
      if (action === 'back-to-steps') onBack();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const d = q.data;
  const conf = confirm && confirm !== 'mark-paid' ? CONFIRM(ym, period)[confirm] : null;
  const t = period.totals;

  return (
    <>
      {jobId && <JobProgress jobId={jobId} ym={ym} onEnd={() => setJobId(null)} />}
      {!generated ? (
        <Card>
          <CardHeader
            title={ready ? `Everything is reviewed. Ready to generate ${monthLabel(ym)}.` : `Submit steps 1 to 5 first`}
            description="Generating works out every payslip from what was submitted, and makes the bank file and the statutory reports. Nothing is paid until you mark it paid."
          />
          <div className="flex flex-col gap-4 px-5 pb-5">
            {q.isLoading ? (
              <SkeletonRows rows={2} />
            ) : q.isError ? (
              <ErrorState error={q.error} onRetry={() => q.refetch()} />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
                  <Stat label="People" value={d.headcount} sub={d.on_hold ? `${d.on_hold} held` : 'nobody held'} />
                  <Stat label="Gross pay" value={<Money value={d.gross} />} />
                  <Stat label="Net pay" value={<Money value={d.net} />} sub={d.on_hold ? <>held, not in the bank file: <Money value={d.on_hold_net} /></> : undefined} />
                  <Stat label="Employer PF and ESI" value={<Money value={d.employer} />} sub="on top of gross" />
                  <Stat label="F&Fs" value={d.settlements} sub={d.held_back ? `${d.held_back} left out` : undefined} />
                </div>
                {d.released_held > 0 && (
                  <Notice tone="info">
                    Held salary from earlier months is paid in this payroll: <Money value={d.released_held} />, as its own line on each payslip.
                  </Notice>
                )}
                {d.errors.length > 0 && (
                  <Notice tone="destructive">
                    {d.errors.length} payslip{d.errors.length > 1 ? 's' : ''} cannot be worked out: {d.errors.map((e) => `${e.name} — ${e.message}`).join('; ')}. Hold them or leave them out in step 3.
                  </Notice>
                )}
                <div>
                  <Button size="lg" disabled={!ready || d.errors.length > 0 || period.running || !!jobId} loading={run.isPending || period.running || !!jobId} onClick={() => run.mutate()}>
                    <Play /> Generate payroll
                  </Button>
                </div>
              </>
            )}
          </div>
        </Card>
      ) : (
        <>
          <Card className="flex flex-wrap items-center gap-4 px-5 py-4">
            <div className="min-w-60 flex-1">
              <div className="text-[17px] font-semibold">
                {period.state === 'PAID' ? `${monthLabel(ym)} paid · ref ${period.payment_ref}` : period.state === 'LOCKED' ? `${monthLabel(ym)} locked · payslips are final` : `${monthLabel(ym)} payroll generated`}
              </div>
              <div className="text-[13px] text-muted-foreground">
                {t ? `${t.headcount} payslips · gross ${inr(t.gross)} · net ${inr(t.net)}` : ''}
                {period.state === 'RUN' ? ' · check the change against last month, then lock.' : period.state === 'LOCKED' ? ' · mark it paid once the bank transfer has gone.' : ''}
              </div>
            </div>
            {period.state === 'RUN' && (
              <>
                <Button variant="outline" onClick={() => setConfirm('back-to-steps')}>
                  <Undo2 /> Back to the steps
                </Button>
                <Button variant="outline" onClick={() => setConfirm('rerun')}>
                  <RotateCcw /> Generate again
                </Button>
                <Button onClick={() => setConfirm('lock')}>
                  <Lock /> Lock
                </Button>
              </>
            )}
            {period.state === 'LOCKED' && (
              <>
                <Button variant="outline" onClick={() => setConfirm('unlock')}>
                  <LockOpen /> Unlock
                </Button>
                <Button onClick={() => setConfirm('mark-paid')}>
                  <Wallet /> Mark paid
                </Button>
              </>
            )}
            {period.state === 'PAID' && (
              <Button variant="outline" onClick={() => setConfirm('unmark-paid')}>
                <Undo2 /> Unmark paid
              </Button>
            )}
          </Card>
          <Reports ym={ym} period={period} company={company} />
        </>
      )}
      {conf && (
        <Dialog
          open
          onOpenChange={(o) => !o && setConfirm(null)}
          title={conf.title}
          description={conf.body}
          footer={
            <>
              <Button variant="outline" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button variant={conf.destructive ? 'destructive' : 'default'} loading={transition.isPending} onClick={() => transition.mutate(confirm)}>
                {conf.action}
              </Button>
            </>
          }
        />
      )}
      {confirm === 'mark-paid' && (
        <Dialog
          open
          onOpenChange={(o) => !o && setConfirm(null)}
          title={`Mark ${monthLabel(ym)} paid`}
          description="Applies loan and advance recoveries, carries any capped excess into next month, freezes the settlements in it and exits those employees. A double submit cannot create two payment records."
          footer={
            <>
              <Button variant="outline" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button disabled={paymentRef.trim().length < 3} loading={transition.isPending} onClick={() => transition.mutate('mark-paid')}>
                Mark paid
              </Button>
            </>
          }
        >
          <Input autoFocus value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)} placeholder="Bank payment reference, e.g. NEFT batch number" aria-label="Payment reference" />
        </Dialog>
      )}
    </>
  );
}
