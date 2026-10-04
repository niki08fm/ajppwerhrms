import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addMonths, DAY_STATUS_LABELS } from '@ajpwer/shared';
import { api } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { cn, dateSpan, longDate, monthLabel } from '@/utils';
import { Chip, EmptyState, ErrorState, SkeletonBlock, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/ui/overlay';
import { RecordLeave } from '../../../pages/attendance/Leave';

/** A soft colour per leave type, so each box reads at a glance. Loss of pay is always red. */
const BY_CODE = { PL: 0, EL: 0, SL: 1, CL: 2 };
const FILLS = [
  { box: 'border-primary/25 bg-primary/8', accent: 'text-primary', bar: 'bg-primary', track: 'bg-primary/15' },
  { box: 'border-info/25 bg-info/8', accent: 'text-info', bar: 'bg-info', track: 'bg-info/15' },
  { box: 'border-success/25 bg-success/8', accent: 'text-success', bar: 'bg-success', track: 'bg-success/15' },
  { box: 'border-warning/40 bg-warning/12', accent: 'text-warning-foreground dark:text-warning', bar: 'bg-warning', track: 'bg-warning/20' },
];
const fillOf = (code, i) => FILLS[BY_CODE[code] ?? i % FILLS.length];
const STATUS_TONE = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'destructive', CANCELLED: 'muted' };
const LOP_STATUSES = ['ABSENT', 'HALF_DAY', 'MISSING_PUNCH', 'SHORT', 'ON_LEAVE'];
const r2 = (n) => Math.round(n * 100) / 100;
const titleCase = (s) => s.charAt(0) + s.slice(1).toLowerCase();

/**
 * One person's leave: a coloured box per leave type with what is left, and one for the loss
 * of pay this leave year. Click a box to see that leave in a side panel — requests, credits
 * and days taken month by month. HR records leave for this person from here.
 */
export function LeaveTab({ e }) {
  const { data: lk } = useLookups();
  const today = lk?.today ?? new Date().toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);
  const [recording, setRecording] = useState(null);
  const [open, setOpen] = useState(null);
  const balances = useQuery({ queryKey: ['emp-leave', e.id], queryFn: () => api.get(`/employees/${e.id}/leave-balances`).then((r) => r.data) });
  const start = balances.data?.year?.start ?? thisMonth;
  // The months of this leave year so far, newest first (at most twelve).
  const months = [];
  for (let m = thisMonth; m >= start && months.length < 12; m = addMonths(m, -1)) months.push(m);
  const year = useQuery({
    queryKey: ['emp-attendance-year', e.id, start, thisMonth],
    queryFn: () => Promise.all(months.map((m) => api.get(`/employees/${e.id}/attendance`, { month: m }).then((r) => r.data))),
    enabled: !!balances.data,
  });

  const types = balances.data?.types ?? [];
  // Loss of pay this leave year: absences and missing halves leave did not cover, up to today.
  const lopDays = (year.data ?? [])
    .flatMap((m) => m.days)
    .filter((d) => d.date <= today && LOP_STATUSES.includes(d.status) && d.day_value < 1)
    .map((d) => ({ ...d, lop: r2(1 - d.day_value) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const lop = r2(lopDays.reduce((a, d) => a + d.lop, 0));
  const picked = open && open !== 'LOP' ? types.find((t) => t.code === open) : null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="m-0 text-[13px] text-muted-foreground">
          Leave year {monthLabel(start)} – {monthLabel(balances.data?.year?.end ?? addMonths(start, 11))}. Click a box to see its requests and month-by-month movement.
        </p>
        {!e.read_only && (
          <Button size="sm" onClick={() => setRecording({})}>
            Record leave
          </Button>
        )}
      </div>

      {balances.isLoading ? (
        <SkeletonBlock className="h-36" />
      ) : balances.isError ? (
        <ErrorState error={balances.error} onRetry={() => balances.refetch()} />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
          {types.map((t, i) => {
            const out = (t.used_ytd ?? 0) + (t.auto_ytd ?? 0);
            const pct = t.balance === null ? 0 : Math.min(100, Math.round((out / Math.max(out + t.balance, 1)) * 100));
            const f = fillOf(t.code, i);
            return (
              <button key={t.code} type="button" onClick={() => setOpen(t.code)} className={cn('flex flex-col rounded-xl border px-4 py-3.5 text-left transition hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none', f.box)}>
                <span className="flex items-center justify-between gap-2">
                  <span className={cn('text-[12px] font-semibold tracking-wide uppercase', f.accent)}>{t.name}</span>
                  {t.pending ? <span className="rounded-full bg-warning/20 px-2 py-0.5 text-[11px] font-semibold text-warning-foreground dark:text-warning">{t.pending} waiting</span> : <span className={cn('text-[12px]', f.accent)}>View ›</span>}
                </span>
                <span className="mt-1.5 text-[30px] leading-none font-semibold num">
                  {t.balance === null ? (t.paid ? 'Paid' : 'Unpaid') : t.balance}
                  {t.balance !== null && <span className="ml-1.5 text-[13px] font-normal text-muted-foreground">days left</span>}
                </span>
                {t.balance !== null && (
                  <span className={cn('mt-3 flex h-1.5 overflow-hidden rounded-full', f.track)}>
                    <span className={cn('rounded-full', f.bar)} style={{ width: `${pct}%` }} />
                  </span>
                )}
                <span className="mt-2 text-[12px] text-muted-foreground">{[t.earned_ytd ? `Earned ${t.earned_ytd}` : null, `taken ${t.used_ytd}`, t.auto_ytd ? `auto ${t.auto_ytd}` : null].filter(Boolean).join(' · ')} this year</span>
              </button>
            );
          })}
          <button type="button" onClick={() => setOpen('LOP')} className="flex flex-col rounded-xl border border-destructive/25 bg-destructive/8 px-4 py-3.5 text-left transition hover:-translate-y-0.5 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <span className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-semibold tracking-wide text-destructive uppercase">Loss of pay</span>
              <span className="text-[12px] text-destructive">View ›</span>
            </span>
            <span className="mt-1.5 text-[30px] leading-none font-semibold text-destructive num">
              {year.data ? lop : '…'}
              <span className="ml-1.5 text-[13px] font-normal text-muted-foreground">days</span>
            </span>
            <span className="mt-auto pt-3 text-[12px] text-muted-foreground">This leave year, where leave did not cover the day</span>
          </button>
        </div>
      )}

      {picked && <TypeDrawer e={e} t={picked} start={start} year={year} thisMonth={thisMonth} onRecord={() => setRecording({ leaveType: picked.code })} onClose={() => setOpen(null)} />}
      {open === 'LOP' && <LopDrawer days={lopDays} total={lop} loading={year.isLoading} onClose={() => setOpen(null)} />}
      {recording && <RecordLeave employee={{ id: e.id, name: e.name }} leaveType={recording.leaveType} onClose={() => setRecording(null)} />}
    </div>
  );
}

/** One leave type in the side panel: the numbers, every request this year, and month by month. */
function TypeDrawer({ e, t, start, year, thisMonth, onRecord, onClose }) {
  const reqs = useQuery({
    queryKey: ['leave', 'employee', e.id, 'type', t.code, start],
    queryFn: () => api.get('/leave', { 'filter[employee]': e.id, 'filter[type]': t.code, 'filter[from]': `${start}-01`, limit: 100 }).then((r) => r.data),
  });
  const rows = (year.data ?? []).map((m) => ({ month: m.month, x: m.leave?.types.find((y) => y.code === t.code) })).filter((r) => r.x && (r.x.earned || r.x.used || r.x.auto || r.x.adjusted || r.x.unpaid || r.x.closing !== null));
  const stat = (label, value, tone) => (
    <div className="rounded-lg border px-3 py-2">
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div className={cn('text-lg font-semibold num', tone)}>{value}</div>
    </div>
  );
  return (
    <Drawer
      open
      onOpenChange={(v) => !v && onClose()}
      title={t.name}
      description={`${e.name} · ${t.balance === null ? (t.paid ? 'paid, no balance kept' : 'unpaid, no balance kept') : `${t.balance} days left`}`}
      footer={
        !e.read_only && (
          <Button size="sm" onClick={onRecord}>
            Record {t.name.toLowerCase()}
          </Button>
        )
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stat('Left', t.balance ?? '—')}
        {stat('Earned this year', t.earned_ytd ?? 0, 'text-success')}
        {stat('Taken', t.used_ytd ?? 0, 'text-destructive')}
        {stat('Auto-covered', t.auto_ytd ?? 0, t.auto_ytd ? 'text-destructive' : '')}
      </div>

      <h4 className="mt-5 mb-2 text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">Requests this leave year</h4>
      {reqs.isLoading ? (
        <SkeletonRows rows={3} />
      ) : reqs.isError ? (
        <ErrorState error={reqs.error} onRetry={() => reqs.refetch()} />
      ) : !reqs.data?.length ? (
        <p className="m-0 text-[13px] text-muted-foreground">No {t.name.toLowerCase()} requested this leave year.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {reqs.data.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2.5 text-[14px]">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  {dateSpan(r.from_date, r.to_date)} · {r.days} day{r.days === 1 ? '' : 's'}
                </span>
                {r.reason && <span className="block truncate text-[12px] text-muted-foreground">{r.reason}</span>}
              </span>
              <Chip tone={STATUS_TONE[r.status]}>{r.status === 'PENDING' ? 'Waiting' : titleCase(r.status)}</Chip>
            </li>
          ))}
        </ul>
      )}

      <h4 className="mt-5 mb-2 text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">Month by month</h4>
      {year.isLoading ? (
        <SkeletonRows rows={4} />
      ) : !rows.length ? (
        <EmptyState title="No movement yet" body="Credits and days taken appear here once a month has them." />
      ) : (
        <table className="data-table w-full">
          <thead>
            <tr>
              <th>Month</th>
              <th className="text-right">In</th>
              <th className="text-right">Out</th>
              <th className="text-right">Left</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ month, x }) => {
              const inn = (x.earned || 0) + Math.max(0, x.adjusted || 0);
              const out = (x.used || 0) + (x.auto || 0) + Math.max(0, -(x.adjusted || 0));
              return (
                <tr key={month}>
                  <td>
                    {monthLabel(month)}
                    {month === thisMonth && <span className="text-[12px] text-muted-foreground"> · so far</span>}
                    {x.unpaid ? <span className="block text-[12px] text-destructive">{x.unpaid} day(s) not covered — loss of pay</span> : null}
                    {x.auto ? <span className="block text-[12px] text-muted-foreground">{x.auto} auto-covered absence or missing half</span> : null}
                  </td>
                  <td className="text-right text-success num">{inn ? `+${r2(inn)}` : '—'}</td>
                  <td className="text-right text-destructive num">{out ? `−${r2(out)}` : '—'}</td>
                  <td className="text-right font-medium num">{x.closing ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Drawer>
  );
}

/** Loss of pay in the side panel: every day this leave year that leave did not cover. */
function LopDrawer({ days, total, loading, onClose }) {
  const byMonth = [];
  for (const d of days) {
    const m = d.date.slice(0, 7);
    if (byMonth.at(-1)?.month !== m) byMonth.push({ month: m, days: [] });
    byMonth.at(-1).days.push(d);
  }
  return (
    <Drawer open onOpenChange={(v) => !v && onClose()} title="Loss of pay" description={`${total} day${total === 1 ? '' : 's'} this leave year, where leave was used up, capped or not applied.`}>
      {loading ? (
        <SkeletonRows rows={5} />
      ) : !days.length ? (
        <EmptyState title="No loss of pay" body="Every day this leave year was worked or covered." />
      ) : (
        <div className="flex flex-col gap-4">
          {byMonth.map((g) => (
            <div key={g.month}>
              <div className="mb-1.5 flex justify-between text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">
                <span>{monthLabel(g.month)}</span>
                <span className="text-destructive num">{r2(g.days.reduce((a, d) => a + d.lop, 0))} days</span>
              </div>
              <ul className="divide-y rounded-lg border">
                {g.days.map((d) => (
                  <li key={d.date} className="flex items-center justify-between gap-3 px-3 py-2 text-[14px]">
                    <span>{longDate(d.date)}</span>
                    <span className="flex items-center gap-3">
                      <span className="text-[13px] text-muted-foreground">{DAY_STATUS_LABELS[d.status] ?? d.status}</span>
                      <b className="w-10 text-right text-destructive num">{d.lop}</b>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Drawer>
  );
}
