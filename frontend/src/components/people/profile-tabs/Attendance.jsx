import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addMonths, DAY_STATUS_LABELS, DAY_STATUS_TONE, dayName } from '@ajpwer/shared';
import { api } from '@/services/api';
import { cn, hhmm, mins, monthLabel } from '@/utils';
import { Stat } from '@/components/bits';
import { ErrorState, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { CorrectionDrawer } from '../../attendance/CorrectionDrawer';
import { useLookups } from '@/hooks/useLookups';

const TONE_BG = {
  success: 'bg-success/12 border-success/30',
  warning: 'bg-warning/15 border-warning/40',
  destructive: 'bg-destructive/10 border-destructive/30',
  muted: 'bg-muted border-border',
  info: 'bg-info/10 border-info/30',
};

const num = (x) => (x ? String(x) : '—');

/** The month's leave, type by type: what it opened with, what came in, what was taken, what is left. */
function LeaveMonth({ leave, month }) {
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
  const { data: lk } = useLookups();
  const [month, setMonth] = useState(lk?.today.slice(0, 7) ?? new Date().toISOString().slice(0, 7));
  const [open, setOpen] = useState(null);
  const q = useQuery({
    queryKey: ['emp-attendance', e.id, month],
    queryFn: () => api.get(`/employees/${e.id}/attendance`, { month }).then((r) => r.data),
  });
  const siteName = (id) => q.data?.sites.find((s) => s.id === id)?.name ?? id;
  const t = q.data?.totals;
  const first = q.data?.days[0]?.date;
  const lead = first ? ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].indexOf(dayName(first)) : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month">
          ‹
        </Button>
        <span className="min-w-36 text-center font-display text-lg font-semibold">{monthLabel(month)}</span>
        <Button variant="outline" size="sm" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month">
          ›
        </Button>
      </div>
      {q.isLoading ? (
        <SkeletonBlock className="h-96" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
            <Stat label="Paid days" value={String(t.paid_days)} sub={`of ${t.days_in_month}`} />
            <Stat label="Loss of pay" value={String(t.lop_days)} sub={`${t.lop_in_window} inside employment`} tone={Number(t.lop_in_window) > 0 ? 'warning' : undefined} />
            <Stat label="Present" value={String(t.present)} sub={`${t.half_day} half days${t.leave_days ? ` · ${t.leave_days} leave` : ''}`} />
            <Stat label="Absent" value={String(t.absent)} tone={Number(t.absent) ? 'destructive' : undefined} />
            <Stat label="Late" value={String(t.late_days)} sub={`${t.early_out_days} left early · not deducted`} />
            <Stat label="Overtime" value={mins(Number(t.ot_min))} />
            <Stat label="Off days worked" value={String(t.off_days_worked)} />
          </div>
          <Card>
            <CardHeader title="Month" description="Click a day to see its punches and correct it. A dot means HR corrected the day." />
            <div className="grid grid-cols-7 gap-1.5 p-3">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                <div key={d} className="text-center text-[12px] font-medium text-muted-foreground">
                  {d}
                </div>
              ))}
              {Array.from({ length: lead }).map((_, i) => (
                <div key={`b${i}`} />
              ))}
              {q.data.days.map((d) => (
                <button
                  key={d.date}
                  onClick={() => setOpen(d.date)}
                  className={cn('flex min-h-[74px] flex-col rounded-md border p-1.5 text-left text-[12px] hover:ring-2 hover:ring-ring/40', TONE_BG[DAY_STATUS_TONE[d.status]])}
                  aria-label={`${d.date}: ${DAY_STATUS_LABELS[d.status]}`}
                >
                  <span className="flex items-center justify-between">
                    <span className="font-semibold num">{Number(d.date.slice(8))}</span>
                    {d.overridden && <span className="size-1.5 rounded-full bg-primary" title="Corrected" />}
                  </span>
                  <span className="font-medium">{DAY_STATUS_LABELS[d.status]}</span>
                  {d.worked_min > 0 && (
                    <span className="num text-muted-foreground">
                      {hhmm(d.first_punch_min)}–{hhmm(d.last_punch_min)}
                    </span>
                  )}
                  {d.worked_min > 0 && <span className="num text-muted-foreground">{mins(d.worked_min)}</span>}
                  {d.late_min > 0 && <span className="text-warning-foreground dark:text-warning">late {mins(d.late_min)}</span>}
                  {d.early_min > 0 && <span className="text-warning-foreground dark:text-warning">left {mins(d.early_min)} early</span>}
                  {d.leave_days > 0 && (
                    <span className="text-info" title={d.auto_leave ? 'Paid from leave automatically: nobody applied for it' : undefined}>
                      {d.leave_type} {d.leave_days < 1 ? '½' : ''}
                      {d.auto_leave ? ' · auto' : ''}
                    </span>
                  )}
                  {d.flags.includes('LEAVE_UNPAID') && <span className="text-destructive">{d.leave_type} unpaid</span>}
                  {d.sites.length > 1 && <span className="truncate text-info">{d.sites.map(siteName).join(' + ')}</span>}
                </button>
              ))}
            </div>
          </Card>
          {q.data.leave && <LeaveMonth leave={q.data.leave} month={month} />}
        </>
      )}
      {open && <CorrectionDrawer employeeId={e.id} date={open} open={!!open} onOpenChange={(o) => !o && setOpen(null)} />}
    </div>
  );
}
