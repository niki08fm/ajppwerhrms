import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Clock, Undo2 } from 'lucide-react';
import { addDays, DAY_STATUS_LABELS } from '@ajpwer/shared';
import { toast } from 'sonner';
import { api, errorMessage } from '@/services/api';
import { useDebounced } from '@/hooks';
import { useLookups } from '@/hooks/useLookups';
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
  CROSS_SITE: 'Worked at more than one site — one day, valued by total hours.',
  AUTO_LEAVE: 'Paid from paid leave automatically: nobody applied for this absence.',
  LEAVE_UNPAID: 'Recorded leave its balance could not pay.',
  NO_ATTENDANCE_POLICY: 'No attendance policy on this date — the documented default was used.',
  SANDWICHED: 'Unpaid by the sandwich rule.',
};

const KIND_LABEL = { WORKING: 'Working day', WEEKLY_OFF: 'Weekly off', HOLIDAY: 'Holiday' };
const WEEK = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** "09:40" ↔ minutes from midnight. */
const toMin = (s) => {
  const [h, m] = (s ?? '').split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};
const toHHMM = (min) => `${String(Math.floor((min % 1440) / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const hours = (min) => (min ? String(Math.round((min / 60) * 100) / 100) : '0');
/** Minutes from IST midnight of the work date — past 1440 for a punch after midnight. */
const minuteOf = (iso, date) => Math.round((Date.parse(iso) - Date.parse(`${date}T00:00:00+05:30`)) / 60_000);

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
 * One person: their month as a calendar, and the day picked on it — the punches on a time
 * line, what they make the day, and the correction. Opens on the day that was clicked;
 * tapping another day in the calendar (or the arrows) moves to it.
 */
export function CorrectionDrawer({ employeeId, date: startDate, open, onOpenChange }) {
  const qc = useQueryClient();
  const [date, setDate] = useState(startDate);
  useEffect(() => setDate(startDate), [startDate, employeeId]);
  const { data: lk } = useLookups();
  const today = lk?.today;
  const ym = date.slice(0, 7);
  const q = useQuery({ queryKey: ['attendance-day', employeeId, date], queryFn: () => api.get('/attendance/day', { employee_id: employeeId, date }).then((r) => r.data), enabled: open, placeholderData: keepPreviousData });
  const month = useQuery({ queryKey: ['emp-attendance', employeeId, ym], queryFn: () => api.get(`/employees/${employeeId}/attendance`, { month: ym }).then((r) => r.data), enabled: open, placeholderData: keepPreviousData });
  const d = q.data?.date === date ? q.data : q.isFetching ? null : q.data;
  const c = d?.context;

  const [mode, setMode] = useState('MARK');
  const [t, setT] = useState({ in: '09:00', out: '18:00', ot: '0', edited: 'out' });
  const [mark, setMark] = useState({ status: '', ot: '0' });
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (!d?.context) return;
    const o = d.override;
    setMode(o && o.in_min !== null ? 'TIMES' : 'MARK');
    setT({ in: toHHMM(d.in_min ?? d.context.shift_start_min), out: toHHMM(d.out_min ?? d.context.shift_end_min), ot: hours(o?.ot_min ?? d.computed?.ot_min), edited: 'out' });
    setMark({ status: o && o.in_min === null && ['PRESENT', 'HALF_DAY', 'ABSENT'].includes(o.status) ? o.status : '', ot: hours(o?.in_min === null ? o.ot_min : 0) });
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
    for (const key of [['attendance-day', employeeId, date], ['register'], ['emp-attendance'], ['attendance-month'], ['payroll-attendance'], ['approvals'], ['dashboard']]) qc.invalidateQueries({ queryKey: key });
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
  const ok = reason.trim().length >= 3 && timesOk && (mode === 'TIMES' || !!mark.status);
  const emp = d?.employee;
  const now = d?.override ?? d?.computed;

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title={
        <span className="flex items-center gap-3">
          <DeptAvatar name={emp?.name} token={emp?.department?.colour} size={42} />
          <span className="flex min-w-0 flex-col">
            <span className="flex items-baseline gap-2 font-sans text-[17px] font-semibold">
              {emp?.name ?? 'Loading…'} {emp && <Mono className="text-[12px] font-normal text-muted-foreground">{emp.code}</Mono>}
            </span>
            {c && (
              <span className="font-sans text-[12px] font-normal text-muted-foreground">
                {[emp?.department?.name, `shift ${hhmm(c.shift_start_min)}–${hhmm(c.shift_end_min)}`, `${c.grace_min} min grace`].filter(Boolean).join(' · ')}
              </span>
            )}
          </span>
        </span>
      }
    >
      <MonthCalendar ym={ym} data={month.data} loading={month.isLoading} date={date} today={today} onPick={setDate} />

      <div className="my-4 flex items-center gap-2 border-t pt-4">
        <Button variant="ghost" size="icon" className="size-8" aria-label="Previous day" onClick={() => setDate(addDays(date, -1))}>
          <ChevronLeft />
        </Button>
        <h3 className="flex-1 font-sans text-[16px] font-semibold">
          {fullDate(date)}
          {today === date ? ' · today' : ''}
          {c && <span className="ml-2 text-[12px] font-normal text-muted-foreground">{KIND_LABEL[c.kind]}</span>}
        </h3>
        {now && <DayChip status={now.status} overridden={!!d.override} />}
        <Button variant="ghost" size="icon" className="size-8" aria-label="Next day" disabled={!!today && date >= today} onClick={() => setDate(addDays(date, 1))}>
          <ChevronRight />
        </Button>
      </div>

      {q.isLoading || (!d && q.isFetching) ? (
        <SkeletonBlock className="h-80" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : d?.not_in_employment ? (
        <p className="text-sm text-muted-foreground">This person was not employed on this date.</p>
      ) : d ? (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['First in', hhmm(d.in_min)],
              ['Last out', d.computed?.status === 'MISSING_PUNCH' && !d.override ? 'No out' : hhmm(d.out_min)],
              ['Worked', now?.worked_min ? mins(now.worked_min) : '—'],
              ['Overtime', now?.ot_min ? mins(now.ot_min) : '—'],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg bg-muted/60 px-3 py-2.5">
                <div className="text-[12px] text-muted-foreground">{k}</div>
                <div className="text-[16px] font-semibold num">{v}</div>
              </div>
            ))}
          </div>

          <Timeline punches={d.punches} date={date} context={c} missing={d.computed?.status === 'MISSING_PUNCH' && !d.override} />

          {d.punches.length === 0 ? (
            <p className="text-sm text-muted-foreground">No punches on this date.</p>
          ) : (
            <ul className="divide-y text-sm">
              {d.punches.map((pu) => (
                <li key={pu.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="w-12 font-semibold num">{istTime(pu.punched_at)}</span>
                  <Chip tone={pu.direction === 'IN' ? 'success' : 'muted'} className="min-w-11 justify-center">
                    {pu.direction === 'IN' ? 'In' : 'Out'}
                  </Chip>
                  <span className="min-w-0 flex-1 truncate">{pu.site.name}</span>
                  <span className="text-[12px] text-muted-foreground">
                    {pu.method === 'FACE' ? 'Face' : pu.method.toLowerCase()}
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

          <Note d={d} />

          {d.override && (
            <section className="rounded-md border border-info/30 bg-info/5 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">Corrected by HR</div>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    The punches said: <Outcome v={d.computed} kind={c.kind} />
                  </p>
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
            <h4 className="mb-2 font-sans text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">This day counts as</h4>
            {d.frozen.frozen ? (
              <LockedNotice title="Attendance for this month is submitted">{d.frozen.reason}</LockedNotice>
            ) : (
              <div className="flex flex-col gap-3">
                {mode === 'MARK' ? (
                  <div className="flex flex-wrap items-end gap-3">
                    <Segmented label="This day counts as" className="flex w-full *:flex-1" value={mark.status} onChange={(status) => setMark({ ...mark, status })} options={markOptions} />
                    {canOt && mark.status === 'PRESENT' && (
                      <Field label="Overtime (hours)" className="w-36">
                        {(id) => <Input id={id} type="number" min={0} step={c.ot.rounding_min / 60} value={mark.ot} onChange={(e) => setMark({ ...mark, ot: e.target.value })} />}
                      </Field>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 rounded-lg border p-3">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                      <Field label="In">{(id) => <Input id={id} type="time" value={t.in} onChange={(e) => setT({ ...t, in: e.target.value })} />}</Field>
                      <Field label="Out" hint={outRaw !== null && inMin !== null && toMin(shownOut) <= inMin ? 'next day' : undefined}>
                        {(id) => <Input id={id} type="time" value={shownOut} onChange={(e) => setT({ ...t, out: e.target.value, edited: 'out' })} />}
                      </Field>
                      {canOt ? (
                        <Field label="Overtime (hours)" hint="Moves the out time">
                          {(id) => <Input id={id} type="number" min={0} step={c.ot.rounding_min / 60} value={shownOt} onChange={(e) => setT({ ...t, ot: e.target.value, out: shownOut, edited: 'ot' })} />}
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
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Input className="min-w-[200px] flex-1" aria-label="Reason" value={reason} placeholder="Reason (shown in the log)" onChange={(e) => setReason(e.target.value)} />
                  <Button variant="outline" onClick={() => setMode(mode === 'MARK' ? 'TIMES' : 'MARK')}>
                    <Clock /> {mode === 'MARK' ? 'Set in and out times' : 'Just mark the day'}
                  </Button>
                </div>
                <div className="flex justify-end">
                  <Button loading={save.isPending} disabled={!ok} onClick={() => save.mutate()}>
                    Save
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

/** The person's month: one cell per day, the picked day ringed, the figures so far on top. */
function MonthCalendar({ ym, data, loading, date, today, onPick }) {
  const days = data?.month === ym ? data.days : [];
  const lead = days.length ? new Date(`${days[0].date}T00:00:00Z`).getUTCDay() : 0;
  const sofar = days.filter((x) => (!today || x.date <= today) && x.status !== 'NOT_JOINED' && x.status !== 'EXITED');
  const paid = Math.round(sofar.reduce((a, x) => a + x.day_value, 0) * 100) / 100;
  const late = sofar.filter((x) => x.late_min > 0).length;
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">{monthName(ym)}</span>
        {days.length > 0 && (
          <span className="text-[12px] text-muted-foreground num">
            Paid {paid} · LOP {Math.round((sofar.length - paid) * 100) / 100} · Late {late}
          </span>
        )}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {WEEK.map((w, i) => (
          <span key={i} className="text-center text-[11px] text-muted-foreground">
            {w}
          </span>
        ))}
        {loading && !days.length
          ? Array.from({ length: 35 }).map((_, i) => <span key={i} className="h-[52px] animate-pulse rounded-md bg-muted" />)
          : null}
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
              title={`${fullDate(x.date)}: ${DAY_STATUS_LABELS[x.status] ?? ''}${x.overridden ? ' (corrected)' : ''}`}
              className={cn('relative flex h-[52px] flex-col items-start rounded-md px-1.5 py-1 text-left text-[11px] leading-tight transition-shadow disabled:opacity-40', on && 'ring-2 ring-primary')}
              style={future ? CELL_STYLE.none : CELL_STYLE[cell.tone]}
            >
              <b className="text-[12px] num">{Number(x.date.slice(8))}</b>
              {!future && <span className="truncate">{cell.label}</span>}
              {x.overridden && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />}
            </button>
          );
        })}
      </div>
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
      if (pu.direction === 'IN') open = { from: m, site: pu.site.name };
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
        <span className="absolute inset-y-0 border-x border-dashed border-muted-foreground/40" style={{ left: pos(startShift), width: `calc(${pos(endShift)} - ${pos(startShift)})` }} />
        {bars.map((b, i) => (
          <span
            key={i}
            title={`${b.site}: ${toHHMM(b.from)}–${b.open ? '?' : toHHMM(b.to)}`}
            className="absolute top-[9px] h-[22px] rounded-[5px]"
            style={{ left: pos(b.from), width: `calc(${pos(b.to)} - ${pos(b.from)})`, background: b.open && missing ? 'color-mix(in srgb, var(--destructive) 35%, var(--card))' : i % 2 ? 'color-mix(in srgb, var(--primary) 75%, black)' : 'var(--primary)' }}
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
  if (v.status === 'MISSING_PUNCH') lines.push('No punch-out. The system punched out at 2 AM and counts a full day with no overtime until you decide. Set the real out time if you know it.');
  else if (v.early_min) lines.push(`Left with ${mins(v.early_min)} to go — the day is short of ${mins(d.context?.standard_min ?? 540)}. Decide: count a full day, or keep ${v.status === 'HALF_DAY' ? 'the half day' : 'it as it is'}.`);
  if (v.ot_min) lines.push(`Did ${mins(v.ot_min)} overtime, counted from ${mins(d.context?.standard_min ?? 540)} after punch-in.`);
  for (const f of v.flags) if (FLAG_TEXT[f] && !(f === 'UNMATCHED_IN' && v.status === 'MISSING_PUNCH')) lines.push(FLAG_TEXT[f]);
  if (!lines.length) return null;
  const warn = v.status === 'MISSING_PUNCH' || v.early_min || v.late_min;
  return <div className={cn('rounded-md px-3 py-2.5 text-[13px]', warn ? 'bg-warning/15 text-foreground' : 'bg-muted/60 text-muted-foreground')}>{lines.join(' ')}</div>;
}
