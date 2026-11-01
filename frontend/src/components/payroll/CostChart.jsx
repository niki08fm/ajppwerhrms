import { Bar, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts';
import { inr, monthLabel } from '@/utils';
import { tooltipStyle } from '@/components/charts';

export function PayrollCostChart({ bars }) {
  const rows = bars.map(({ m, t }) => ({ month: monthLabel(m).slice(0, 3), period: monthLabel(m), ...(t ? { net: t.net, deductions: t.deductions, employer: t.employer, people: t.headcount } : {}) }));
  return <figure className="relative" aria-label="Six months of payroll cost and employee count">
    <div className="payroll-cost-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 15, left: 5, right: 0, bottom: 5 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }} tickLine={false} axisLine={false} />
          <YAxis yAxisId="cost" width={55} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} tickFormatter={v => `${(v / 100 / 1e5).toFixed(0)}L`} tickLine={false} axisLine={false} />
          <YAxis yAxisId="people" orientation="right" width={35} allowDecimals={false} domain={[0, value => Math.max(5, Math.ceil(value * 1.2))]} tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} tickLine={false} axisLine={false} />
          <Tooltip {...tooltipStyle} labelFormatter={(_, payload) => payload?.[0]?.payload.period ?? ''} formatter={(value, name) => [name === 'Employee count' ? value : inr(value), name]} />
          <Bar yAxisId="cost" dataKey="net" name="Net pay" stackId="cost" fill="var(--chart-1)" maxBarSize={64} />
          <Bar yAxisId="cost" dataKey="deductions" name="Employee deductions" stackId="cost" fill="var(--chart-2)" maxBarSize={64} />
          <Bar yAxisId="cost" dataKey="employer" name="Company contributions" stackId="cost" fill="var(--chart-3)" radius={[6, 6, 0, 0]} maxBarSize={64} />
          <Line yAxisId="people" dataKey="people" name="Employee count" stroke="var(--chart-4)" strokeWidth={2} dot={{ r: 3, stroke: 'var(--card)', strokeWidth: 1 }} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
    <figcaption className="payroll-cost-legend">{[['Net pay', '1'], ['Employee deductions', '2'], ['Company contributions', '3'], ['Employee count', '4']].map(([label, n]) => <span key={n}><i style={{ background: `var(--chart-${n})` }} />{label}</span>)}</figcaption>
    <div className="sr-only"><table><caption>Payroll cost history; missing months have not been generated.</caption><thead><tr><th>Month</th><th>Net pay</th><th>Employee deductions</th><th>Company contributions</th><th>People</th></tr></thead><tbody>{rows.map(r => <tr key={r.period}><th>{r.period}</th><td>{r.net === undefined ? 'Not generated' : inr(r.net)}</td><td>{r.deductions === undefined ? '—' : inr(r.deductions)}</td><td>{r.employer === undefined ? '—' : inr(r.employer)}</td><td>{r.people ?? '—'}</td></tr>)}</tbody></table></div>
  </figure>;
}
