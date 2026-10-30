import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { addMonths, isISODate, isYearMonth, istDate } from '@ajpwer/shared';
import { mins, monthLabel } from '@/utils';
import { api } from '@/services/api';
import { useSession } from '@/context/SessionContext';
import { ErrorState, PermissionDenied, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/form';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { AttendanceMonthCalendar, CorrectionDrawer } from '../../attendance/CorrectionDrawer';
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
  const { data: lk } = useLookups();
  const { can } = useSession();
  const [sp, setSp] = useSearchParams();
  const today = lk?.today ?? istDate(new Date());
  const day = isISODate(sp.get('day')) && sp.get('day') <= today ? sp.get('day') : null;
  const requestedMonth = sp.get('month');
  const month = isYearMonth(requestedMonth) && requestedMonth <= today.slice(0, 7) ? requestedMonth : day?.slice(0, 7) ?? today.slice(0, 7);
  const setDay = (next) => setSp((prev) => {
    const params = new URLSearchParams(prev);
    next ? params.set('day', next) : params.delete('day');
    return params;
  }, { replace: true });
  const setMonth = (next) => {
    if (!isYearMonth(next) || next > today.slice(0, 7)) return;
    setSp((prev) => {
      const params = new URLSearchParams(prev);
      params.set('month', next);
      params.delete('day');
      return params;
    }, { replace: true });
  };
  const q = useQuery({
    queryKey: ['emp-attendance', e.id, month],
    queryFn: () => api.get(`/employees/${e.id}/attendance`, { month }).then((r) => r.data),
    enabled: can('attendance.read'),
    placeholderData: keepPreviousData,
  });
  const data = !q.isPlaceholderData && q.data?.month === month ? q.data : null;
  const summary = data?.attendance_summary;
  const completedDays = data?.days?.filter((d) => d.date <= today) ?? [];
  const stats = [
    ['Present days', summary?.present_days ?? completedDays.reduce((n, d) => n + (d.status === 'PRESENT' ? 1 : d.status === 'HALF_DAY' ? 0.5 : 0), 0)],
    ['Absent days', summary?.absent_days ?? completedDays.filter((d) => d.status === 'ABSENT').length],
    ['Paid leave', summary ? Number(summary.paid_leave_days ?? 0) + Number(summary.auto_leave_days ?? 0) : completedDays.reduce((n, d) => n + Number(d.leave_days ?? 0), 0)],
    ['OT hours', mins(summary?.ot_min ?? completedDays.reduce((n, d) => n + Number(d.ot_min ?? 0), 0))],
  ];
  if (!can('attendance.read')) return <PermissionDenied message="Your role does not include attendance. Ask HR to grant attendance access." />;
  return (
    <>
      <Card className="max-w-3xl">
        <CardHeader title="Attendance" description={e.read_only || !can('attendance.write') ? 'Select a day to see its attendance details.' : 'Select a day to view punches or correct attendance.'}
          actions={<div className="flex items-center gap-1">
            <Button size="icon" variant="ghost" aria-label="Previous attendance month" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft /></Button>
            <Input type="month" aria-label="Attendance month" className="h-9 w-40" max={today.slice(0, 7)} value={month} onChange={(event) => setMonth(event.target.value)} />
            <Button size="icon" variant="ghost" aria-label="Next attendance month" disabled={month >= today.slice(0, 7)} onClick={() => setMonth(addMonths(month, 1))}><ChevronRight /></Button>
          </div>} />
        <CardBody className="space-y-4">
          {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} compact /> : !data ? <SkeletonBlock className="h-96" /> : <>
            <dl className="grid grid-cols-2 gap-3 border-b pb-4 sm:grid-cols-4" aria-label="Month summary">
              {stats.map(([label, value]) => <div key={label}><dt className="text-[12px] text-muted-foreground">{label}</dt><dd className="mt-1 text-lg font-semibold num">{value}</dd></div>)}
            </dl>
            <AttendanceMonthCalendar ym={month} data={data} loading={false} date={day} today={today} onPick={setDay} />
            <p className="text-[12px] text-muted-foreground">Late minutes are the total shortfall from the required shift. Arrival delay is shown in each day's details.</p>
          </>}
        </CardBody>
      </Card>
      {day && <CorrectionDrawer employeeId={e.id} date={day} open onOpenChange={(open) => !open && setDay(null)} readOnly={!!e.read_only} />}
    </>
  );
}
