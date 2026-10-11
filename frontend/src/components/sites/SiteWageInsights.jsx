import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Money, Stat } from '@/components/bits';
import { axis, CHART, grid, rupeesShort, tooltipStyle } from '@/components/charts';
import { Chip, EmptyState } from '@/components/states';
import { Card, CardHeader } from '@/components/ui/card';
import { Segmented } from '@/components/ui/form';
import { dateSpan, inr, mins } from '@/utils';

const wageParts = [
  { key: 'normal_wages', label: 'Normal wages', colour: CHART[0] },
  { key: 'ot_wages', label: 'OT wages', colour: CHART[1] },
  { key: 'other_wages', label: 'Other earnings', colour: CHART[2] },
];
const shortDate = (date) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
const exactMoney = (value) => inr(value, value % 100 !== 0);

/** Long periods keep readable columns; aggregation preserves every day's wages. */
function chartDays(trend) {
  if (trend.length <= 45) return trend.map((row) => ({ ...row, label: shortDate(row.date), from: row.date, to: row.date }));
  const buckets = new Map();
  for (const row of trend) {
    const key = trend.length > 100 ? row.date.slice(0, 7) : Math.floor((Date.parse(`${row.date}T00:00:00Z`) - Date.parse(`${trend[0].date}T00:00:00Z`)) / (7 * 86400000));
    const bucket = buckets.get(key) ?? { date: row.date, label: shortDate(row.date), from: row.date, to: row.date, normal_wages: 0, ot_wages: 0, other_wages: 0, total_wages: 0, ot_min: 0 };
    for (const field of ['normal_wages', 'ot_wages', 'other_wages', 'total_wages', 'ot_min']) bucket[field] += row[field] ?? 0;
    bucket.to = row.date;
    buckets.set(key, bucket);
  }
  return [...buckets.values()];
}

function Legend({ other = false }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
      {wageParts.filter((part) => other || part.key !== 'other_wages').map((part) => (
        <span key={part.key} className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm" style={{ background: part.colour }} />{part.label}</span>
      ))}
    </div>
  );
}

function WageTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="min-w-44 rounded-md border bg-popover p-3 text-[13px] text-popover-foreground shadow-md">
      <div className="mb-2 font-medium">{row.name ?? dateSpan(row.from ?? row.date, row.to ?? row.date)}</div>
      {wageParts.map((part) => (
        <div key={part.key} className="flex justify-between gap-5 py-0.5"><span className="text-muted-foreground">{part.label}</span><Money value={row[part.key] ?? 0} paise={(row[part.key] ?? 0) % 100 !== 0} /></div>
      ))}
      <div className="mt-2 flex justify-between gap-5 border-t pt-2 font-semibold"><span>Total</span><Money value={row.total_wages ?? 0} paise={(row.total_wages ?? 0) % 100 !== 0} /></div>
      {row.ot_min > 0 && <div className="mt-1 text-muted-foreground">{mins(row.ot_min)} overtime</div>}
    </div>
  );
}

export default function SiteWageInsights({ costs, period }) {
  const [ranking, setRanking] = useState('total_wages');
  const departments = useMemo(() => [...(costs.departments ?? [])].sort((a, b) => (b[ranking] ?? 0) - (a[ranking] ?? 0) || a.name.localeCompare(b.name)), [costs.departments, ranking]);
  const trend = useMemo(() => chartDays(costs.trend ?? []), [costs.trend]);
  const hasOther = (costs.other_wages ?? 0) !== 0 || (costs.departments ?? []).some((row) => (row.other_wages ?? 0) !== 0) || (costs.trend ?? []).some((row) => (row.other_wages ?? 0) !== 0);
  const parts = wageParts.filter((part) => (costs[part.key] ?? 0) > 0).map((part) => ({ ...part, value: costs[part.key] }));
  const positiveTotal = parts.reduce((sum, part) => sum + part.value, 0);
  const otShare = costs.total_wages > 0 ? Math.round(costs.ot_wages / costs.total_wages * 1000) / 10 : 0;
  const sourceLabel = costs.source === 'snapshot' ? 'Payroll amounts' : costs.source === 'mixed' ? 'Payroll + estimates' : 'Estimated wages';
  const basisNote = costs.source === 'snapshot' ? 'Uses saved payroll amounts. Site allocation is estimated from recorded work.' : costs.source === 'mixed' ? 'Combines saved payroll with salary estimates. Site allocation is estimated from recorded work.' : 'Estimated from recorded work and current salary rules.';
  const chartHeight = Math.max(160, departments.length * 44 + 28);
  const otView = ranking === 'ot_min';
  const otWagesView = ranking === 'ot_wages';
  const chartRows = departments.map((department) => ({ ...department, ot_hours: (department.ot_min ?? 0) / 60 }));

  return (
    <section className="flex flex-col gap-4" aria-label="Wage cost">
      <div className="flex flex-wrap items-end justify-between gap-3 pt-2">
        <div><h2 className="font-display text-[22px] font-semibold">Wage cost</h2><p className="mt-1 text-[13px] text-muted-foreground">{dateSpan(period.from, period.to)} · estimated site allocation</p></div>
        <Chip tone={costs.source === 'snapshot' ? 'info' : 'muted'}>{sourceLabel}</Chip>
      </div>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="Total wages" value={inr(costs.total_wages)} sub={hasOther ? 'Normal, OT and other earnings' : 'Normal wages + overtime'} />
        <Stat label="Normal wages" value={inr(costs.normal_wages)} sub="Salary earnings for this period" />
        <Stat label="OT wages" value={inr(costs.ot_wages)} sub={`${otShare}% of allocated wages`} tone="success" />
        <Stat label="OT hours · period" value={mins(period.ot_min ?? costs.ot_min ?? 0)} sub={costs.paid_ot_min != null ? `${mins(costs.paid_ot_min)} covered by OT wages` : 'Worked at this site'} />
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="min-w-0 lg:col-span-3">
          <CardHeader title="Wages over time" description={trend.length < (costs.trend?.length ?? 0) ? 'Grouped by week or month for a clear view.' : 'Normal pay and overtime across the selected period.'} />
          <div className="p-5">
            <Legend other={hasOther} />
            {costs.total_wages !== 0 ? (
              <div className="mt-5" role="img" aria-label="Stacked bar chart of normal wages and OT wages over time">
                <ResponsiveContainer width="100%" height={246}>
                  <BarChart data={trend} margin={{ top: 8, left: 4, right: 4, bottom: 0 }} barSize={trend.length < 8 ? 32 : undefined}>
                    <CartesianGrid {...grid} />
                    <XAxis dataKey="label" {...axis} minTickGap={28} />
                    <YAxis {...axis} tickFormatter={rupeesShort} width={62} />
                    <Tooltip content={<WageTooltip />} cursor={{ fill: 'var(--muted)', opacity: 0.6 }} />
                    <Bar dataKey="normal_wages" stackId="wages" fill={CHART[0]} name="Normal wages" isAnimationActive={false} />
                    <Bar dataKey="ot_wages" stackId="wages" fill={CHART[1]} name="OT wages" radius={hasOther ? undefined : [3, 3, 0, 0]} isAnimationActive={false} />
                    {hasOther && <Bar dataKey="other_wages" stackId="wages" fill={CHART[2]} name="Other earnings" radius={[3, 3, 0, 0]} isAnimationActive={false} />}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : <EmptyState title="No allocated wages yet" body="Recorded attendance and salary or payroll data are needed to calculate this site's wages." />}
          </div>
        </Card>
        <Card className="min-w-0 lg:col-span-2">
          <CardHeader title="Wage mix" description="How much of the cost goes to overtime?" />
          <div className="p-5">
            <div className="relative mx-auto h-48 max-w-64" role="img" aria-label={wageParts.map((part) => `${part.label} ${exactMoney(costs[part.key] ?? 0)}`).join(', ')}>
              {positiveTotal > 0 ? (
                <ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={parts} dataKey="value" nameKey="label" innerRadius={64} outerRadius={86} paddingAngle={parts.length > 1 ? 3 : 0} stroke="none" isAnimationActive={false}>{parts.map((part) => <Cell key={part.key} fill={part.colour} />)}</Pie><Tooltip {...tooltipStyle} formatter={(value) => exactMoney(value)} /></PieChart></ResponsiveContainer>
              ) : <div className="absolute inset-3 mx-auto aspect-square rounded-full border-[20px] border-muted" />}
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"><span className="text-[28px] font-semibold num">{otShare}%</span><span className="text-[12px] text-muted-foreground">OT share</span></div>
            </div>
            <dl className="mt-2 space-y-2 text-[13px]">
              {wageParts.filter((part) => hasOther || part.key !== 'other_wages').map((part) => <div key={part.key} className="flex items-center justify-between gap-3"><dt className="flex items-center gap-2 text-muted-foreground"><span className="size-2 rounded-sm" style={{ background: part.colour }} />{part.label}</dt><dd className="font-medium"><Money value={costs[part.key] ?? 0} /></dd></div>)}
            </dl>
          </div>
        </Card>
      </div>

      <Card className="min-w-0">
        <CardHeader title="Where wages go" description="Compare departments by wages or overtime hours." actions={<Segmented label="Department ranking" value={ranking} onChange={setRanking} options={[{ value: 'total_wages', label: 'Total wages' }, { value: 'ot_wages', label: 'OT wages' }, { value: 'ot_min', label: 'OT hours' }]} />} />
        {departments.length ? (
          <>
            <div className="p-5">
              {!otView && !otWagesView && <Legend other={hasOther} />}
              <div className="mt-3 max-h-80 overflow-y-auto" role="img" aria-label={otView ? 'Department overtime hours, highest first' : otWagesView ? 'Department OT wages, highest first' : 'Department wages, highest first'}>
                <ResponsiveContainer width="100%" height={chartHeight}>
                  <BarChart layout="vertical" data={chartRows} margin={{ left: 0, right: 18, top: 8, bottom: 0 }} barSize={22}>
                    <CartesianGrid {...grid} vertical horizontal={false} />
                    <XAxis type="number" {...axis} tickFormatter={otView ? (value) => `${value}h` : rupeesShort} />
                    <YAxis type="category" dataKey="name" {...axis} width={100} tickFormatter={(name) => name.length > 14 ? `${name.slice(0, 13)}…` : name} />
                    {otView ? <Tooltip {...tooltipStyle} formatter={(_value, _name, item) => [mins(item.payload.ot_min), 'OT hours']} /> : <Tooltip content={<WageTooltip />} />}
                    {otView ? <Bar dataKey="ot_hours" fill={CHART[1]} radius={[0, 4, 4, 0]} name="OT hours" isAnimationActive={false} /> : otWagesView ? <Bar dataKey="ot_wages" fill={CHART[1]} radius={[0, 4, 4, 0]} name="OT wages" isAnimationActive={false} /> : wageParts.filter((part) => hasOther || part.key !== 'other_wages').map((part) => <Bar key={part.key} dataKey={part.key} stackId="wages" fill={part.colour} name={part.label} isAnimationActive={false} />)}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="overflow-x-auto border-t"><table className="data-table w-full"><thead><tr><th>Department</th><th className="text-right">People</th><th className="text-right">OT hours</th><th className="text-right">Normal wages</th><th className="text-right">OT wages</th>{hasOther && <th className="text-right">Other earnings</th>}<th className="text-right">Total wages</th></tr></thead><tbody>{departments.map((department) => <tr key={department.id}><td className="font-medium">{department.name}</td><td className="text-right num">{department.people}</td><td className="text-right num">{mins(department.ot_min ?? 0)}</td><td className="text-right"><Money value={department.normal_wages} /></td><td className="text-right"><Money value={department.ot_wages} /></td>{hasOther && <td className="text-right"><Money value={department.other_wages ?? 0} /></td>}<td className="text-right font-semibold"><Money value={department.total_wages} /></td></tr>)}</tbody></table></div>
          </>
        ) : <EmptyState title="No department costs yet" body="Department costs appear when recorded work can be matched to salary or payroll." />}
        <div className="space-y-1 border-t bg-muted/30 px-5 py-3 text-[12px] leading-relaxed text-muted-foreground">
          <p>{basisNote} Employer contributions and reimbursements are excluded.</p>
          {costs.uncosted_people > 0 && <p className="font-medium text-warning-foreground">{costs.uncosted_people} {costs.uncosted_people === 1 ? 'person has' : 'people have'} work without a salary calculation ({mins(costs.uncosted_min ?? 0)}). These wages are not included.</p>}
          {costs.unallocated_wages > 0 && <p>{inr(costs.unallocated_wages)} of earnings across these employees' payroll months could not be assigned to recorded site work.</p>}
          {costs.note && <details className="pt-1"><summary className="w-fit cursor-pointer text-primary">How wages are calculated</summary><p className="mt-2 max-w-4xl">{costs.note}</p></details>}
        </div>
      </Card>
    </section>
  );
}
