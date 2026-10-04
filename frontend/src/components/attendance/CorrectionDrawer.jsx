import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Undo2 } from 'lucide-react';
import { addDays } from '@ajpwer/shared';
import { toast } from 'sonner';
import { DAY_STATUS_LABELS } from '@ajpwer/shared';
import { api, errorMessage } from '@/services/api';
import { useDebounced } from '@/hooks';
import { useLookups } from '@/hooks/useLookups';
import { fullDate } from './dayVocab';
import { hhmm, istTime, longDate, mins } from '@/utils';
import { Mono } from '@/components/bits';
import { Chip, DayChip, ErrorState, LockedNotice, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Field, Input, Segmented } from '@/components/ui/form';
import { Drawer } from '@/components/ui/overlay';

const FLAG_TEXT = {
  ORPHAN_OUT: 'An OUT punch with no IN before it',
  UNMATCHED_IN: 'An IN with no OUT after it',
  CROSS_SITE: 'Worked at more than one site — one day, valued by total hours',
  LATE: 'Arrived after the grace period; late counts from shift start',
  EARLY_OUT: 'Left before the day was done (shift end, or a full day after a late arrival) — flagged, not deducted',
  AUTO_LEAVE: 'Paid from paid leave automatically: nobody applied for this absence',
  LEAVE_UNPAID: 'Recorded leave its balance could not pay',
  NO_ATTENDANCE_POLICY: 'No attendance policy on this date — the documented default was used',
  SANDWICHED: 'Unpaid by the sandwich rule',
};

const KIND_LABEL = { WORKING: 'Working day', WEEKLY_OFF: 'Weekly off', HOLIDAY: 'Holiday' };

/** "09:40" ↔ minutes from midnight. */
const toMin = (s) => {
  const [h, m] = (s ?? '').split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};
const toHHMM = (min) => `${String(Math.floor((min % 1440) / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const hours = (min) => (min ? String(Math.round((min / 60) * 100) / 100) : '0');

/** What a day comes to, in one line: the status, then hours, lateness and overtime. */
function Outcome({ v, kind }) {
  if (!v) return null;
  const parts = [
    v.worked_min ? `${mins(v.worked_min)} worked` : null,
    v.late_min ? `late ${v.late_min} min` : kind === 'WORKING' && v.worked_min ? 'on time' : null,
    v.ot_min ? `overtime ${mins(v.ot_min)}` : null,
    v.early_min ? `left ${mins(v.early_min)} early` : null,
  ].filter(Boolean);
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <DayChip status={v.status} />
      <span className="text-muted-foreground">{parts.join(' · ') || DAY_STATUS_LABELS[v.status]}</span>
    </span>
  );
}

/**
 * Correct one day. Either the times worked — late minutes, a half or full day and overtime
 * follow from them by the attendance rules, and typing the overtime moves the out time — or a
 * plain mark of the day with any overtime entered directly.
 */
export function CorrectionDrawer({ employeeId, date: startDate, open, onOpenChange }) {
  const qc = useQueryClient();
  // Opens on the day that was clicked; the arrows step to the days around it.
  const [date, setDate] = useState(startDate);
  useEffect(() => setDate(startDate), [startDate, employeeId]);
  const { data: lk } = useLookups();
  const q = useQuery({ queryKey: ['attendance-day', employeeId, date], queryFn: () => api.get('/attendance/day', { employee_id: employeeId, date }).then((r) => r.data), enabled: open });
  const d = q.data;
  const c = d?.context;
  const [mode, setMode] = useState('TIMES');
  const [t, setT] = useState({ in: '09:00', out: '18:00', ot: '0', edited: 'out' });
  const [mark, setMark] = useState({ status: 'PRESENT', ot: '0' });
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (!d?.context) return;
    const o = d.override;
    setMode(o && o.in_min === null ? 'MARK' : 'TIMES');
    setT({ in: toHHMM(d.in_min ?? d.context.shift_start_min), out: toHHMM(d.out_min ?? d.context.shift_end_min), ot: hours(o?.ot_min ?? d.computed?.ot_min), edited: 'out' });
    setMark({ status: o && ['PRESENT', 'HALF_DAY', 'ABSENT'].includes(o.status) ? o.status : 'PRESENT', ot: hours(o?.in_min === null ? o.ot_min : 0) });
    setReason('');
  }, [d]);

  // Times: the out time may pass midnight.
  const inMin = toMin(t.in);
  const outRaw = toMin(t.out);
  const outMin = inMin !== null && outRaw !== null ? (outRaw <= inMin ? outRaw + 1440 : outRaw) : null;
  const otMin = Math.round(Number(t.ot || 0) * 60);
  const params = useDebounced(t.edited === 'ot' ? { in_min: inMin, ot_min: otMin } : { in_min: inMin, out_min: outMin }, 250);
  const canOt = !!c?.ot && c.kind === 'WORKING';
  const preview = useQuery({
    queryKey: ['correction-preview', employeeId, date, params],
    queryFn: () => api.post('/attendance/overrides/preview', { employee_id: employeeId, work_date: date, ...params }).then((r) => r.data),
    enabled: open && !!c && mode === 'TIMES' && params.in_min !== null && (params.out_min !== null || params.ot_min !== undefined) && !(t.edited === 'ot' && !canOt),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const p = preview.data;
  // Whichever HR typed last leads: the out time gives the overtime, or the overtime gives the out time.
  const shownOut = t.edited === 'ot' && p ? toHHMM(p.out_min) : t.out;
  const shownOt = t.edited === 'ot' ? t.ot : p ? hours(p.ot_min) : t.ot;
  const saveOut = t.edited === 'ot' && p ? p.out_min : outMin;

  const invalidate = () => {
    for (const key of [['attendance-day', employeeId, date], ['register'], ['emp-attendance'], ['payroll-attendance']]) qc.invalidateQueries({ queryKey: key });
  };
  const save = useMutation({
    mutationFn: () =>
      api.post(
        '/attendance/overrides',
        mode === 'TIMES'
          ? { mode, employee_id: employeeId, work_date: date, in_min: inMin, out_min: saveOut, reason_text: reason }
          : { mode, employee_id: employeeId, work_date: date, status: mark.status, ot_min: mark.status === 'PRESENT' && canOt ? Math.round(Number(mark.ot || 0) * 60) : 0, reason_text: reason },
      ),
    onSuccess: () => {
      toast.success('Day corrected. What the punches said is kept alongside it.');
      invalidate();
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const revert = useMutation({
    mutationFn: () => api.del(`/attendance/overrides/${d.override.id}`),
    onSuccess: () => {
      toast.success('Back to what the punches say');
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const off = c && c.kind !== 'WORKING';
  const markOptions = off
    ? [
        { value: 'PRESENT', label: 'Worked full day' },
        { value: 'HALF_DAY', label: 'Worked half day' },
        { value: 'ABSENT', label: 'Not worked' },
      ]
    : [
        { value: 'PRESENT', label: 'Full day' },
        { value: 'HALF_DAY', label: 'Half day' },
        { value: 'ABSENT', label: 'Absent' },
      ];
  const timesOk = mode !== 'TIMES' || (inMin !== null && saveOut !== null && !preview.isError);
  const ok = reason.trim().length >= 3 && timesOk;

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={d ? `${d.employee.name} — ${longDate(date)}` : 'Correct a day'}
      description={
        d && c ? (
          <>
            <Mono>{d.employee.code}</Mono> · {KIND_LABEL[c.kind]} · shift {hhmm(c.shift_start_min)}–{hhmm(c.shift_end_min)}, {c.grace_min} min grace, {mins(c.standard_min)} day
          </>
        ) : undefined
      }
    >
      <div className="mb-4 flex items-center gap-2 rounded-lg border bg-muted/40 px-2 py-1.5">
        <Button variant="ghost" size="icon" className="size-8" aria-label="Previous day" onClick={() => setDate(addDays(date, -1))}>
          <ChevronLeft />
        </Button>
        <span className="flex-1 text-center text-[14px] font-semibold text-primary">
          {fullDate(date)}
          {lk?.today === date ? ' · today' : ''}
        </span>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Next day" disabled={!!lk?.today && date >= lk.today} onClick={() => setDate(addDays(date, 1))}>
          <ChevronRight />
        </Button>
      </div>
      {q.isLoading ? (
        <SkeletonBlock className="h-80" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : d?.not_in_employment ? (
        <p className="text-sm text-muted-foreground">This person was not employed on this date.</p>
      ) : d ? (
        <div className="flex flex-col gap-6">
          <section>
            <h3 className="mb-2 font-sans text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">What the punches say</h3>
            {d.punches.length === 0 ? (
              <p className="text-sm text-muted-foreground">No punches on this date.</p>
            ) : (
              <ul className="divide-y rounded-md border text-sm">
                {d.punches.map((pu) => (
                  <li key={pu.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                    <span className="w-12 font-semibold num">{istTime(pu.punched_at)}</span>
                    <Chip tone={pu.direction === 'IN' ? 'success' : 'muted'}>{pu.direction === 'IN' ? 'In' : 'Out'}</Chip>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {pu.site.name} · {pu.method.toLowerCase()}
                      {pu.match_score !== null ? ` ${Math.round(pu.match_score * 100)}%` : ''}
                    </span>
                    {pu.flagged && (
                      <Chip tone="warning" title={pu.flag_reason ?? ''}>
                        flagged
                      </Chip>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {d.computed && (
              <div className="mt-2.5">
                <Outcome v={d.computed} kind={c.kind} />
                {d.computed.flags.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-[13px] text-muted-foreground">
                    {d.computed.flags.map((fl) => (
                      <li key={fl}>{FLAG_TEXT[fl] ?? fl}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          {d.override && (
            <section className="rounded-md border border-info/30 bg-info/5 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">Corrected by HR</div>
                  <div className="mt-1.5">
                    <Outcome v={d.override} kind={c.kind} />
                  </div>
                  <p className="mt-1.5 text-sm">
                    {d.override.in_min !== null ? `${hhmm(d.override.in_min)}–${hhmm(d.override.out_min)} · ` : 'Marked · '}
                    {d.override.reason_text}
                  </p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">
                    {d.override.created_by}, {istTime(d.override.created_at, true)}
                  </p>
                </div>
                {!d.frozen.frozen && (
                  <Button size="sm" variant="outline" loading={revert.isPending} onClick={() => revert.mutate()}>
                    <Undo2 /> Revert
                  </Button>
                )}
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-3 font-sans text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">{d.override ? 'Change the correction' : 'Correct this day'}</h3>
            {d.frozen.frozen ? (
              <LockedNotice title="Attendance for this month is submitted">{d.frozen.reason}</LockedNotice>
            ) : (
              <div className="flex flex-col gap-4">
                <Segmented
                  label="How to correct"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'TIMES', label: 'In and out times' },
                    { value: 'MARK', label: 'Mark the day' },
                  ]}
                />
                {mode === 'TIMES' ? (
                  <>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      <Field label="In">{(id) => <Input id={id} type="time" value={t.in} onChange={(e) => setT({ ...t, in: e.target.value })} />}</Field>
                      <Field label="Out" hint={outRaw !== null && inMin !== null && toMin(shownOut) <= inMin ? 'next day' : undefined}>
                        {(id) => <Input id={id} type="time" value={shownOut} onChange={(e) => setT({ ...t, out: e.target.value, edited: 'out' })} />}
                      </Field>
                      {canOt ? (
                        <Field label="Overtime (hours)" hint="Moves the out time">
                          {(id) => (
                            <Input
                              id={id}
                              type="number"
                              min={0}
                              step={c.ot.rounding_min / 60}
                              value={shownOt}
                              onChange={(e) => setT({ ...t, ot: e.target.value, out: shownOut, edited: 'ot' })}
                            />
                          )}
                        </Field>
                      ) : (
                        <div className="self-end pb-2 text-[12px] leading-snug text-muted-foreground">{off ? 'Off-day hours are paid by the off-day policy, not as overtime.' : 'No overtime policy for this pay group.'}</div>
                      )}
                    </div>
                    <div className="min-h-[34px] rounded-md bg-muted/60 px-3 py-2">
                      {preview.isError ? (
                        <span className="text-sm text-destructive">{errorMessage(preview.error)}</span>
                      ) : p ? (
                        <span className="flex flex-wrap items-center justify-between gap-2">
                          <Outcome v={p} kind={c.kind} />
                          {p.due_out_min !== null && <span className="text-[12px] text-muted-foreground num">Day ends {hhmm(p.due_out_min)}</span>}
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">Working it out…</span>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="flex flex-wrap items-end gap-3">
                    <Segmented label="Mark" value={mark.status} onChange={(status) => setMark({ ...mark, status })} options={markOptions} />
                    {canOt && mark.status === 'PRESENT' && (
                      <Field label="Overtime (hours)" className="w-36">
                        {(id) => <Input id={id} type="number" min={0} step={c.ot.rounding_min / 60} value={mark.ot} onChange={(e) => setMark({ ...mark, ot: e.target.value })} />}
                      </Field>
                    )}
                  </div>
                )}
                <Field label="Reason" required hint="A few words HR will read if the payslip is questioned.">
                  {(id) => <Input id={id} value={reason} placeholder="e.g. Forgot to punch out, confirmed by site engineer" onChange={(e) => setReason(e.target.value)} />}
                </Field>
                <div className="flex justify-end">
                  <Button loading={save.isPending} disabled={!ok} onClick={() => save.mutate()}>
                    Save correction
                  </Button>
                </div>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
