import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addMonths, OT_BASE_LABELS, type OtBase } from '@ajpwer/shared';
import { api } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { mins, monthLabel } from '@/lib/utils';
import { Money, PageHeader, PersonLink, Stat } from '@/components/bits';
import { DataTable, type Col } from '@/components/data-table';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/form';

interface Row {
  employee: { id: string; code: string; name: string; department: { name: string } };
  ot_min: number;
  paid_min: number;
  excess_min: number;
  hourly: number;
  multiplier: number | null;
  base: OtBase | null;
  policy: { name: string; version: number } | null;
  amount: number;
  offday_days: number;
  offday_amount: number;
  over_cap: boolean;
}

export default function Overtime() {
  const { data: lk } = useLookups();
  const cur = lk?.today.slice(0, 7) ?? new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(cur);
  const q = useQuery({ queryKey: ['overtime', month], queryFn: () => api.get<{ data: Row[] }>('/overtime', { month }).then((r) => r.data) });
  const rows = q.data ?? [];
  const cols: Col<Row>[] = [
    { id: 'name', header: 'Name', sticky: true, width: 200, cell: (r) => <PersonLink id={r.employee.id} name={r.employee.name} code={r.employee.code} tab="attendance" /> },
    { id: 'dept', header: 'Department', cell: (r) => r.employee.department.name },
    { id: 'hours', header: 'Hours', align: 'right', cell: (r) => mins(r.ot_min) },
    { id: 'rate', header: 'Hourly rate', align: 'right', cell: (r) => (r.hourly ? <Money value={r.hourly} paise /> : '—') },
    { id: 'mult', header: 'Multiplier and base', cell: (r) => (r.multiplier ? `${r.multiplier}× on ${OT_BASE_LABELS[r.base!]}` : <span className="text-muted-foreground">No overtime policy</span>) },
    { id: 'pol', header: 'Policy', cell: (r) => (r.policy ? `${r.policy.name} v${r.policy.version}` : '—') },
    { id: 'amt', header: 'Overtime pay', align: 'right', cell: (r) => <Money value={r.amount} /> },
    { id: 'off', header: 'Off-day work', align: 'right', cell: (r) => (r.offday_days ? <>{r.offday_days} d · <Money value={r.offday_amount} /></> : '—') },
    { id: 'cap', header: '', cell: (r) => (r.over_cap ? <Chip tone="warning" title="Minutes above the monthly cap are unpaid and reported">{mins(r.excess_min)} over cap, unpaid</Chip> : null) },
  ];
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Overtime"
        description="Who earned what, and why. Hours on holidays and weekly offs are paid by the off-day work policy, never as overtime too."
        meta={
          <Select className="w-44" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
            {[0, -1, -2, -3, -4, -5].map((k) => {
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
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="People" value={rows.length} />
        <Stat label="Overtime hours" value={mins(rows.reduce((a, r) => a + r.ot_min, 0))} />
        <Stat label="Overtime pay" value={<Money value={rows.reduce((a, r) => a + r.amount, 0)} />} />
        <Stat label="Over the cap" value={rows.filter((r) => r.over_cap).length} tone={rows.some((r) => r.over_cap) ? 'warning' : undefined} />
      </div>
      <Card>
        {q.isLoading ? (
          <SkeletonRows rows={8} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : !rows.length ? (
          <EmptyState title="No overtime this month" body="Overtime appears here once someone works past their standard day under an overtime policy." />
        ) : (
          <DataTable columns={cols} rows={rows} rowId={(r) => r.employee.id} maxHeight="65vh" />
        )}
      </Card>
    </div>
  );
}
