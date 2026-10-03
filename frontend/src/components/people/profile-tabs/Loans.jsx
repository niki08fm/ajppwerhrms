import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '@/services/api';
import { Money } from '@/components/bits';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { GrantDialog } from '../../../pages/payroll/Money';

export function LoansTab({ e }) {
  const [granting, setGranting] = useState(null);
  const q = useQuery({
    queryKey: ['advances-loans', e.id],
    queryFn: () => api.get('/advances-loans', { q: e.code }).then((r) => r.data),
  });
  const rows = q.data?.rows.filter((r) => r.employee.id === e.id) ?? [];
  const carries = q.data?.carries.filter((c) => c.employee.id === e.id) ?? [];
  return (
    <Card>
      <CardHeader
        title="Advances and loans"
        description="Recovered through payroll, capped at 40% of gross minus statutory; the excess carries into next month. At settlement the full balance is due."
        actions={
          !e.read_only && (
            <>
              <Button variant="outline" onClick={() => setGranting('ADVANCE')}>
                <Plus /> Advance
              </Button>
              <Button onClick={() => setGranting('LOAN')}>
                <Plus /> Loan
              </Button>
            </>
          )
        }
      />

      {q.isLoading ? (
        <SkeletonRows rows={3} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing lent" body="Advances and loans granted to this person appear here with their recovery schedule." />
      ) : (
        <div className="overflow-x-auto"><table className="data-table w-full">
          <thead>
            <tr>
              <th>Type</th>
              <th>Detail</th>
              <th>Started</th>
              <th className="text-right">Amount</th>
              <th className="text-right">Instalment</th>
              <th className="text-right">Recovered</th>
              <th className="text-right">Outstanding</th>
              <th className="text-right">Left</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.type === 'LOAN' ? 'Loan' : 'Advance'}</td>
                <td>{r.label}</td>
                <td className="num">{r.started_on}</td>
                <td className="text-right">
                  <Money value={r.amount} />
                </td>
                <td className="text-right">
                  <Money value={r.instalment} />
                </td>
                <td className="text-right">
                  <Money value={r.recovered} />
                </td>
                <td className="text-right font-medium">
                  <Money value={r.outstanding} />
                </td>
                <td className="text-right num">{r.instalments_left} mo.</td>
                <td>
                  <Chip tone={r.status === 'ACTIVE' ? 'info' : 'muted'}>{r.status === 'ACTIVE' ? 'Recovering' : 'Closed'}</Chip>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {carries.length > 0 && (
        <p className="border-t px-4 py-2 text-[14px]">
          Carried forward by the recovery cap:{' '}
          {carries.map((c) => (
            <span key={c.id}>
              <Money value={c.amount} /> into {c.period_ym}{' '}
            </span>
          ))}
        </p>
      )}
      {granting && <GrantDialog type={granting} employee={{ id: e.id, name: e.name }} onClose={() => setGranting(null)} />}
    </Card>
  );
}
