import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { addMonths } from '@ajpwer/shared';
import { api } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { cn, mins } from '@/utils';
import { Mono, PageHeader } from '@/components/bits';
import { EmptyState, ErrorState, LockedNotice, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/form';
import { CorrectionDrawer } from './CorrectionDrawer';
import { DeptAvatar } from './DeptAvatar';
import { NumberPager } from './NumberPager';
import { CELL_STYLE, DAY_CELL, cellOf, fullDate, monthName } from './dayVocab';

/** Daily and monthly register, as tabs under the Attendance heading. */
export function AttendanceTabs({ active }) {
  const [, setSp] = useSearchParams();
  const tabs = [
    { key: 'day', label: 'Daily register', go: () => setSp(new URLSearchParams()) },
    { key: 'month', label: 'Monthly register', go: () => setSp(new URLSearchParams({ tab: 'month' })) },
  ];
  return (
    <div role="tablist" aria-label="Register" className="mb-4 flex gap-1 border-b">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          onClick={t.go}
          className={cn('-mb-px border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors', active === t.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

const LEGEND = ['PRESENT', 'HALF_DAY', 'ABSENT', 'MISSING_PUNCH', 'ON_LEAVE', 'WEEKLY_OFF'];
const LEGEND_LABEL = { PRESENT: 'Present', HALF_DAY: 'Half day', ABSENT: 'Absent', MISSING_PUNCH: 'No punch-out', ON_LEAVE: 'Leave', WEEKLY_OFF: 'Week off / holiday' };
const WD = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/**
 * One month, everyone: a cell per day, and paid days, loss of pay, late days and overtime
 * so far. Tap a name or a day to open that person's month with the day picked.
 */
export function MonthRegister() {
  const [sp, setSp] = useSearchParams();
  const { data: lk } = useLookups();
  const today = lk?.today ?? new Date().toISOString().slice(0, 10);
  const ym = sp.get('ym') ?? today.slice(0, 7);
  const dept = sp.get('dept') ?? '';
  const q = sp.get('q') ?? '';
  const page = Math.max(1, Number(sp.get('page') ?? 1));
  const limit = [20, 50, 100].includes(Number(sp.get('limit'))) ? Number(sp.get('limit')) : 20;
  const set = (patch, keepPage = false) => {
    const next = new URLSearchParams(sp);
    next.set('tab', 'month');
    for (const [k, v] of Object.entries(patch)) (v === null || v === '' || v === undefined ? next.delete(k) : next.set(k, String(v)));
    if (!keepPage && !('page' in patch)) next.delete('page');
    setSp(next, { replace: true });
  };
  const [open, setOpen] = useState(null);

  const month = useQuery({ queryKey: ['attendance-month', ym], queryFn: () => api.get('/attendance/month', { ym }).then((r) => r.data), placeholderData: keepPreviousData });
  const data = month.data;
  const needle = q.trim().toLowerCase();
  const rows = useMemo(
    () => (data?.rows ?? []).filter((r) => (!dept || r.employee.department?.id === dept) && (!needle || `${r.employee.name} ${r.employee.code}`.toLowerCase().includes(needle))),
    [data, dept, needle],
  );
  const pages = Math.max(1, Math.ceil(rows.length / limit));
  const pg = Math.min(page, pages);
  const shown = rows.slice((pg - 1) * limit, pg * limit);
  const lastDay = data ? (data.dates[data.dates.length - 1] < today ? data.dates[data.dates.length - 1] : today) : today;
  const sum = (k) => rows.reduce((a, r) => a + (r.totals[k] ?? 0), 0);

  return (
    <div>
      <PageHeader
        title="Attendance"
        description={`${monthName(ym)}. Each cell is one day as payroll will count it; tap a name or a day to open it.`}
        meta={
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="icon" onClick={() => set({ ym: addMonths(ym, -1) })} aria-label="Previous month">
              <ChevronLeft />
            </Button>
            <span className="min-w-40 text-center font-display text-lg font-semibold">{monthName(ym)}</span>
            <Button variant="outline" size="icon" onClick={() => set({ ym: addMonths(ym, 1) })} disabled={ym >= today.slice(0, 7)} aria-label="Next month">
              <ChevronRight />
            </Button>
          </div>
        }
      />
      <AttendanceTabs active="month" />

      {data?.frozen?.frozen && (
        <div className="mb-3">
          <LockedNotice title="This month's attendance is submitted">{data.frozen.reason}</LockedNotice>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <Select aria-label="Department" className="w-auto" value={dept} onChange={(e) => set({ dept: e.target.value })}>
          <option value="">All departments</option>
          {lk?.departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
        <div className="relative min-w-[200px] flex-1 sm:max-w-[300px]">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input aria-label="Search name or code" placeholder="Search name or code" className="pl-8" value={q} onChange={(e) => set({ q: e.target.value })} />
        </div>
        <span className="flex-1" />
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-muted-foreground">
          {LEGEND.map((s) => (
            <span key={s} className="inline-flex items-center gap-1">
              <span className="inline-flex size-[18px] items-center justify-center rounded text-[10px] font-semibold" style={CELL_STYLE[DAY_CELL[s].tone]}>
                {DAY_CELL[s].letter}
              </span>
              {LEGEND_LABEL[s]}
            </span>
          ))}
        </div>
      </div>

      {data && rows.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-muted-foreground">
          <span>
            <b className="text-foreground num">{rows.length}</b> people
          </span>
          <span>
            Absent days <b className="text-destructive num">{sum('absent')}</b>
          </span>
          <span>
            No punch-out <b className="text-foreground num">{sum('missing_punch')}</b>
          </span>
          <span>
            Late days <b className="text-foreground num">{sum('late_days')}</b>
          </span>
          <span>
            Overtime <b className="text-foreground num">{mins(sum('ot_min'))}</b>
          </span>
          <span>
            Corrected by HR <b className="text-foreground num">{sum('corrected')}</b>
          </span>
        </div>
      )}

      <Card className="overflow-hidden">
        {month.isLoading ? (
          <SkeletonRows rows={12} cols={8} />
        ) : month.isError ? (
          <ErrorState error={month.error} onRetry={() => month.refetch()} />
        ) : !rows.length ? (
          <EmptyState title={data?.rows.length ? 'Nobody matches' : 'Nobody was employed this month'} body={data?.rows.length ? 'Change the department or the search.' : 'People appear here from their joining date.'} />
        ) : (
          <>
            <div className="max-h-[680px] overflow-auto">
              <table className="border-separate border-spacing-[3px] text-[13px]">
                <thead>
                  <tr>
                    <th className="sticky top-0 left-0 z-20 min-w-[210px] bg-card px-2 py-1.5 text-left text-[12px] font-semibold text-muted-foreground">Employee</th>
                    {data.dates.map((d) => {
                      const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
                      return (
                        <th key={d} className={cn('sticky top-0 z-10 w-[26px] bg-card text-center text-[11px] leading-tight font-semibold', wd === 0 ? 'text-destructive/80' : 'text-muted-foreground', d === today && 'text-primary')}>
                          {Number(d.slice(8))}
                          <br />
                          {WD[wd]}
                        </th>
                      );
                    })}
                    {['Paid', 'LOP', 'Late', 'OT'].map((h) => (
                      <th key={h} className="sticky top-0 z-10 min-w-[48px] bg-card px-1 text-center text-[11px] font-semibold text-muted-foreground">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.employee.id}>
                      <td className="sticky left-0 z-10 bg-card px-2 py-0.5">
                        <button type="button" className="flex items-center gap-2 text-left hover:underline" onClick={() => setOpen({ id: r.employee.id, date: lastDay })}>
                          <DeptAvatar name={r.employee.name} token={r.employee.department?.colour} size={26} />
                          <span className="flex min-w-0 flex-col leading-tight">
                            <span className="truncate font-medium">{r.employee.name}</span>
                            <Mono className="text-[11px] text-muted-foreground">{r.employee.code}</Mono>
                          </span>
                        </button>
                      </td>
                      {r.days.map((x) => {
                        if (x.future) return <td key={x.date} className="p-0"><span className="block size-[26px] rounded-[5px]" style={CELL_STYLE.none} /></td>;
                        const cell = cellOf(x.status);
                        const note = [fullDate(x.date), cell.label, x.late_min ? `late ${mins(x.late_min)}` : '', x.early_min ? `${mins(x.early_min)} short` : '', x.ot_min ? `OT ${mins(x.ot_min)}` : '', x.overridden ? 'corrected by HR' : ''].filter(Boolean).join(' · ');
                        return (
                          <td key={x.date} className="p-0">
                            <button
                              type="button"
                              title={note}
                              aria-label={note}
                              disabled={!cell.letter && cell.tone === 'none'}
                              onClick={() => setOpen({ id: r.employee.id, date: x.date })}
                              className="relative flex size-[26px] items-center justify-center rounded-[5px] text-[10px] font-semibold transition-transform hover:scale-110 disabled:hover:scale-100"
                              style={CELL_STYLE[cell.tone]}
                            >
                              {cell.letter}
                              {x.overridden && <span className="absolute top-0.5 right-0.5 size-1 rounded-full bg-primary" />}
                            </button>
                          </td>
                        );
                      })}
                      <td className="text-center font-semibold num">{r.totals.paid}</td>
                      <td className={cn('text-center num', r.totals.lop ? 'text-destructive' : 'text-muted-foreground/60')}>{r.totals.lop || '—'}</td>
                      <td className={cn('text-center num', r.totals.late_days ? '' : 'text-muted-foreground/60')}>{r.totals.late_days || '—'}</td>
                      <td className={cn('text-center num', r.totals.ot_min ? '' : 'text-muted-foreground/60')}>{r.totals.ot_min ? mins(r.totals.ot_min) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <NumberPager page={pg} pages={pages} total={rows.length} limit={limit} onPage={(n) => set({ page: n === 1 ? null : n })} onLimit={(n) => set({ limit: n === 20 ? null : n })} hint="tap a name or a day to open it" />
          </>
        )}
      </Card>

      {open && <CorrectionDrawer employeeId={open.id} date={open.date} open onOpenChange={(o) => !o && setOpen(null)} />}
    </div>
  );
}
