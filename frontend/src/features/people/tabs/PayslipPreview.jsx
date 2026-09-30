import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addMonths } from '@ajpwer/shared';
import { api } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { monthLabel } from '@/lib/utils';
import { ErrorState, SkeletonBlock } from '@/components/states';
import { Card, CardHeader } from '@/components/ui/card';
import { Select } from '@/components/ui/form';
import { PayslipBody } from '../../payroll/PayslipBody';

/** The live engine's payslip for a month — what payroll would compute now. */
export function PayslipPreview({ e }) {
  const { data: lk } = useLookups();
  const cur = lk?.today.slice(0, 7) ?? new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(cur);
  const q = useQuery({
    queryKey: ['payslip-preview', e.id, month],
    queryFn: () => api.get(`/employees/${e.id}/payslip-preview`, { month }).then((r) => r.data),
  });
  return (
    <Card>
      <CardHeader
        title="Payslip preview"
        description="Live engine, from current attendance. Locked months are read from the snapshot instead."
        actions={
          <Select className="h-7 w-44" value={month} onChange={(ev) => setMonth(ev.target.value)} aria-label="Month">
            {[0, -1, -2, -3].map((k) => {
              const m = addMonths(cur, k);
              return (
                <option key={m} value={m}>
                  {monthLabel(m)}
                </option>
              );
            })}
          </Select>
        }
      />

      <div className="p-3">
        {q.isLoading ? (
          <SkeletonBlock className="h-64" />
        ) : q.isError ? (
          <ErrorState error={q.error} compact onRetry={() => q.refetch()} />
        ) : (
          <PayslipBody
            compact
            lines={q.data.result.lines}
            totals={{
              gross: q.data.result.gross,
              salary_gross: q.data.result.salary_gross,
              total_deductions: q.data.result.total_deductions,
              reimbursements: q.data.result.reimbursements,
              net: q.data.result.net,
              employer_total: q.data.result.employer_total,
            }}
            basis={{ paid_days: q.data.result.paid_days, lop_days: q.data.result.lop_days, divisor: q.data.result.divisor, rule: q.data.result.lop_rule_text }}
          />
        )}
      </div>
    </Card>
  );
}
