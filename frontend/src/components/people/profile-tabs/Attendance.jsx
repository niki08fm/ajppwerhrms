import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { addMonths, DAY_STATUS_LABELS } from '@ajpwer/shared';
import { api, errorMessage } from '@/services/api';
import { cn, hhmm, mins, monthLabel } from '@/utils';
import { DayChip, ErrorState, SkeletonBlock } from '@/components/states';
import { Input } from '@/components/ui/form';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { CorrectionDrawer } from '../../attendance/CorrectionDrawer';
import { CELL_STYLE, cellOf, fullDate } from '../../attendance/dayVocab';
import { useLookups } from '@/hooks/useLookups';

const num = (x) => (x ? String(x) : '—');

/** The month's leave, type by type: what it opened with, what came in, what was taken, what is left. */
export function LeaveMonth({ leave, month }) {
  const auto = leave.types.find((t) => t.auto_apply);
  return (
    <Card>
      <CardHeader
        title="Leave this month"
        description={`Leave year ${monthLabel(leave.year.start)} to ${monthLabel(leave.year.end)}.${auto ? ` Absences nobody applied for, and the missing half of half days, are paid from ${auto.name.toLowerCase()} while it lasts.` : ''}`}
      />
      <div className="overflow-x-auto">
        <table className="data-table w-full">
          <thead>
            <tr>
              <th>Type</th>
              <th className="text-right">Start of {monthLabel(month).split(' ')[0]}</th>
              <th className="text-right">Earned</th>
              <th className="text-right">Added by HR</th>
              <th className="text-right">Taken</th>
              <th className="text-right">Automatic</th>
              <th className="text-right">Left</th>
              <th className="text-right">Year end</th>
            </tr>
          </thead>
          <tbody>
            {leave.types.map((t) => (
              <tr key={t.code}>
                <td>
                  {t.name} <span className="text-muted-foreground">{t.code}</span>
                </td>
                <td className="text-right num">{t.opening === null ? '—' : t.opening}</td>
                <td className="text-right num">{num(t.earned)}</td>
                <td className="text-right num">{num(t.adjusted)}</td>
                <td className="text-right num">
                  {num(t.used)}
                  {t.unpaid ? <span className="text-destructive"> (+{t.unpaid} unpaid)</span> : ''}
                </td>
                <td className="text-right num">{num(t.auto)}</td>
                <td className="text-right num font-medium">{t.closing === null ? '—' : t.closing}</td>
                <td className="text-right text-muted-foreground">
                  {[t.carried && `${t.carried} carried`, t.encashed && `${t.encashed} paid out`, t.lapsed && `${t.lapsed} lapsed`].filter(Boolean).join(', ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function AttendanceTab({ e }) {
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const today = lk?.today ?? new Date().toISOString().slice(0, 10);
  // Until the server's date arrives, follow it rather than the browser's: null means "today's month".
  const [monthPick, setMonth] = useState(null);
  const [dayPick, setPicked] = useState(null);
  const month = monthPick ?? today.slice(0, 7);
  const picked = dayPick ?? today;
  const [open, setOpen] = useState(null);
  const [reason, setReason] = useState('');
  const q = useQuery({
    queryKey: ['emp-attendance', e.id, month],
    queryFn: () => api.get(`/employees/${e.id}/attendance`, { month }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const siteName = (id) => q.data?.sites.find((s) => s.id === id)?.name ?? id;
  const days = q.data?.month === month ? q.data.days : [];
  const lead = days.length ? new Date(`${days[0].date}T00:00:00Z`).getUTCDay() : 0;
  const day = days.find((d) => d.date === picked) ?? days.filter((d) => d.date <= today).at(-1) ?? days[0];
  const sofar = days.filter((d) => d.date <= today && d.status !== 'NOT_JOINED' && d.status !== 'EXITED');
  const count = (s) => sofar.filter((d) => d.status === s).length;
  const sum = (k, pred = () => true) => sofar.filter(pred).reduce((a, d) => a + (d[k] ?? 0), 0);
  const late = sofar.filter((d) => d.late_min > 0);
  const short = sofar.filter((d) => d.early_min > 0);
  const mark = useMutation({
    mutationFn: (status) => api.post('/attendance/overrides', { mode: 'MARK', employee_id: e.id, work_date: day.date, status, ot_min: 0, reason_text: reason.trim() }),
    onSuccess: (_r, status) => {
      toast.success(`${fullDate(day.date)} now counts as ${status === 'PRESENT' ? 'a full day' : status === 'HALF_DAY' ? 'a half day' : 'absent'}. The punches are kept as they were.`);
      setReason('');
      for (const key of [['emp-attendance'], ['register'], ['attendance-month'], ['approvals'], ['emp-leave']]) qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const future = day && day.date > today;
  const pos = (m) => `${Math.min(100, Math.max(0, ((m - 360) / 960) * 100))}%`;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card>
          <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="px-2" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month">
                <ChevronLeft />
              </Button>
              <span className="min-w-36 text-center font-semibold">{monthLabel(month)}</span>
              <Button variant="outline" size="sm" className="px-2" disabled={month >= today.slice(0, 7)} onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month">
                <ChevronRight />
              </Button>
            </div>
            <span className="text-[12px] text-muted-foreground">Tap a day. A dot means HR corrected it.</span>
          </div>
          {q.isLoading ? (
            <SkeletonBlock className="m-3 h-80" />
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          ) : (
            <div className="grid grid-cols-7 gap-1.5 p-3">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((w) => (
                <div key={w} className="text-center text-[12px] font-medium text-muted-foreground">
                  {w}
                </div>
              ))}
              {Array.from({ length: lead }).map((_, i) => (
                <div key={`b${i}`} />
              ))}
              {days.map((d) => {
                const fut = d.date > today;
                const c = cellOf(d.status);
                return (
                  <button
                    key={d.date}
                    type="button"
                    disabled={fut}
                    onClick={() => setPicked(d.date)}
                    aria-label={`${fullDate(d.date)}: ${DAY_STATUS_LABELS[d.status]}`}
                    className={cn('relative flex min-h-[64px] flex-col items-start rounded-md p-1.5 text-left text-[12px] leading-tight disabled:opacity-40', day?.date === d.date && 'ring-2 ring-primary')}
                    style={fut ? CELL_STYLE.none : CELL_STYLE[c.tone]}
                  >
                    <b className="num">{Number(d.date.slice(8))}</b>
                    {!fut && <span className="truncate">{c.label}</span>}
                    {!fut && d.worked_min > 0 && <span className="text-[11px] opacity-80 num">{d.late_min > 0 ? 'late' : mins(d.worked_min)}</span>}
                    {d.overridden && <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary" title="Corrected by HR" />}
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          {day && (
            <Card>
              <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
                <h3 className="font-semibold">{fullDate(day.date)}</h3>
                {!future && <DayChip status={day.status} overridden={day.overridden} />}
              </div>
              <div className="flex flex-col gap-3 p-4">
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ['In', day.worked_min ? hhmm(day.first_punch_min) : '—'],
                    ['Out', day.worked_min ? hhmm(day.last_punch_min) : '—'],
                    ['Worked', day.worked_min ? mins(day.worked_min) : '—'],
                  ].map(([k, v]) => (
                    <div key={k} className="rounded-lg bg-muted/60 px-3 py-2">
                      <div className="text-[12px] text-muted-foreground">{k}</div>
                      <div className="font-semibold num">{v}</div>
                    </div>
                  ))}
                </div>
                <div className="relative h-7 rounded-md bg-muted/60">
                  {day.worked_min > 0 && <span className="absolute top-1.5 h-4 rounded bg-primary" style={{ left: pos(day.first_punch_min), width: `calc(${pos(day.last_punch_min)} - ${pos(day.first_punch_min)})` }} />}
                </div>
                <p className="m-0 text-[13px] text-muted-foreground">
                  {[
                    day.late_min > 0 && `Came in ${mins(day.late_min)} late.`,
                    day.early_min > 0 && `Left ${mins(day.early_min)} short.`,
                    day.ot_min > 0 && `Overtime ${mins(day.ot_min)}.`,
                    day.leave_days > 0 && `${day.leave_type}${day.leave_days < 1 ? ' (half)' : ''}${day.auto_leave ? ', taken automatically for an absence' : ''}.`,
                    day.sites?.length > 1 && `Sites: ${day.sites.map(siteName).join(' + ')}.`,
                    day.status === 'ABSENT' && 'No punch and no leave — loss of pay unless you change it.',
                    day.status === 'MISSING_PUNCH' && 'No punch-out: counted as a full day with no overtime until you decide.',
                    future && 'Still to come.',
                  ]
                    .filter(Boolean)
                    .join(' ') || (day.status === 'PRESENT' ? 'Inside the shift.' : DAY_STATUS_LABELS[day.status])}
                </p>
                {!future && !e.read_only && (
                  <>
                    <div className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">This day counts as</div>
                    <Input aria-label="Reason" value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="Reason (shown in the log)" />
                    <div className="flex flex-wrap gap-1.5">
                      {[
                        ['PRESENT', 'Full day'],
                        ['HALF_DAY', 'Half day'],
                        ['ABSENT', 'Absent'],
                      ].map(([s, l]) => (
                        <Button key={s} size="sm" variant={day.overridden && day.status === s ? 'default' : 'outline'} disabled={reason.trim().length < 3 || mark.isPending} loading={mark.isPending && mark.variables === s} title={reason.trim().length < 3 ? 'Write a reason first' : undefined} onClick={() => mark.mutate(s)}>
                          {l}
                        </Button>
                      ))}
                      <Button size="sm" variant="ghost" onClick={() => setOpen(day.date)}>
                        Correct times
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </Card>
          )}
          {days.length > 0 && (
            <Card>
              <CardHeader title="Month in numbers" description={month === today.slice(0, 7) ? 'So far this month' : undefined} />
              <div className="px-4 pb-3">
                {[
                  ['Paid days', `${Math.round(sum('day_value') * 100) / 100} of ${sofar.length}`],
                  ['Present', count('PRESENT')],
                  ['Half day', count('HALF_DAY')],
                  ['Absent (loss of pay)', count('ABSENT'), count('ABSENT') ? 'text-destructive' : ''],
                  ['On leave', count('ON_LEAVE')],
                  ['Late in', late.length ? `${late.length} · ${mins(late.reduce((a, d) => a + d.late_min, 0))}` : '0'],
                  ['Short days', short.length ? `${short.length} · ${mins(short.reduce((a, d) => a + d.early_min, 0))}` : '0'],
                  ['Overtime', sum('ot_min') ? mins(sum('ot_min')) : '—'],
                  ['Off days worked', count('OFF_WORKED') + count('HOLIDAY_WORKED')],
                ].map(([k, v, cls]) => (
                  <div key={k} className="flex justify-between border-b border-dashed py-1.5 text-[14px] last:border-0">
                    <span>{k}</span>
                    <b className={cn('num', cls)}>{v}</b>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
      {open && <CorrectionDrawer employeeId={e.id} date={open} open={!!open} onOpenChange={(o) => !o && setOpen(null)} />}
    </div>
  );
}
