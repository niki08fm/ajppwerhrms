import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addMonths, lastOfMonth } from '@ajpwer/shared';
import { api } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { cn, dateSpan } from '@/utils';
import { EmptyState, ErrorState, SkeletonBlock, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { RecordLeave } from '../../../pages/attendance/Leave';

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dShort = (iso) => `${Number(iso.slice(8))} ${SHORT_MONTHS[Number(iso.slice(5, 7)) - 1]}`;
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

/**
 * One person's leave: a card per leave type with what is left, the loss of pay this leave
 * year, and the ledger — every credit and every day taken, month by month, with the
 * balance it left. HR records leave for this person from here.
 */
export function LeaveTab({ e }) {
  const { data: lk } = useLookups();
  const today = lk?.today ?? new Date().toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);
  const [recording, setRecording] = useState(false);
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
  const pending = useQuery({ queryKey: ['leave', 'employee', e.id, 'PENDING'], queryFn: () => api.get('/leave', { 'filter[employee]': e.id, 'filter[status]': 'PENDING', limit: 50 }).then((r) => r.data) });

  const types = balances.data?.types ?? [];
  // Loss of pay this leave year: absences and missing halves leave did not cover, up to today.
  const lop = (year.data ?? []).flatMap((m) => m.days).filter((d) => d.date <= today && ['ABSENT', 'HALF_DAY', 'MISSING_PUNCH', 'SHORT', 'ON_LEAVE'].includes(d.status)).reduce((a, d) => a + Math.max(0, 1 - d.day_value), 0);

  // The ledger: for each month and each type, what came in and what went out, and the balance left.
  const ledger = [];
  for (const p of pending.data ?? []) ledger.push({ key: `p${p.id}`, d: dateSpan(p.from_date, p.to_date), t: p.leave_name ?? p.leave_type, ch: `−${p.days}`, c: 'text-warning-foreground dark:text-warning', how: 'Waiting for approval', bal: '—' });
  for (const m of year.data ?? []) {
    if (!m.leave) continue;
    const end = m.month === thisMonth ? today : lastOfMonth(m.month);
    for (const t of m.leave.types) {
      if (t.closing === null && !t.used && !t.auto) continue;
      const bal = t.closing === null ? '—' : t.closing;
      if (t.earned) ledger.push({ key: `${m.month}${t.code}e`, d: dShort(lastOfMonth(m.month)), t: t.name, ch: signed(t.earned), c: 'text-success', how: m.month === thisMonth ? 'Monthly accrual (this month)' : 'Monthly accrual', bal });
      if (t.adjusted) ledger.push({ key: `${m.month}${t.code}a`, d: dShort(end), t: t.name, ch: signed(t.adjusted), c: t.adjusted > 0 ? 'text-success' : 'text-destructive', how: 'Adjusted by HR', bal });
      if (t.used) ledger.push({ key: `${m.month}${t.code}u`, d: dShort(end), t: t.name, ch: signed(-t.used), c: 'text-destructive', how: 'Applied and approved', bal });
      if (t.auto) ledger.push({ key: `${m.month}${t.code}x`, d: dShort(end), t: t.name, ch: signed(-t.auto), c: 'text-destructive', how: 'Auto-covered absence or missing half', bal });
      if (t.unpaid) ledger.push({ key: `${m.month}${t.code}n`, d: dShort(end), t: t.name, ch: '0', c: 'text-muted-foreground', how: `${t.unpaid} day(s) not covered — loss of pay`, bal });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {balances.isLoading ? (
        <SkeletonBlock className="h-28" />
      ) : balances.isError ? (
        <ErrorState error={balances.error} onRetry={() => balances.refetch()} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {types.map((t) => (
            <Card key={t.code} className="px-4 py-3.5">
              <div className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">{t.name}</div>
              <div className="mt-1 text-[26px] leading-tight font-semibold num">
                {t.balance === null ? (t.paid ? 'Paid' : 'Unpaid') : t.balance} {t.balance !== null && <span className="text-[13px] font-normal text-muted-foreground">days left</span>}
              </div>
              <div className="text-[12px] text-muted-foreground">
                {[t.earned_ytd ? `Earned ${t.earned_ytd}` : null, `taken ${t.used_ytd}`, t.auto_ytd ? `auto-covered ${t.auto_ytd}` : null, t.pending ? `${t.pending} waiting` : null].filter(Boolean).join(' · ')} this year
              </div>
            </Card>
          ))}
          <Card className="px-4 py-3.5">
            <div className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">Loss of pay · this year</div>
            <div className={cn('mt-1 text-[26px] leading-tight font-semibold num', lop ? 'text-destructive' : '')}>
              {year.data ? Math.round(lop * 100) / 100 : '…'} <span className="text-[13px] font-normal text-muted-foreground">days</span>
            </div>
            <div className="text-[12px] text-muted-foreground">When leave was used up or capped</div>
          </Card>
        </div>
      )}

      <Card className="overflow-hidden">
        <CardHeader
          title="Leave ledger"
          actions={
            !e.read_only && (
              <Button size="sm" onClick={() => setRecording(true)}>
                Record leave
              </Button>
            )
          }
        />
        {year.isLoading || balances.isLoading ? (
          <SkeletonRows rows={5} />
        ) : year.isError ? (
          <ErrorState error={year.error} onRetry={() => year.refetch()} />
        ) : !ledger.length ? (
          <EmptyState title="No leave movement yet" body="Credits, leave taken and absences covered from leave appear here month by month." />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Change</th>
                  <th>How</th>
                  <th className="text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((r) => (
                  <tr key={r.key}>
                    <td className="num">{r.d}</td>
                    <td>{r.t}</td>
                    <td className={cn('num', r.c)}>{r.ch}</td>
                    <td className="text-[13px] text-muted-foreground">{r.how}</td>
                    <td className="text-right num">{r.bal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {recording && <RecordLeave employee={{ id: e.id, name: e.name }} onClose={() => setRecording(false)} />}
    </div>
  );
}
