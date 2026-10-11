import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { addDays, addMonths } from '@ajpwer/shared';
import { api } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { useSession } from '@/context/SessionContext';
import { mins } from '@/utils';
import { Chip, ErrorState, PermissionDenied, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { AttendanceDayPanel, AttendanceMonthCalendar } from './CorrectionDrawer';
import { monthName } from './dayVocab';

const lastDate = (ym) => {
  const [year, month] = ym.split('-').map(Number);
  return ym + '-' + new Date(Date.UTC(year, month, 0)).getUTCDate();
};
const chooseDay = (ym, initialDay, today) => {
  const first = ym + '-01';
  const last = lastDate(ym);
  const candidate = initialDay?.slice(0, 7) === ym ? initialDay : today.slice(0, 7) === ym ? today : last;
  return candidate < first ? first : candidate > last ? last : candidate > today && today >= first ? today : candidate;
};
const daysLabel = (n) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(Number(n ?? 0));

/** Compatibility for older cached month responses; the server's attendance_summary is authoritative. */
function summaryFor(data, today) {
  if (data?.attendance_summary) return data.attendance_summary;
  const days = (data?.days ?? []).filter((day) => day.date <= today && !['NOT_JOINED', 'EXITED'].includes(day.status));
  const working = days.filter((day) => !['WEEKLY_OFF', 'HOLIDAY', 'OFF_WORKED', 'HOLIDAY_WORKED'].includes(day.status));
  const paid = days.reduce((sum, day) => sum + Number(day.day_value ?? 0), 0);
  return {
    working_days: working.length,
    present_days: working.reduce((sum, day) => sum + (day.status === 'PRESENT' ? 1 : day.status === 'HALF_DAY' ? 0.5 : 0), 0),
    absent_days: working.filter((day) => day.status === 'ABSENT').length,
    paid_leave_days: days.reduce((sum, day) => sum + Math.max(0, Number(day.leave_days ?? 0) - Number(day.auto_leave ?? 0)), 0),
    auto_leave_days: days.reduce((sum, day) => sum + Number(day.auto_leave ?? 0), 0),
    lop_days: Math.max(0, days.length - paid),
    ot_min: days.reduce((sum, day) => sum + Number(day.ot_min ?? 0), 0),
    late_minutes: days.reduce((sum, day) => sum + Number(day.shift_shortfall_min ?? 0), 0),
    missing_punch: days.filter((day) => day.status === 'MISSING_PUNCH' && !day.overridden).length,
  };
}

/**
 * The employee's month and the selected day's correction stay on the screen the user opened.
 * Parents control the month; only profiles opt into previous/next month navigation.
 */
export function EmployeeAttendanceWorkspace({ employeeId, month, initialDay, readOnly = false, onClose, onMonthChange, showMonthNavigation = false }) {
  const { can } = useSession();
  const { data: lk } = useLookups();
  const today = lk?.today ?? new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const ym = month ?? today.slice(0, 7);
  const [selection, setSelection] = useState(() => ({ employeeId, month: ym, initialDay, date: chooseDay(ym, initialDay, today) }));
  // Derive a valid selection immediately, before the effect runs, so no stale day request is issued.
  const matches = selection.employeeId === employeeId && selection.month === ym && selection.initialDay === initialDay;
  const date = matches ? selection.date : chooseDay(ym, initialDay, today);
  useEffect(() => {
    setSelection((current) =>
      current.employeeId === employeeId && current.month === ym && current.initialDay === initialDay
        ? current
        : { employeeId, month: ym, initialDay, date: chooseDay(ym, initialDay, today) },
    );
  }, [employeeId, ym, initialDay, today]);
  const pick = (nextDate) => setSelection({ employeeId, month: ym, initialDay, date: nextDate });
  const q = useQuery({
    queryKey: ['emp-attendance', employeeId, ym],
    queryFn: () => api.get('/employees/' + employeeId + '/attendance', { month: ym }).then((r) => r.data),
    enabled: !!employeeId && can('attendance.read'),
    placeholderData: keepPreviousData,
  });
  const data = !q.isPlaceholderData && q.data?.month === ym ? q.data : null;
  const summary = useMemo(() => summaryFor(data, data?.today ?? today), [data, today]);
  const monthlyDay = data?.days?.find((day) => day.date === date);
  const stats = [
    ['Present days', daysLabel(summary.present_days), 'var(--primary)'],
    ['Absent days', daysLabel(summary.absent_days), 'var(--destructive)'],
    ['Paid leave', daysLabel(Number(summary.paid_leave_days ?? 0) + Number(summary.auto_leave_days ?? 0)), 'var(--chart-2)'],
    ['Final LOP', daysLabel(summary.lop_days), 'var(--destructive)'],
    ['OT hours', mins(summary.ot_min ?? 0), 'var(--chart-3)'],
    ['Late minutes', daysLabel(summary.late_minutes ?? summary.shift_shortfall_min) + ' min', 'var(--warning)'],
  ];
  if (!can('attendance.read')) return <PermissionDenied message="Your role does not include attendance. Ask HR to grant attendance access." />;
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]" data-testid="employee-attendance-workspace">
      <Card>
        <CardHeader
          title={monthName(ym)}
          description={daysLabel(summary.working_days) + ' working days' + (ym === today.slice(0, 7) ? ' · Totals through today' : '')}
          actions={
            <>
              {summary.missing_punch > 0 && (
                <Chip tone="destructive">
                  {summary.missing_punch} missing punch{summary.missing_punch === 1 ? '' : 'es'}
                </Chip>
              )}
              {showMonthNavigation && onMonthChange && (
                <div className="flex items-center">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    aria-label="Previous attendance month"
                    onClick={() => onMonthChange(addMonths(ym, -1))}
                  >
                    <ChevronLeft />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    aria-label="Next attendance month"
                    disabled={ym >= today.slice(0, 7)}
                    onClick={() => onMonthChange(addMonths(ym, 1))}
                  >
                    <ChevronRight />
                  </Button>
                </div>
              )}
              {onClose && (
                <Button size="icon" variant="ghost" className="size-8" aria-label="Close attendance" onClick={onClose}>
                  <X />
                </Button>
              )}
            </>
          }
        />
        <CardBody className="space-y-4">
          {q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} compact />
          ) : q.isLoading || !data ? (
            <SkeletonBlock className="h-96" />
          ) : (
            <>
              <div className="grid grid-cols-3 gap-2" aria-label="Monthly attendance totals">
                {stats.map(([label, value, colour]) => (
                  <div
                    key={label}
                    className="rounded-md border px-2.5 py-2"
                    style={{
                      background: 'color-mix(in srgb, ' + colour + ' 5%, var(--card))',
                      borderColor: 'color-mix(in srgb, ' + colour + ' 20%, var(--border))',
                    }}
                    title={
                      label === 'Late minutes'
                        ? 'Total minutes short of the required shift on worked days.'
                        : label === 'Paid leave'
                          ? 'Applied ' + daysLabel(summary.paid_leave_days) + ' · Automatic ' + daysLabel(summary.auto_leave_days)
                          : undefined
                    }
                  >
                    <div className="text-[11px] text-muted-foreground">{label}</div>
                    <div className="mt-1 text-[17px] font-semibold num">{value}</div>
                  </div>
                ))}
              </div>
              <AttendanceMonthCalendar ym={ym} data={data} loading={false} date={date} today={today} onPick={pick} showSummary={false} />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Late minutes count the shortfall from the required shift. Final LOP is after applied and automatic paid leave.
              </p>
            </>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardBody>
          <AttendanceDayPanel
            employeeId={employeeId}
            date={date}
            monthlyDay={monthlyDay}
            readOnly={readOnly}
            onPreviousDay={date > ym + '-01' ? () => pick(addDays(date, -1)) : undefined}
            onNextDay={date < lastDate(ym) && date < today ? () => pick(addDays(date, 1)) : undefined}
          />
        </CardBody>
      </Card>
    </div>
  );
}
