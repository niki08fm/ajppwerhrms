import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import { cn, inr, monthLabel } from '@/utils';
import { EmptyState, ErrorState, SkeletonBlock, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';

const STATE = { RUN: 'run, not locked', LOCKED: 'locked', PAID: 'paid' };
/** Rupees, with paise only when there are any. */
const money = (v) => inr(v, v % 100 !== 0);
const EARNED = ['COMPONENT', 'YEARLY', 'OT', 'OFFDAY', 'LEAVE', 'ADHOC', 'REIMBURSEMENT', 'HELD'];

/**
 * Payslips: the months on the left, the picked month on the right — what was earned, what
 * was deducted, what was paid, and why. Snapshots: a locked month never moves.
 */
export function PayslipsTab({ e }) {
  const list = useQuery({ queryKey: ['emp-payslips', e.id], queryFn: () => api.get(`/employees/${e.id}/payslips`).then((r) => r.data) });
  const [pick, setPick] = useState(null);
  const ym = pick ?? list.data?.[0]?.period_ym;
  const slip = useQuery({ queryKey: ['payslip', ym, e.id], queryFn: () => api.get(`/payroll/periods/${ym}/payslips/${e.id}`).then((r) => r.data), enabled: !!ym });

  if (list.isLoading) return <SkeletonRows rows={4} />;
  if (list.isError) return <ErrorState error={list.error} onRetry={() => list.refetch()} />;
  if (!list.data.length)
    return (
      <Card>
        <EmptyState title="No payslips yet" body="A payslip appears here once a payroll run that includes this person has been run." />
      </Card>
    );
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
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.4fr)]">
      <Card className="overflow-hidden">
        {list.data.map((p) => {
          const on = p.period_ym === ym;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setPick(p.period_ym)}
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

      <Card className="overflow-hidden">
        {slip.isLoading || !s ? (
          <SkeletonBlock className="m-4 h-72" />
        ) : slip.isError ? (
          <ErrorState error={slip.error} onRetry={() => slip.refetch()} />
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
    </div>
  );
}
