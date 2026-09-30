import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addMonths, DAY_STATUS_LABELS, DAY_STATUS_TONE, dayName, type DayStatus } from '@ajpwer/shared';
import { api } from '@/lib/api';
import { cn, hhmm, mins, monthLabel } from '@/lib/utils';
import { Stat } from '@/components/bits';
import { ErrorState, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { CorrectionDrawer } from '../../attendance/CorrectionDrawer';
import type { Employee } from '../types';
import { useLookups } from '@/lib/lookups';

interface Day {
  date: string;
  status: DayStatus;
  day_value: number;
  worked_min: number;
  late_min: number;
  ot_min: number;
  first_punch_min: number | null;
  last_punch_min: number | null;
  sites: string[];
  overridden: boolean;
  late_penalty_days: number;
  flags: string[];
}

const TONE_BG: Record<string, string> = {
  success: 'bg-success/12 border-success/30',
  warning: 'bg-warning/15 border-warning/40',
  destructive: 'bg-destructive/10 border-destructive/30',
  muted: 'bg-muted border-border',
  info: 'bg-info/10 border-info/30',
};

export function AttendanceTab({ e }: { e: Employee }) {
  const { data: lk } = useLookups();
  const [month, setMonth] = useState(lk?.today.slice(0, 7) ?? new Date().toISOString().slice(0, 7));
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['emp-attendance', e.id, month],
    queryFn: () => api.get<{ data: { totals: Record<string, number | boolean | string[]>; days: Day[]; sites: { id: string; name: string }[] } }>(`/employees/${e.id}/attendance`, { month }).then((r) => r.data),
  });
  const siteName = (id: string) => q.data?.sites.find((s) => s.id === id)?.name ?? id;
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
            <Stat label="Paid days" value={String(t!.paid_days)} sub={`of ${t!.days_in_month}`} />
            <Stat label="Loss of pay" value={String(t!.lop_days)} sub={`${t!.lop_in_window} inside employment`} tone={Number(t!.lop_in_window) > 0 ? 'warning' : undefined} />
            <Stat label="Present" value={String(t!.present)} sub={`${t!.half_day} half days`} />
            <Stat label="Absent" value={String(t!.absent)} tone={Number(t!.absent) ? 'destructive' : undefined} />
            <Stat label="Late" value={String(t!.late_days)} sub={`${t!.late_penalty_days} days charged`} />
            <Stat label="Overtime" value={mins(Number(t!.ot_min))} />
            <Stat label="Off days worked" value={String(t!.off_days_worked)} />
          </div>
          <Card>
            <CardHeader title="Month" description="Click a day to see its punches and correct it. A dot means HR corrected the day." />
            <div className="grid grid-cols-7 gap-1.5 p-3">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                <div key={d} className="text-center text-[11px] font-medium text-muted-foreground">
                  {d}
                </div>
              ))}
              {Array.from({ length: lead }).map((_, i) => (
                <div key={`b${i}`} />
              ))}
              {q.data!.days.map((d) => (
                <button
                  key={d.date}
                  onClick={() => setOpen(d.date)}
                  className={cn('flex min-h-[74px] flex-col rounded-md border p-1.5 text-left text-[11px] hover:ring-2 hover:ring-ring/40', TONE_BG[DAY_STATUS_TONE[d.status]])}
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
                  {d.late_min > 0 && <span className="text-warning-foreground dark:text-warning">late {d.late_min}m</span>}
                  {d.sites.length > 1 && <span className="truncate text-info">{d.sites.map(siteName).join(' + ')}</span>}
                </button>
              ))}
            </div>
          </Card>
        </>
      )}
      {open && <CorrectionDrawer employeeId={e.id} date={open} open={!!open} onOpenChange={(o) => !o && setOpen(null)} />}
    </div>
  );
}
