import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Undo2 } from 'lucide-react';
import { addDays, DAY_STATUS_LABELS } from '@ajpwer/shared';
import { toast } from 'sonner';
import { api, errorMessage } from '@/services/api';
import { useDebounced } from '@/hooks';
import { useLookups } from '@/hooks/useLookups';
import { useSession } from '@/context/SessionContext';
import { CELL_STYLE, cellOf, fullDate, monthName } from './dayVocab';
import { DeptAvatar } from './DeptAvatar';
import { cn, hhmm, istTime, mins } from '@/utils';
import { Mono } from '@/components/bits';
import { Chip, DayChip, ErrorState, LockedNotice, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Field, Input, Segmented } from '@/components/ui/form';
import { Drawer } from '@/components/ui/overlay';

const FLAG_TEXT = {
  ORPHAN_OUT: 'An OUT punch with no IN before it.',
  UNMATCHED_IN: 'An IN with no OUT after it.',
  CROSS_SITE: 'Worked at more than one site; attendance uses the total hours.',
  AUTO_LEAVE: 'An absence was covered automatically using paid leave.',
  LEAVE_UNPAID: 'The leave balance could not cover this leave.',
  NO_ATTENDANCE_POLICY: 'The default attendance policy was used on this date.',
  SANDWICHED: 'Unpaid under the sandwich rule.',
};
const KIND_LABEL = { WORKING: 'Working day', WEEKLY_OFF: 'Weekly off', HOLIDAY: 'Holiday' };
const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const toMin = (value) => {
  if (!/^\d{2}:\d{2}$/.test(value ?? '')) return null;
  const [h, m] = value.split(':').map(Number);
  return h < 24 && m < 60 ? h * 60 + m : null;
};
const toHHMM = (value) => {
  const min = ((Number(value ?? 0) % 1440) + 1440) % 1440;
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
};
const hours = (min) => String(Math.round((Number(min ?? 0) / 60) * 100) / 100);
const minuteOf = (iso, date) => Math.round((Date.parse(iso) - Date.parse(date + 'T00:00:00+05:30')) / 60_000);

function Outcome({ value, kind }) {
  if (!value) return null;
  const parts = [
    value.worked_min ? mins(value.worked_min) + ' worked' : null,
    value.late_min ? 'arrival delay ' + value.late_min + ' min' : kind === 'WORKING' && value.worked_min ? 'on time' : null,
    value.ot_min ? mins(value.ot_min) + ' overtime' : null,
  ].filter(Boolean);
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <DayChip status={value.status} />
      <span className="text-muted-foreground">{parts.join(' · ') || DAY_STATUS_LABELS[value.status]}</span>
    </span>
  );
}

/** The month calendar stays above the selected day's details and correction editor. */
export function CorrectionDrawer({ employeeId, date: startDate, open, onOpenChange, readOnly = false }) {
  const { can } = useSession();
  const [selection, setSelection] = useState(() => ({ employeeId, startDate, date: startDate }));
  const matches = selection.employeeId === employeeId && selection.startDate === startDate;
  const date = matches ? selection.date : startDate;
  useEffect(() => {
    setSelection((current) => current.employeeId === employeeId && current.startDate === startDate ? current : { employeeId, startDate, date: startDate });
  }, [startDate, employeeId]);
  const pickDate = (next) => setSelection({ employeeId, startDate, date: next });
  const { data: lk } = useLookups();
  const today = lk?.today ?? istToday();
  const ym = date?.slice(0, 7);
  const month = useQuery({
    queryKey: ['emp-attendance', employeeId, ym],
    queryFn: () => api.get('/employees/' + employeeId + '/attendance', { month: ym }).then((r) => r.data),
    enabled: open && !!employeeId && !!ym && can('attendance.read'),
    placeholderData: keepPreviousData,
  });
  // A previous employee or month's cached response must never appear in this drawer.
  const data = !month.isPlaceholderData && month.data?.month === ym ? month.data : null;
  const monthlyDay = data?.days?.find((day) => day.date === date);
  return (
    <Drawer open={open} onOpenChange={onOpenChange} title="Attendance details">
      {date && (
        <>
          {month.isError ? (
            <ErrorState error={month.error} onRetry={() => month.refetch()} compact />
          ) : (
            <AttendanceMonthCalendar ym={ym} data={data} loading={month.isLoading || month.isPlaceholderData || !data} date={date} today={today} onPick={pickDate} />
          )}
          <div className="mt-4 border-t pt-4">
            <AttendanceDayPanel
              employeeId={employeeId}
              date={date}
              monthlyDay={monthlyDay}
              readOnly={readOnly}
              enabled={open}
              onPreviousDay={() => pickDate(addDays(date, -1))}
              onNextDay={date < today ? () => pickDate(addDays(date, 1)) : undefined}
            />
          </div>
        </>
      )}
    </Drawer>
  );
}

/** A day/employee change resets the editor; background refetches preserve an unfinished correction. */
export function AttendanceDayPanel(props) {
  return <DayDetailsEditor key={props.employeeId + ':' + props.date} {...props} />;
}

function DayDetailsEditor({ employeeId, date, monthlyDay, readOnly = false, enabled = true, onPreviousDay, onNextDay }) {
  const qc = useQueryClient();
  const { can } = useSession();
  const { data: lk } = useLookups();
  const today = lk?.today ?? istToday();
  const q = useQuery({
    queryKey: ['attendance-day', employeeId, date],
    queryFn: () => api.get('/attendance/day', { employee_id: employeeId, date }).then((r) => r.data),
    enabled: enabled && !!employeeId && !!date && can('attendance.read'),
  });
  const d = q.data?.date === date ? q.data : null;
  const c = d?.context;
  const canEdit = !readOnly && can('attendance.write') && !d?.frozen?.frozen && !d?.not_in_employment && !!c && date <= today;
  const [mode, setMode] = useState('MARK');
  const [times, setTimes] = useState({ in: '09:00', out: '18:00', ot: '0', edited: 'out' });
  const [mark, setMark] = useState({ status: '', ot: '0' });
  const [reason, setReason] = useState('');
  const initialized = useRef(false);
  const dirty = useRef(false);
  useEffect(() => {
    if (!d?.context || initialized.current || dirty.current) return;
    initialized.current = true;
    const o = d.override;
    setMode(o?.in_min != null ? 'TIMES' : 'MARK');
    setTimes({
      in: toHHMM(d.in_min ?? c.shift_start_min),
      out: toHHMM(d.out_min ?? c.shift_end_min),
      ot: hours(o?.ot_min ?? d.computed?.ot_min),
      edited: 'out',
    });
    setMark({
      status: o && o.in_min == null && ['PRESENT', 'HALF_DAY', 'ABSENT'].includes(o.status) ? o.status : '',
      ot: hours(o?.in_min == null ? o?.ot_min : 0),
    });
  }, [d, c]);
  const editTimes = (patch) => {
    dirty.current = true;
    setTimes((current) => ({ ...current, ...patch }));
  };
  const editMark = (patch) => {
    dirty.current = true;
    setMark((current) => ({ ...current, ...patch }));
  };
  const inMin = toMin(times.in);
  const outRaw = toMin(times.out);
  const outMin = inMin !== null && outRaw !== null ? (outRaw <= inMin ? outRaw + 1440 : outRaw) : null;
  const otMin = Math.round(Number(times.ot || 0) * 60);
  const currentParams = useMemo(
    () => (times.edited === 'ot' ? { in_min: inMin, ot_min: otMin } : { in_min: inMin, out_min: outMin }),
    [times.edited, inMin, otMin, outMin],
  );
  const params = useDebounced(currentParams, 250);
  const paramsCurrent = JSON.stringify(currentParams) === JSON.stringify(params);
  const canOt = !!c?.ot && c.kind === 'WORKING';
  const preview = useQuery({
    queryKey: ['correction-preview', employeeId, date, params],
    queryFn: () => api.post('/attendance/overrides/preview', { employee_id: employeeId, work_date: date, ...params }).then((r) => r.data),
    enabled:
      enabled &&
      canEdit &&
      mode === 'TIMES' &&
      params.in_min !== null &&
      (times.edited === 'ot' ? Number.isFinite(params.ot_min) && params.ot_min >= 0 : params.out_min != null) &&
      !(times.edited === 'ot' && !canOt),
    retry: false,
  });
  // Never save an OUT time calculated for an earlier keystroke.
  const p = paramsCurrent && !preview.isFetching ? preview.data : null;
  const shownOut = times.edited === 'ot' && p ? toHHMM(p.out_min) : times.out;
  const shownOt = times.edited === 'ot' ? times.ot : p ? hours(p.ot_min) : times.ot;
  const saveOut = times.edited === 'ot' ? (p?.out_min ?? null) : outMin;
  const refresh = async () => {
    initialized.current = false;
    dirty.current = false;
    setReason('');
    await Promise.all(
      [
        'attendance-day',
        'register',
        'emp-attendance',
        'attendance-month',
        'payroll-attendance',
        'approvals',
        'dashboard',
        'site-insights',
        'sites',
        'site-register',
        'employee-pay',
        'emp-leave',
        'payroll',
        'payroll-preview',
        'payroll-summary',
        'payroll-issues',
        'payslip-preview',
      ].map((key) => qc.invalidateQueries({ queryKey: [key] })),
    );
  };
  const save = useMutation({
    mutationFn: () => {
      if (!canEdit) throw new Error('Attendance cannot be changed here.');
      return api.post(
        '/attendance/overrides',
        mode === 'TIMES'
          ? { mode, employee_id: employeeId, work_date: date, in_min: inMin, out_min: saveOut, reason_text: reason }
          : {
              mode,
              employee_id: employeeId,
              work_date: date,
              status: mark.status,
              ot_min: mark.status === 'PRESENT' && canOt ? Math.round(Number(mark.ot || 0) * 60) : 0,
              reason_text: reason,
            },
      );
    },
    onSuccess: async () => {
      toast.success('Attendance corrected. Original punches are kept.');
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const revert = useMutation({
    mutationFn: () => {
      if (!canEdit || !d?.override) throw new Error('This correction cannot be reverted.');
      return api.del('/attendance/overrides/' + d.override.id);
    },
    onSuccess: async () => {
      toast.success('Original attendance restored');
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const off = c && c.kind !== 'WORKING';
  const markOptions = [
    { value: 'PRESENT', label: off ? 'Worked full day' : 'Full day' },
    { value: 'HALF_DAY', label: off ? 'Worked half day' : 'Half day' },
    { value: 'ABSENT', label: off ? 'Not worked' : 'Absent' },
  ];
  const validOt = (v) => Number.isFinite(Number(v || 0)) && Number(v || 0) >= 0;
  const timesOk = inMin !== null && saveOut !== null && !!p && !preview.isError && validOt(times.ot);
  const ok = canEdit && reason.trim().length >= 3 && (mode === 'TIMES' ? timesOk : !!mark.status && validOt(mark.ot)) && !save.isPending && !revert.isPending;
  const emp = d?.employee;
  const now = monthlyDay ?? d?.day ?? d?.override ?? d?.computed;
  const required = monthlyDay?.required_shift_min ?? d?.required_shift_min ?? now?.required_shift_min ?? c?.standard_min;
  const requiredForDisplay = ['ABSENT', 'MISSING_PUNCH'].includes(monthlyDay?.baseline_status ?? now?.status) && Number(required) <= 0 ? c?.standard_min : required;
  const shortfall =
    monthlyDay?.shift_shortfall_min ??
    d?.shift_shortfall_min ??
    now?.shift_shortfall_min ??
    (now?.worked_min > 0 && c?.kind === 'WORKING' && !['MISSING_PUNCH', 'ON_LEAVE', 'ABSENT'].includes(now.status)
      ? Math.max(0, Number(required ?? 0) - now.worked_min)
      : 0);
  const stillIn = !!d?.open_now && !d?.override;
  const missing = now?.status === 'MISSING_PUNCH' && !stillIn;
  const autoLeave = Number(monthlyDay?.auto_leave ?? 0);
  const appliedLeave = Math.max(0, Number(monthlyDay?.leave_days ?? 0) - autoLeave);

  return (
    <section aria-label="Selected day attendance" className="space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          {emp && <DeptAvatar name={emp.name} token={emp.department?.colour} size={36} />}
          <div className="min-w-0">
            {emp && (
              <div className="flex flex-wrap items-baseline gap-2 text-sm font-semibold">
                {emp.name}
                <Mono className="text-[11px] font-normal text-muted-foreground">{emp.code}</Mono>
              </div>
            )}
            <h3 className="mt-1 text-[13px] font-medium">
              {fullDate(date)}
              {today === date ? ' · Today' : ''}
            </h3>
            {c && (
              <p className="mt-1 text-[12px] text-muted-foreground">
                {KIND_LABEL[c.kind]} · {hhmm(c.shift_start_min)}–{hhmm(c.shift_end_min)}
              </p>
            )}
          </div>
        </div>
        {(onPreviousDay || onNextDay) && (
          <div className="flex shrink-0">
            <Button variant="ghost" size="icon" className="size-7" aria-label="Previous day" disabled={!onPreviousDay} onClick={onPreviousDay}>
              <ChevronLeft />
            </Button>
            <Button variant="ghost" size="icon" className="size-7" aria-label="Next day" disabled={!onNextDay} onClick={onNextDay}>
              <ChevronRight />
            </Button>
          </div>
        )}
      </div>
      {q.isLoading ? (
        <SkeletonBlock className="h-64" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} compact />
      ) : d?.not_in_employment ? (
        <p className="text-sm text-muted-foreground">This employee was not employed on this date.</p>
      ) : d ? (
        <>
          <div className="flex flex-wrap gap-2">
            {now && <DayChip status={now.status} overridden={!!d.override} />}
            {d.open_now && !d.override && <Chip tone="success">Still punched in</Chip>}
            {d.override && <Chip tone="info">Corrected</Chip>}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['First in', hhmm(d.in_min)],
              ['Last out', stillIn ? 'On site' : missing ? 'Missing' : hhmm(d.out_min)],
              ['Worked', now?.worked_min ? mins(now.worked_min) : '—'],
              ['Overtime', mins(now?.ot_min ?? 0)],
            ].map(([label, value]) => (
              <div key={label} className={cn('rounded-md bg-muted/60 px-2.5 py-2', label === 'Last out' && missing && 'bg-destructive/10 text-destructive')}>
                <div className="text-[11px] text-muted-foreground">{label}</div>
                <div className="mt-1 text-[15px] font-semibold num">{value}</div>
              </div>
            ))}
          </div>
          {c.kind === 'WORKING' && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
              <span>
                Required shift <b className="font-medium text-foreground">{mins(requiredForDisplay ?? 0)}</b>
              </span>
              <span>
                Arrival delay <b className="font-medium text-foreground">{now?.late_min ?? 0} min</b>
              </span>
              <span title="Shortfall from the required shift; these minutes add up as Late minutes for the month.">
                Shift shortfall <b className={cn('font-medium', shortfall > 0 ? 'text-destructive' : 'text-foreground')}>{shortfall} min</b>
              </span>
            </div>
          )}
          {(appliedLeave > 0 || autoLeave > 0) && (
            <p className="rounded-md bg-primary/5 px-3 py-2 text-[12px] text-muted-foreground">
              {[
                appliedLeave > 0 ? 'Applied paid leave ' + appliedLeave + ' day' + (appliedLeave === 1 ? '' : 's') : null,
                autoLeave > 0 ? 'Automatic paid leave ' + autoLeave + ' day' + (autoLeave === 1 ? '' : 's') : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          <Note d={d} />
          <details className="rounded-md border px-3 py-2.5">
            <summary className="cursor-pointer text-[13px] font-medium">Original punches{d.punches?.length ? ' · ' + d.punches.length : ''}</summary>
            <div className="mt-3 space-y-3">
              <Timeline punches={d.punches ?? []} date={date} context={c} missing={d.computed?.status === 'MISSING_PUNCH'} />
              {d.punches?.length ? (
                <ul className="divide-y text-[13px]">
                  {d.punches.map((pu) => (
                    <li key={pu.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2">
                      <span className="w-11 font-semibold num">{istTime(pu.punched_at)}</span>
                      <Chip tone={pu.direction === 'IN' ? 'success' : 'muted'}>{pu.direction === 'IN' ? 'In' : 'Out'}</Chip>
                      <span className="min-w-0 flex-1">{pu.site?.name ?? 'Manual correction'}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {pu.method === 'FACE' ? 'Face' : pu.method?.toLowerCase()}
                        {pu.match_score != null ? ' ' + Math.round(pu.match_score * 100) + '%' : ''}
                      </span>
                      {pu.flagged && (
                        <Chip tone="warning" title={pu.flag_reason ?? ''}>
                          Flagged
                        </Chip>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted-foreground">No punches on this date.</p>
              )}
              {d.override && (
                <div className="text-[12px] text-muted-foreground">
                  <span className="mb-1 block">Before correction</span>
                  <Outcome value={d.computed} kind={c.kind} />
                </div>
              )}
            </div>
          </details>
          {d.override && (
            <section aria-label="Existing correction" className="rounded-md border border-info/30 bg-info/5 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">{d.override.reason_text}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {d.override.created_by} · {istTime(d.override.created_at, true)}
                  </p>
                </div>
                {canEdit && (
                  <Button size="sm" variant="outline" loading={revert.isPending} disabled={save.isPending} onClick={() => revert.mutate()}>
                    <Undo2 /> Revert
                  </Button>
                )}
              </div>
            </section>
          )}
          {d.frozen?.frozen ? (
            <LockedNotice title="Attendance for this month is submitted">{d.frozen.reason}</LockedNotice>
          ) : canEdit ? (
            <section aria-label="Correct attendance" className="space-y-3 border-t pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-semibold">Correct attendance</h4>
                <Segmented
                  label="Correction method"
                  value={mode}
                  onChange={(value) => {
                    dirty.current = true;
                    setMode(value);
                  }}
                  options={[
                    { value: 'MARK', label: 'Mark day' },
                    { value: 'TIMES', label: 'In and out times' },
                  ]}
                />
              </div>
              {mode === 'MARK' ? (
                <>
                  <Segmented
                    label="Day status"
                    className="flex w-full *:flex-1"
                    value={mark.status}
                    onChange={(status) => editMark({ status })}
                    options={markOptions}
                  />
                  {canOt && mark.status === 'PRESENT' && (
                    <Field label="Overtime (hours)" className="max-w-44">
                      {(id) => (
                        <Input id={id} type="number" min={0} step={c.ot.rounding_min / 60} value={mark.ot} onChange={(e) => editMark({ ot: e.target.value })} />
                      )}
                    </Field>
                  )}
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Punch in">{(id) => <Input id={id} type="time" value={times.in} onChange={(e) => editTimes({ in: e.target.value })} />}</Field>
                    <Field label="Punch out" hint={inMin !== null && toMin(shownOut) !== null && toMin(shownOut) <= inMin ? 'Next day' : undefined}>
                      {(id) => <Input id={id} type="time" value={shownOut} onChange={(e) => editTimes({ out: e.target.value, edited: 'out' })} />}
                    </Field>
                    {canOt && (
                      <Field label="Overtime (hours)" hint="Also updates the out time" className="col-span-2 max-w-52">
                        {(id) => (
                          <Input
                            id={id}
                            type="number"
                            min={0}
                            step={c.ot.rounding_min / 60}
                            value={shownOt}
                            onChange={(e) => editTimes({ ot: e.target.value, out: shownOut, edited: 'ot' })}
                          />
                        )}
                      </Field>
                    )}
                  </div>
                  <div className="rounded-md bg-muted/60 px-3 py-2">
                    {paramsCurrent && preview.isError ? (
                      <span role="alert" className="text-[13px] text-destructive">
                        {errorMessage(preview.error)}
                      </span>
                    ) : p ? (
                      <Outcome value={p} kind={c.kind} />
                    ) : (
                      <p className="text-[13px] text-muted-foreground">Updating the day preview…</p>
                    )}
                  </div>
                  {!canOt && (
                    <p className="text-[12px] text-muted-foreground">
                      {off ? 'Off-day hours follow the off-day pay policy.' : 'No overtime policy applies to this employee.'}
                    </p>
                  )}
                </>
              )}
              <Field label="Correction reason">
                {(id) => (
                  <Input
                    id={id}
                    value={reason}
                    placeholder="Why is this day being corrected?"
                    onChange={(e) => {
                      dirty.current = true;
                      setReason(e.target.value);
                    }}
                  />
                )}
              </Field>
              <div className="flex justify-end">
                <Button loading={save.isPending} disabled={!ok} onClick={() => save.mutate()}>
                  Save correction
                </Button>
              </div>
            </section>
          ) : (
            <p className="border-t pt-3 text-[12px] text-muted-foreground">
              {date > today ? 'Future attendance cannot be corrected.' : 'Attendance is read-only for this employee or your role.'}
            </p>
          )}
        </>
      ) : null}
    </section>
  );
}

/** The person's month: one cell per day, the picked day ringed, the figures so far on top. */
export function AttendanceMonthCalendar({ ym, data, loading, date, today, onPick, showSummary = true }) {
  const days = data?.month === ym ? (data.days ?? []) : [];
  const lead = days.length ? new Date(`${days[0].date}T00:00:00Z`).getUTCDay() : 0;
  const sofar = days.filter((x) => (!today || x.date <= today) && x.status !== 'NOT_JOINED' && x.status !== 'EXITED');
  const paid = data?.attendance_summary?.paid_days ?? Math.round(sofar.reduce((a, x) => a + Number(x.day_value ?? 0), 0) * 100) / 100;
  const lop = data?.attendance_summary?.lop_days ?? Math.round((sofar.length - paid) * 100) / 100;
  const late = data?.attendance_summary?.late_minutes ?? sofar.reduce((sum, day) => sum + Number(day.shift_shortfall_min ?? 0), 0);
  return (
    <section aria-label="Month attendance calendar">
      {showSummary && (
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">{monthName(ym)}</span>
          {days.length > 0 && (
            <span className="text-[12px] text-muted-foreground num">
              Paid {paid} · LOP {lop}
            </span>
          )}
        </div>
      )}
      <div className="grid grid-cols-7 gap-1">
        {WEEK.map((w, i) => (
          <span key={i} className="text-center text-[11px] text-muted-foreground">
            {w}
          </span>
        ))}
        {loading && !days.length ? Array.from({ length: 35 }).map((_, i) => <span key={i} className="min-h-[64px] animate-pulse rounded-md bg-muted" />) : null}
        {Array.from({ length: lead }).map((_, i) => (
          <span key={`b${i}`} />
        ))}
        {days.map((x) => {
          const future = today && x.date > today;
          const cell = cellOf(x.status);
          const on = x.date === date;
          return (
            <button
              key={x.date}
              type="button"
              disabled={future}
              onClick={() => onPick(x.date)}
              aria-pressed={on}
              aria-label={fullDate(x.date) + ': ' + (DAY_STATUS_LABELS[x.status] ?? cell.label)}
              title={`${fullDate(x.date)}: ${DAY_STATUS_LABELS[x.status] ?? ''}${x.overridden ? ' (corrected)' : ''}`}
              className={cn(
                'relative flex min-h-[64px] flex-col items-start rounded-md px-1.5 py-1 text-left text-[11px] leading-tight transition-shadow disabled:opacity-40',
                on && 'ring-2 ring-primary',
              )}
              style={future ? CELL_STYLE.none : CELL_STYLE[cell.tone]}
            >
              <b className="text-[12px] num">{Number(x.date.slice(8))}</b>
              {!future && <span className="mt-1 w-full truncate">{cell.label}</span>}
              {!future && x.worked_min > 0 && <span className="mt-0.5 w-full truncate text-[9px] num">{mins(x.worked_min)}</span>}
              {x.overridden && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />}
            </button>
          );
        })}
      </div>
      {showSummary && days.length > 0 && (
        <section aria-label="Monthly attendance totals" className="mt-3 flex items-center justify-between rounded-md bg-muted/60 px-3 py-2 text-[12px]" title="Total shortfall from the employee's required shift across this month.">
          <span className="text-muted-foreground">Late minutes</span>
          <b className={cn('font-semibold num', late > 0 ? 'text-warning-foreground dark:text-warning' : 'text-foreground')}>{late} min</b>
        </section>
      )}
    </section>
  );
}

/** The punches as bars on the day, with the shift marked; a missing punch-out shows faint red to the shift end. */
function Timeline({ punches, date, context, missing }) {
  const bars = useMemo(() => {
    const out = [];
    let open = null;
    for (const pu of punches) {
      const m = minuteOf(pu.punched_at, date);
      if (pu.direction === 'IN') open = { from: m, site: pu.site?.name ?? 'Site' };
      else if (open) {
        out.push({ ...open, to: m });
        open = null;
      }
    }
    if (open) out.push({ ...open, to: context ? Math.max(open.from + 30, context.shift_end_min) : open.from + 60, open: true });
    // A work day runs from the evening before to the next morning at most.
    return out.filter((b) => b.from > -720 && b.to < 2880);
  }, [punches, date, context]);
  const startShift = context?.shift_start_min ?? 540;
  const endShift = context?.shift_end_min ?? 1080;
  const lo = Math.min(360, ...bars.map((b) => Math.floor((b.from - 30) / 180) * 180));
  const hi = Math.max(1260, ...bars.map((b) => Math.ceil((b.to + 30) / 180) * 180));
  const pos = (m) => `${((Math.min(hi, Math.max(lo, m)) - lo) / (hi - lo)) * 100}%`;
  const ticks = [];
  for (let m = lo; m <= hi; m += 180) ticks.push(m);
  return (
    <div>
      <div className="relative h-10 rounded-lg bg-muted/60">
        <span
          className="absolute inset-y-0 border-x border-dashed border-muted-foreground/40"
          style={{ left: pos(startShift), width: `calc(${pos(endShift)} - ${pos(startShift)})` }}
        />
        {bars.map((b, i) => (
          <span
            key={i}
            title={`${b.site}: ${toHHMM(b.from)}–${b.open ? '?' : toHHMM(b.to)}`}
            className="absolute top-[9px] h-[22px] rounded-[5px]"
            style={{
              left: pos(b.from),
              width: `calc(${pos(b.to)} - ${pos(b.from)})`,
              background:
                b.open && missing
                  ? 'color-mix(in srgb, var(--destructive) 35%, var(--card))'
                  : i % 2
                    ? 'color-mix(in srgb, var(--primary) 75%, black)'
                    : 'var(--primary)',
            }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground num">
        {ticks.map((m) => (
          <span key={m}>{toHHMM(m)}</span>
        ))}
      </div>
    </div>
  );
}

/** What HR should notice about the day, in plain words. */
function Note({ d }) {
  const v = d.computed;
  if (!v || d.override) return null;
  const lines = [];
  if (v.late_min) lines.push(`In ${mins(v.late_min)} late.`);
  if (v.status === 'MISSING_PUNCH' && !d.open_now) lines.push('No punch-out. This day is provisional until corrected. Enter the real out time if known.');
  else if (v.early_min)
    lines.push(
      `Left with ${mins(v.early_min)} to go — the day is short of ${mins(d.context?.standard_min ?? 540)}. Decide: count a full day, or keep ${v.status === 'HALF_DAY' ? 'the half day' : 'it as it is'}.`,
    );
  if (v.ot_min) lines.push(`Did ${mins(v.ot_min)} overtime, counted from ${mins(d.context?.standard_min ?? 540)} after punch-in.`);
  for (const f of v.flags ?? []) if (FLAG_TEXT[f] && !(f === 'UNMATCHED_IN' && v.status === 'MISSING_PUNCH')) lines.push(FLAG_TEXT[f]);
  if (!lines.length) return null;
  const warn = v.status === 'MISSING_PUNCH' || v.early_min || v.late_min;
  return (
    <div className={cn('rounded-md px-3 py-2.5 text-[13px]', warn ? 'bg-warning/15 text-foreground' : 'bg-muted/60 text-muted-foreground')}>
      {lines.join(' ')}
    </div>
  );
}
