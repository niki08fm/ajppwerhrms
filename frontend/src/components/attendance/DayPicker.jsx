import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as Pop from '@radix-ui/react-popover';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import { addDays } from '@ajpwer/shared';
import { api } from '@/services/api';
import { cn } from '@/utils';
import { monthName, shortDate, weekday } from './dayVocab';

const ymOf = (iso) => iso.slice(0, 7);
const shiftMonth = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** The month for the calendar: each day's share of staff who came in. Shared by Today and Attendance. */
export function useMonth(ym) {
  return useQuery({ queryKey: ['dashboard', 'month', ym], queryFn: () => api.get('/dashboard/month', { ym }).then((r) => r.data), enabled: !!ym, staleTime: 60_000 });
}

/**
 * Pick a day: the last three days as one tap each, and a calendar for any other day.
 * Under each date the calendar shows the % who came in; Sundays/weekly offs and holidays
 * are grey, and days under 85% are amber.
 */
export function DayPicker({ date, today, onChange }) {
  const [open, setOpen] = useState(false);
  const [ym, setYm] = useState(ymOf(date));
  const month = useMonth(open ? ym : null);
  const quick = [addDays(today, -2), addDays(today, -1), today];
  const label = (d) => (d === today ? 'Today' : d === addDays(today, -1) ? 'Yesterday' : `${weekday(d).slice(0, 3)} ${Number(d.slice(8))}`);
  const picked = !quick.includes(date);
  const pick = (d) => {
    onChange(d);
    setOpen(false);
  };

  const days = month.data?.days ?? [];
  const lead = days.length ? new Date(`${days[0].date}T00:00:00Z`).getUTCDay() : 0;

  return (
    <div className="flex items-center gap-1.5">
      <div role="radiogroup" aria-label="Day" className="inline-flex rounded-md border bg-muted p-0.5">
        {quick.map((d) => (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={date === d}
            onClick={() => onChange(d)}
            className={cn('rounded-[5px] px-3 py-1.5 text-sm font-medium transition-colors', date === d ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
          >
            {label(d)}
          </button>
        ))}
      </div>
      <Pop.Root
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) setYm(ymOf(date));
        }}
      >
        <Pop.Trigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium shadow-xs transition-colors hover:border-primary/40',
              picked || open ? 'border-primary bg-secondary text-secondary-foreground' : 'bg-card',
            )}
          >
            <CalendarDays className="size-4" />
            {picked ? shortDate(date) : 'Pick a day'}
          </button>
        </Pop.Trigger>
        <Pop.Portal>
          <Pop.Content align="start" sideOffset={6} className="z-50 w-[340px] rounded-lg border bg-popover p-3.5 text-popover-foreground shadow-lg">
            <div className="mb-2 flex items-center justify-between">
              <button type="button" className="rounded p-1 hover:bg-accent" aria-label="Previous month" onClick={() => setYm(shiftMonth(ym, -1))}>
                <ChevronLeft className="size-4" />
              </button>
              <span className="text-sm font-semibold">{monthName(ym)}</span>
              <button type="button" className="rounded p-1 hover:bg-accent disabled:opacity-30" aria-label="Next month" disabled={ym >= ymOf(today)} onClick={() => setYm(shiftMonth(ym, 1))}>
                <ChevronRight className="size-4" />
              </button>
            </div>
            <div className="grid grid-cols-7 gap-1 text-center text-[12px] text-muted-foreground">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                <span key={i}>{d}</span>
              ))}
            </div>
            <div className="mt-1 grid grid-cols-7 gap-1">
              {Array.from({ length: lead }).map((_, i) => (
                <span key={`b${i}`} />
              ))}
              {month.isLoading
                ? Array.from({ length: 30 }).map((_, i) => <span key={i} className="h-10 animate-pulse rounded-md bg-muted" />)
                : days.map((d) => {
                    const disabled = d.future;
                    const on = d.date === date;
                    const low = !d.off && d.rate !== null && d.rate < 85;
                    return (
                      <button
                        key={d.date}
                        type="button"
                        disabled={disabled}
                        title={`${weekday(d.date)} ${Number(d.date.slice(8))}${d.holiday ? ` · ${d.holiday}` : ''}`}
                        onClick={() => pick(d.date)}
                        className={cn(
                          'flex h-10 flex-col items-center justify-center rounded-md border text-[13px] leading-tight font-semibold transition-colors disabled:cursor-default disabled:opacity-35',
                          on ? 'border-primary bg-secondary' : d.off ? 'border-transparent bg-muted text-muted-foreground' : 'border-border bg-card hover:border-primary/50',
                        )}
                      >
                        <span className="num">{Number(d.date.slice(8))}</span>
                        <span className={cn('text-[10px] font-medium num', low ? 'text-warning-foreground dark:text-warning' : 'text-muted-foreground')}>
                          {d.holiday ? 'holiday' : d.off && d.rate === null ? 'off' : d.rate !== null ? `${Math.round(d.rate)}%` : '—'}
                        </span>
                      </button>
                    );
                  })}
            </div>
            <p className="mt-2 text-[12px] leading-snug text-muted-foreground">% who came in. Grey days are weekly offs and holidays; amber is under 85%.</p>
          </Pop.Content>
        </Pop.Portal>
      </Pop.Root>
    </div>
  );
}
