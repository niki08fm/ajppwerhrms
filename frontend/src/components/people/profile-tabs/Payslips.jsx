import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { cn, inr, monthLabel } from '@/utils';
import { EmptyState, ErrorState, SkeletonBlock, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Select } from '@/components/ui/form';

const STATE = { RUN: 'run, not locked', LOCKED: 'locked', PAID: 'paid' };
/** Rupees, with paise only when there are any. */
const money = (v) => inr(v, v % 100 !== 0);
const EARNED = ['COMPONENT', 'YEARLY', 'OT', 'OFFDAY', 'LEAVE', 'ADHOC', 'REIMBURSEMENT', 'HELD'];

/**
 * Payslips: the months on the left, the picked month on the right — what was earned, what
 * was deducted, what was paid, and why. Snapshots: a locked month never moves.
 */
export function PayslipsTab({ e }) {
  const { data: lk } = useLookups();
  const list = useQuery({ queryKey: ['emp-payslips', e.id], queryFn: () => api.get(`/employees/${e.id}/payslips`).then((r) => r.data) });
  const [yearPick, setYearPick] = useState(null);
  const [pick, setPick] = useState(null);
  // Follow the newest available payslip, even when payroll has not run this year.
  const all = [...(list.data ?? [])].sort((a, b) => b.period_ym.localeCompare(a.period_ym));
  const currentYear = Number((lk?.today ?? new Date().toISOString()).slice(0, 4));
  const maxYear = Number(all[0]?.period_ym.slice(0, 4) ?? currentYear);
  const minYear = Number(all.at(-1)?.period_ym.slice(0, 4) ?? currentYear);
  const year = yearPick?.employeeId === e.id ? Math.max(minYear, Math.min(maxYear, yearPick.year)) : maxYear;
  const months = all.filter((p) => Number(p.period_ym.slice(0, 4)) === year);
  const ym = pick?.employeeId === e.id && months.some((p) => p.period_ym === pick.month) ? pick.month : months[0]?.period_ym;
  const changeYear = (value) => {
    setYearPick({ employeeId: e.id, year: Number(value) });
    setPick(null);
  };
  const slip = useQuery({ queryKey: ['payslip', ym, e.id], queryFn: () => api.get(`/payroll/periods/${ym}/payslips/${e.id}`).then((r) => r.data), enabled: !!ym });

  if (list.isLoading) return <SkeletonRows rows={4} />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => list.refetch()} />;
  const s = slip.data;
  const lines = s?.lines ?? [];
  const earned = lines.filter((l) => EARNED.includes(l.kind));
  const deducted = lines.filter((l) => l.kind === 'DEDUCTION');
  const row = (l, neg) => (
    <div key={`${l.seq}-${l.code}`} className="flex justify-between gap-3 border-b border-dashed py-1.5 text-[14px] last:border-0">
      <span>{l.name}</span>
      <span className={cn('num', neg && 'text-destructive')}>
        {neg ? '−' : ''}
        {money(l.amount)}
      </span>
    </div>
  );

  return (
    <div className={cn('grid items-start gap-4', ym && 'lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)]')}>
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <div role="group" aria-label="Payslip year navigation" className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="px-2" disabled={year <= minYear} onClick={() => changeYear(year - 1)} aria-label="Previous year">
              <ChevronLeft />
            </Button>
            <Select aria-label="Payslip year" value={year} onChange={(event) => changeYear(event.target.value)} className="w-28 text-center font-semibold num">
              {Array.from({ length: maxYear - minYear + 1 }, (_, i) => maxYear - i).map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </Select>
            <Button variant="outline" size="sm" className="px-2" disabled={year >= maxYear} onClick={() => changeYear(year + 1)} aria-label="Next year">
              <ChevronRight />
            </Button>
          </div>
        </div>
        {!months.length && (
          <EmptyState
            title={all.length ? `No payslips in ${year}` : 'No payslips yet'}
            body={all.length ? 'Choose another year to view their payslips.' : 'A payslip appears here once a payroll run that includes this person has been run.'}
          />
        )}
        {months.map((p) => {
          const on = p.period_ym === ym;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setPick({ employeeId: e.id, month: p.period_ym })}
              aria-pressed={on}
              className={cn('flex w-full items-center gap-3 border-b px-4 py-3 text-left last:border-0', on ? 'bg-secondary/60 shadow-[inset_3px_0_0_var(--primary)]' : 'hover:bg-accent/40')}
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{monthLabel(p.period_ym)}</span>
                <span className="block text-[12px] text-muted-foreground">
                  {p.paid_days} paid days · {STATE[p.state] ?? p.state.toLowerCase()}
                </span>
              </span>
              <b className="num">{inr(p.net)}</b>
            </button>
          );
        })}
      </Card>

      {ym && (
        <Card className="overflow-hidden">
          {slip.isError ? (
            <ErrorState error={slip.error} onRetry={() => slip.refetch()} />
          ) : slip.isLoading || !s ? (
            <SkeletonBlock className="m-4 h-72" />
          ) : (
            <>
              <CardHeader
                title={`${monthLabel(ym)} payslip`}
                description={`Why this amount: ${s.divisor}-day month, ${s.paid_days} paid days${s.lop_days ? `, ${s.lop_days} loss of pay` : ''}.`}
                actions={
                  <Button variant="outline" size="sm" onClick={() => window.open(`/print/payslip/${ym}/${e.id}`, '_blank')}>
                    Download PDF
                  </Button>
                }
              />
              <div className="grid sm:grid-cols-2">
                <div className="border-b px-5 py-3 sm:border-r sm:border-b-0">
                  <div className="mb-1 text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">Earned</div>
                  {earned.length ? earned.map((l) => row(l, false)) : <p className="text-[13px] text-muted-foreground">Nothing</p>}
                </div>
                <div className="px-5 py-3">
                  <div className="mb-1 text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">Deducted</div>
                  {deducted.length ? deducted.map((l) => row(l, true)) : <p className="text-[13px] text-muted-foreground">Nothing</p>}
                </div>
              </div>
              <div className="flex items-center justify-between bg-success/10 px-5 py-3.5">
                <span className="font-semibold">Net paid</span>
                <span className="text-xl font-semibold num">{money(s.net)}</span>
              </div>
              <p className="m-0 px-5 py-3 text-[13px] text-muted-foreground">
                {[s.meta?.lop_rule_text, s.meta?.held ? 'Salary on hold: calculated for this month and paid when it is released.' : null, s.period.state === 'RUN' ? 'This month is run but not locked; the payslip can still change on a rerun.' : null].filter(Boolean).join(' ')}
              </p>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
