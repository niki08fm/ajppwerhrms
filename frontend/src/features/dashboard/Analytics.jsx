import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { api } from '@/lib/api';
import { monthLabel } from '@/lib/utils';
import { PageHeader } from '@/components/bits';
import { axis, CHART, grid, QueryCard, rupeesShort, tooltipStyle } from '@/components/charts';

const short = (ym) => monthLabel(ym).slice(0, 3) + ' ' + ym.slice(2, 4);

export default function Analytics() {
  const q = useQuery({ queryKey: ['analytics'], queryFn: () => api.get('/analytics').then((r) => r.data) });
  const empty = <p className="py-10 text-center text-[13px] text-muted-foreground">No payroll months have been run yet.</p>;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Analytics" description="Trends across months, from payroll snapshots and cached daily aggregates." />
      <div className="grid gap-4 lg:grid-cols-2">
        <QueryCard title="Attendance rate, 60 days" query={q}>
          {(d) => (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={d.attendance_rate} margin={{ left: -18, right: 8 }}>
                <CartesianGrid {...grid} />
                <XAxis dataKey="date" {...axis} tickFormatter={(v) => v.slice(5)} interval={9} />
                <YAxis {...axis} domain={[0, 100]} unit="%" />
                <Tooltip {...tooltipStyle} formatter={(v) => [`${v}%`, 'Present']} />
                <Line dataKey="rate" stroke={CHART[0]} strokeWidth={2} dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          )}
        </QueryCard>
        <QueryCard title="Gross, net and cost to company" query={q}>
          {(d) =>
            d.months.length ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={d.months} margin={{ left: -4, right: 8 }}>
                  <CartesianGrid {...grid} />
                  <XAxis dataKey="period_ym" {...axis} tickFormatter={short} />
                  <YAxis {...axis} tickFormatter={rupeesShort} />
                  <Tooltip {...tooltipStyle} formatter={(v) => rupeesShort(v)} labelFormatter={monthLabel} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="gross" name="Gross" fill={CHART[0]} radius={[2, 2, 0, 0]} />
                  <Bar dataKey="net" name="Net" fill={CHART[2]} radius={[2, 2, 0, 0]} />
                  <Bar dataKey="ctc" name="Cost to company" fill={CHART[1]} radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              empty
            )
          }
        </QueryCard>
        <QueryCard title="Overtime, lateness and loss of pay" query={q}>
          {(d) =>
            d.months.length ? (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={d.months} margin={{ left: -18, right: 8 }}>
                  <CartesianGrid {...grid} />
                  <XAxis dataKey="period_ym" {...axis} tickFormatter={short} />
                  <YAxis {...axis} />
                  <Tooltip {...tooltipStyle} labelFormatter={monthLabel} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line dataKey="ot_hours" name="Overtime hours" stroke={CHART[0]} strokeWidth={2} />
                  <Line dataKey="late_days" name="Late days" stroke={CHART[1]} strokeWidth={2} />
                  <Line dataKey="lop_days" name="LOP days" stroke={CHART[3]} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              empty
            )
          }
        </QueryCard>
        <QueryCard title="Paid days against lateness" description={q.data?.scatter_period ? `One dot per person, ${monthLabel(q.data.scatter_period)}` : undefined} query={q}>
          {(d) =>
            d.scatter.length ? (
              <ResponsiveContainer width="100%" height={220}>
                <ScatterChart margin={{ left: -18, right: 8 }}>
                  <CartesianGrid {...grid} vertical />
                  <XAxis type="number" dataKey="late_days" name="Late days" {...axis} allowDecimals={false} />
                  <YAxis type="number" dataKey="paid_days" name="Paid days" {...axis} />
                  <ZAxis range={[40, 40]} />
                  <Tooltip {...tooltipStyle} />
                  <Scatter data={d.scatter} fill={CHART[0]} fillOpacity={0.6} />
                </ScatterChart>
              </ResponsiveContainer>
            ) : (
              empty
            )
          }
        </QueryCard>
        <QueryCard title="Income tax by regime" query={q} className="lg:col-span-2">
          {(d) =>
            d.months.length ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={d.months} margin={{ left: -4, right: 8 }}>
                  <CartesianGrid {...grid} />
                  <XAxis dataKey="period_ym" {...axis} tickFormatter={short} />
                  <YAxis {...axis} tickFormatter={rupeesShort} />
                  <Tooltip {...tooltipStyle} formatter={(v) => rupeesShort(v)} labelFormatter={monthLabel} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="tax_new" name="New regime" stackId="t" fill={CHART[0]} />
                  <Bar dataKey="tax_old" name="Old regime" stackId="t" fill={CHART[4]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              empty
            )
          }
        </QueryCard>
      </div>
    </div>
  );
}
