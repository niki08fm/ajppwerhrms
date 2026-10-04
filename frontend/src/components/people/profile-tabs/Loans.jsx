import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addMonths } from '@ajpwer/shared';
import { api } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { inr, longDate, monthLabel } from '@/utils';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { GrantDialog } from '../../../pages/payroll/Money';

/**
 * Advances and loans: one card each — what was given, how it is recovered, how far it has
 * got, and the deductions still to come. Recovered in payroll after statutory deductions,
 * capped so pay never goes too low; whatever is left is recovered in F&F.
 */
export function LoansTab({ e }) {
  const { data: lk } = useLookups();
  const thisMonth = (lk?.today ?? new Date().toISOString()).slice(0, 7);
  const [granting, setGranting] = useState(null);
  const q = useQuery({ queryKey: ['advances-loans', e.id], queryFn: () => api.get('/advances-loans', { q: e.code }).then((r) => r.data) });
  const rows = (q.data?.rows.filter((r) => r.employee.id === e.id) ?? []).slice().sort((a, b) => (a.status === b.status ? (a.started_on < b.started_on ? 1 : -1) : a.status === 'ACTIVE' ? -1 : 1));
  const carries = q.data?.carries.filter((c) => c.employee.id === e.id) ?? [];

  return (
    <div className="flex flex-col gap-4">
      {!e.read_only && (
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setGranting('LOAN')}>
            Give loan
          </Button>
          <Button size="sm" onClick={() => setGranting('ADVANCE')}>
            Give advance
          </Button>
        </div>
      )}
      {q.isLoading ? (
        <SkeletonRows rows={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState title="No advances or loans" body="An advance or loan given to this person appears here with its recovery plan." />
        </Card>
      ) : (
        rows.map((r) => {
          const total = r.instalment ? Math.max(1, Math.round(r.amount / r.instalment)) : 1;
          const done = Math.max(0, total - r.instalments_left);
          const pct = r.amount ? Math.min(100, Math.round((r.recovered / r.amount) * 100)) : 0;
          // The deductions still to come, month by month from this one.
          const plan = [];
          let left = r.outstanding;
          for (let i = 0; left > 0 && i < 6; i++) {
            const amt = Math.min(r.instalment, left);
            plan.push({ m: addMonths(thisMonth, i), amt });
            left -= amt;
          }
          const active = r.status === 'ACTIVE';
          return (
            <Card key={r.id} className="overflow-hidden">
              <CardHeader
                title={`${r.label || (r.type === 'LOAN' ? 'Loan' : 'Salary advance')} · given ${longDate(r.started_on)}`}
                description={`${inr(r.amount)} · ${inr(r.instalment)} a month for ${total} month${total === 1 ? '' : 's'} · recovered in payroll after statutory deductions`}
                actions={<Chip tone={active ? 'info' : 'muted'}>{active ? `${inr(r.outstanding)} left` : 'Closed'}</Chip>}
              />
              <div className="px-5 pb-4">
                <div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
                  <span className="bg-primary" style={{ width: `${pct}%` }} />
                </div>
                <div className="mt-1.5 text-[12px] text-muted-foreground">
                  {done} of {total} instalments recovered ({inr(r.recovered)})
                  {active ? ` · ${r.instalments_left} left · any balance is recovered in F&F if they leave` : ''}
                </div>
              </div>
              {active && plan.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="data-table w-full">
                    <thead>
                      <tr>
                        <th>Month</th>
                        <th className="text-right">Planned deduction</th>
                        <th>Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.map((x, i) => (
                        <tr key={x.m}>
                          <td>{monthLabel(x.m)}</td>
                          <td className="text-right num">{inr(x.amt)}</td>
                          <td className="text-[13px] text-muted-foreground">{i === 0 ? "In this month's payroll" : i === plan.length - 1 && left <= 0 ? 'Last instalment' : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          );
        })
      )}
      {carries.length > 0 && (
        <p className="text-[13px] text-muted-foreground">
          Held back by the recovery cap and carried forward:{' '}
          {carries.map((c) => (
            <span key={c.id}>
              {inr(c.amount)} into {monthLabel(c.period_ym)}{' '}
            </span>
          ))}
        </p>
      )}
      {granting && <GrantDialog type={granting} employee={{ id: e.id, name: e.name }} onClose={() => setGranting(null)} />}
    </div>
  );
}
