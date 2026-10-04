import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addMonths } from '@ajpwer/shared';
import { api } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { cn, dateSpan } from '@/utils';
import { EmptyState, ErrorState, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { RecordLeave } from '../../../pages/attendance/Leave';

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

/**
 * One person's leave: a card per leave type with what is left, the loss of pay this leave
 * year, and a sideways month-by-month history — credits, days taken and the balance left.
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

  // History: one small card per month (newest first), each type's movement and the balance it left.
  const history = (year.data ?? [])
    .filter((m) => m.leave)
    .map((m) => ({
      month: m.month,
      rows: m.leave.types.filter((t) => t.earned || t.used || t.auto || t.adjusted || t.unpaid),
      closing: m.leave.types.filter((t) => t.closing !== null),
    }))
    .filter((m) => m.rows.length || m.closing.length);
  const pend = pending.data ?? [];

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
          title="Leave history"
          description="Month by month, newest first. Scroll sideways for earlier months."
          actions={
            !e.read_only && (
              <Button size="sm" onClick={() => setRecording(true)}>
                Record leave
              </Button>
            )
          }
        />
        {year.isLoading || balances.isLoading ? (
          <SkeletonBlock className="mx-5 mb-4 h-32" />
        ) : year.isError ? (
          <ErrorState error={year.error} onRetry={() => year.refetch()} />
        ) : !history.length && !pend.length ? (
          <EmptyState title="No leave movement yet" body="Credits, leave taken and absences covered from leave appear here month by month." />
        ) : (
          <div className="flex snap-x gap-3 overflow-x-auto px-5 pb-4">
            {pend.length > 0 && (
              <div className="w-52 shrink-0 snap-start rounded-lg border border-warning/50 bg-warning/10 px-3 py-2.5">
                <div className="text-[12px] font-semibold tracking-wide text-warning-foreground uppercase dark:text-warning">Waiting for approval</div>
                {pend.map((p) => (
                  <div key={p.id} className="mt-1.5 text-[13px]">
                    <div className="font-medium">
                      {p.leave_name ?? p.leave_type} · {p.days} day{p.days === 1 ? '' : 's'}
                    </div>
                    <div className="text-[12px] text-muted-foreground">{dateSpan(p.from_date, p.to_date)}</div>
                  </div>
                ))}
              </div>
            )}
            {history.map((m) => (
              <div key={m.month} className={cn('w-52 shrink-0 snap-start rounded-lg border px-3 py-2.5', m.month === thisMonth && 'border-primary/40 bg-primary/5')}>
                <div className="flex items-baseline justify-between">
                  <span className="font-semibold">
                    {SHORT_MONTHS[Number(m.month.slice(5, 7)) - 1]} {m.month.slice(0, 4)}
                  </span>
                  {m.month === thisMonth && <span className="text-[11px] text-muted-foreground">so far</span>}
                </div>
                {m.rows.length === 0 ? (
                  <p className="m-0 mt-1 text-[12px] text-muted-foreground">No movement</p>
                ) : (
                  m.rows.map((t) => (
                    <div key={t.code} className="mt-1.5 text-[13px]">
                      <div className="text-[12px] text-muted-foreground">{t.name}</div>
                      <div className="flex flex-wrap gap-x-2 num">
                        {t.earned ? <span className="text-success">{signed(t.earned)}</span> : null}
                        {t.adjusted ? <span className={t.adjusted > 0 ? 'text-success' : 'text-destructive'} title="Adjusted by HR">{signed(t.adjusted)} adj</span> : null}
                        {t.used ? <span className="text-destructive" title="Applied and approved">{signed(-t.used)} taken</span> : null}
                        {t.auto ? <span className="text-destructive" title="Auto-covered absence or missing half">{signed(-t.auto)} auto</span> : null}
                        {t.unpaid ? <span className="text-muted-foreground" title="Not covered — loss of pay">{t.unpaid} LOP</span> : null}
                      </div>
                    </div>
                  ))
                )}
                {m.closing.length > 0 && (
                  <div className="mt-2 border-t pt-1.5 text-[12px] text-muted-foreground">
                    Left: {m.closing.map((t) => `${t.code} ${t.closing}`).join(' · ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      {recording && <RecordLeave employee={{ id: e.id, name: e.name }} onClose={() => setRecording(false)} />}
    </div>
  );
}
