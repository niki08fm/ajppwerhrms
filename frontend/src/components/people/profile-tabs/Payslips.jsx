import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { api } from '@/services/api';
import { monthLabel } from '@/utils';
import { Money } from '@/components/bits';
import { EmptyState, ErrorState, PeriodChip, SkeletonRows } from '@/components/states';
import { Card, CardHeader } from '@/components/ui/card';

export function PayslipsTab({ e }) {
  const q = useQuery({
    queryKey: ['emp-payslips', e.id],
    queryFn: () => api.get(`/employees/${e.id}/payslips`).then((r) => r.data),
  });
  return (
    <Card>
      <CardHeader title="Payslips" description="Snapshots written by each payroll run. A locked month never moves, whatever changes afterwards." />
      {q.isLoading ? (
        <SkeletonRows rows={4} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data.length ? (
        <EmptyState title="No payslips yet" body="A payslip appears here once a payroll run that includes this person has been run." />
      ) : (
        <div className="overflow-x-auto"><table className="data-table w-full">
          <thead>
            <tr>
              <th>Month</th>
              <th>State</th>
              <th className="text-right">Paid days</th>
              <th className="text-right">LOP</th>
              <th className="text-right">Gross</th>
              <th className="text-right">Deductions</th>
              <th className="text-right">Net</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link className="hover:underline" to={`/payroll/${p.period_ym}?tab=payslips`}>
                    {monthLabel(p.period_ym)}
                  </Link>
                </td>
                <td>
                  <PeriodChip state={p.state} />
                </td>
                <td className="text-right num">{p.paid_days}</td>
                <td className="text-right num">{p.lop_days}</td>
                <td className="text-right">
                  <Money value={p.gross} />
                </td>
                <td className="text-right">
                  <Money value={p.total_deductions} />
                </td>
                <td className="text-right font-medium">
                  <Money value={p.net} />
                </td>
                <td className="text-right">
                  <Link to={`/print/payslip/${p.period_ym}/${e.id}`} target="_blank" className="inline-flex items-center gap-1 text-primary hover:underline">
                    <Printer className="size-3.5" /> Payslip
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </Card>
  );
}
