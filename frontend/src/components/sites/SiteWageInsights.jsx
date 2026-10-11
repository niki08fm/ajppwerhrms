import { useMemo, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Money } from '@/components/bits';
import { axis, CHART, grid, rupeesShort, tooltipStyle } from '@/components/charts';
import { Chip, EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Segmented, Select } from '@/components/ui/form';
import { dateSpan, inr, mins } from '@/utils';

const wageParts = [
  { key: 'normal_wages', label: 'Normal wages', colour: CHART[0] },
  { key: 'ot_wages', label: 'OT wages', colour: CHART[3] },
  { key: 'other_wages', label: 'Other earnings', colour: CHART[2] },
];
const shortDate = (date) => new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
const exactMoney = (value) => inr(value, value % 100 !== 0);
const departmentColour = (department, index) => /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(department.colour ?? '') ? department.colour : /^chart-[1-5]$/.test(department.colour) ? `var(--${department.colour})` : CHART[index % CHART.length];

/** Longer periods group dates without dropping any wage amounts. */
function chartDays(trend) {
  if (trend.length <= 45) return trend.map((row) => ({ ...row, label: shortDate(row.date), from: row.date, to: row.date }));
  const buckets = new Map();
  trend.forEach((row, index) => {
    const key = trend.length > 100 ? row.date.slice(0, 7) : Math.floor(index / 7);
    const bucket = buckets.get(key) ?? { date: row.date, label: shortDate(row.date), from: row.date, to: row.date, normal_wages: 0, ot_wages: 0, other_wages: 0, total_wages: 0, ot_min: 0 };
    for (const field of ['normal_wages', 'ot_wages', 'other_wages', 'total_wages', 'ot_min']) bucket[field] += row[field] ?? 0;
    bucket.to = row.date;
    buckets.set(key, bucket);
  });
  return [...buckets.values()];
}

function WageTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return <div className="min-w-44 rounded-md border bg-popover p-3 text-[13px] text-popover-foreground shadow-md">
    <div className="mb-2 font-medium">{row.name ?? dateSpan(row.from ?? row.date, row.to ?? row.date)}</div>
    {wageParts.map((part) => <div key={part.key} className="flex justify-between gap-5 py-0.5"><span className="text-muted-foreground">{part.label}</span><Money value={row[part.key] ?? 0} paise={(row[part.key] ?? 0) % 100 !== 0} /></div>)}
    <div className="mt-2 flex justify-between gap-5 border-t pt-2 font-semibold"><span>Total</span><Money value={row.total_wages ?? 0} paise={(row.total_wages ?? 0) % 100 !== 0} /></div>
  </div>;
}

export default function SiteWageInsights({ costs, period }) {
  const [view, setView] = useState('trend');
  const [metric, setMetric] = useState('total_wages');
  const [showFigures, setShowFigures] = useState(false);
  const departments = useMemo(() => [...(costs.departments ?? [])].sort((a, b) => (b[metric] ?? 0) - (a[metric] ?? 0) || a.name.localeCompare(b.name)), [costs.departments, metric]);
  const trend = useMemo(() => chartDays(costs.trend ?? []), [costs.trend]);
  const hasOther = (costs.other_wages ?? 0) !== 0 || (costs.departments ?? []).some((row) => (row.other_wages ?? 0) !== 0) || (costs.trend ?? []).some((row) => (row.other_wages ?? 0) !== 0);
  const parts = wageParts.filter((part) => (costs[part.key] ?? 0) > 0).map((part) => ({ ...part, value: costs[part.key] }));
  const positiveTotal = parts.reduce((sum, part) => sum + part.value, 0);
  const otShare = costs.total_wages > 0 ? Math.round(costs.ot_wages / costs.total_wages * 1000) / 10 : 0;
  const sourceLabel = costs.source === 'snapshot' ? 'Payroll amounts' : costs.source === 'mixed' ? 'Payroll + estimates' : 'Estimated wages';
  const basisNote = costs.source === 'snapshot' ? 'Saved payroll amounts; site allocation is estimated.' : costs.source === 'mixed' ? 'Saved payroll and salary estimates; site allocation is estimated.' : 'Estimated from recorded work and current salary rules.';
  const otView = metric === 'ot_min';
  const metricLabel = otView ? 'OT hours' : metric === 'ot_wages' ? 'OT wages' : 'Total wages';
  const hasTrend = trend.some((row) => wageParts.some((part) => (row[part.key] ?? 0) !== 0));

  return <section aria-label="Wage cost">
    <Card className="min-w-0 overflow-hidden">
      <CardHeader title="Wage cost" description={`${dateSpan(period.from, period.to)} · estimated site allocation`} actions={<Chip tone={costs.source === 'snapshot' ? 'info' : 'muted'}>{sourceLabel}</Chip>} />
      <div className="grid grid-cols-2 gap-x-5 gap-y-4 border-b px-5 py-4 sm:grid-cols-4">
        {[['Total wages', inr(costs.total_wages)], ['Normal wages', inr(costs.normal_wages)], ['OT wages', inr(costs.ot_wages)], ['OT hours · period', mins(period.ot_min ?? costs.ot_min ?? 0)]].map(([label, value]) => <div key={label} className="min-w-0"><div className="text-[12px] text-muted-foreground">{label}</div><div className="num mt-1 text-[23px] font-semibold leading-tight">{value}</div></div>)}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
        <Segmented label="Wage view" value={view} onChange={setView} options={[{ value: 'trend', label: 'Trend' }, { value: 'departments', label: 'Departments' }]} />
        {view === 'departments' && <Select aria-label="Department metric" value={metric} onChange={(event) => setMetric(event.target.value)} className="w-40"><option value="total_wages">Total wages</option><option value="ot_wages">OT wages</option><option value="ot_min">OT hours</option></Select>}
      </div>

      {view === 'trend' ? <div className="grid min-w-0 gap-5 p-5 lg:grid-cols-[1.8fr_1fr]">
        <div className="min-w-0">
          <h3 className="mb-3 text-[14px] font-medium">Wages over time</h3>
          {hasTrend ? <div role="img" aria-label="Stacked area chart of normal wages and OT wages over time"><ResponsiveContainer width="100%" height={225}>
            <AreaChart data={trend} margin={{ top: 8, left: 0, right: 4, bottom: 0 }}>
              <CartesianGrid {...grid} /><XAxis dataKey="label" {...axis} minTickGap={28} /><YAxis {...axis} tickFormatter={rupeesShort} width={56} />
              <Tooltip content={<WageTooltip />} />
              {wageParts.filter((part) => hasOther || part.key !== 'other_wages').map((part) => <Area key={part.key} type="linear" dataKey={part.key} stackId="wages" stroke={part.colour} fill={part.colour} fillOpacity={0.3} strokeWidth={2} name={part.label} isAnimationActive={false} />)}
            </AreaChart>
          </ResponsiveContainer></div> : <EmptyState title="No allocated wages yet" body="Recorded work and salary or payroll data are needed." />}
        </div>
        <div className="min-w-0 lg:border-l lg:pl-5">
          <h3 className="text-[14px] font-medium">Wage mix</h3>
          <div className="relative mx-auto h-40 max-w-56" role="img" aria-label={wageParts.map((part) => `${part.label} ${exactMoney(costs[part.key] ?? 0)}`).join(', ')}>
            {positiveTotal > 0 ? <ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={parts} dataKey="value" nameKey="label" innerRadius={47} outerRadius={66} paddingAngle={parts.length > 1 ? 3 : 0} stroke="none" isAnimationActive={false}>{parts.map((part) => <Cell key={part.key} fill={part.colour} />)}</Pie><Tooltip {...tooltipStyle} formatter={(value) => exactMoney(value)} /></PieChart></ResponsiveContainer> : <div className="absolute inset-3 mx-auto aspect-square rounded-full border-[18px] border-muted" />}
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"><span className="num text-[24px] font-semibold">{otShare}%</span><span className="text-[11px] text-muted-foreground">OT share</span></div>
          </div>
          <dl className="space-y-1.5 text-[12px]">{wageParts.filter((part) => hasOther || part.key !== 'other_wages').map((part) => <div key={part.key} className="flex items-center justify-between gap-3"><dt className="flex items-center gap-2 text-muted-foreground"><span className="size-2 rounded-sm" style={{ background: part.colour }} />{part.label}</dt><dd><Money value={costs[part.key] ?? 0} /></dd></div>)}</dl>
        </div>
      </div> : <div className="p-5">
        <div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-[14px] font-medium">Where wages go</h3><Button size="sm" variant="ghost" aria-expanded={showFigures} onClick={() => setShowFigures(!showFigures)}>{showFigures ? 'Hide figures' : 'Show figures'}</Button></div>
        {departments.length ? <div className="max-h-64 overflow-y-auto" role="img" aria-label={otView ? 'Department overtime hours, highest first' : metric === 'ot_wages' ? 'Department OT wages, highest first' : 'Department wages, highest first'}><ResponsiveContainer width="100%" height={Math.max(170, departments.length * 42 + 25)}>
          <BarChart layout="vertical" data={departments.map((department) => ({ ...department, ot_hours: (department.ot_min ?? 0) / 60 }))} margin={{ left: 0, right: 12, top: 8, bottom: 0 }} barSize={22}>
            <CartesianGrid {...grid} vertical horizontal={false} /><XAxis type="number" {...axis} tickFormatter={otView ? (value) => `${value}h` : rupeesShort} /><YAxis type="category" dataKey="name" {...axis} width={95} tickFormatter={(name) => name.length > 14 ? `${name.slice(0, 13)}…` : name} />
            <Tooltip {...tooltipStyle} labelFormatter={(_label, payload) => payload?.[0]?.payload?.name ?? ''} formatter={(value, _name, item) => [otView ? mins(item.payload.ot_min) : exactMoney(value), metricLabel]} />
            <Bar dataKey={otView ? 'ot_hours' : metric} radius={[0, 4, 4, 0]} name={metricLabel} isAnimationActive={false}>{departments.map((department, index) => <Cell key={department.id} fill={departmentColour(department, index)} />)}</Bar>
          </BarChart>
        </ResponsiveContainer></div> : <EmptyState title="No department costs yet" body="Department costs appear when work can be matched to salary or payroll." />}
      </div>}

      {view === 'departments' && showFigures && <div className="overflow-x-auto border-t"><table className="data-table w-full"><thead><tr><th>Department</th><th className="text-right">People</th><th className="text-right">OT hours</th><th className="text-right">Normal wages</th><th className="text-right">OT wages</th>{hasOther && <th className="text-right">Other earnings</th>}<th className="text-right">Total wages</th></tr></thead><tbody>{departments.map((department) => <tr key={department.id}><td className="font-medium">{department.name}</td><td className="num text-right">{department.people}</td><td className="num text-right">{mins(department.ot_min ?? 0)}</td><td className="text-right"><Money value={department.normal_wages} /></td><td className="text-right"><Money value={department.ot_wages} /></td>{hasOther && <td className="text-right"><Money value={department.other_wages ?? 0} /></td>}<td className="text-right font-semibold"><Money value={department.total_wages} /></td></tr>)}</tbody></table></div>}
      <div className="space-y-1 border-t px-5 py-3 text-[12px] leading-relaxed text-muted-foreground">
        <p>{basisNote}{costs.paid_ot_min != null ? ` ${mins(costs.paid_ot_min)} covered by OT wages.` : ''}</p>
        {costs.uncosted_people > 0 && <p className="font-medium text-warning-foreground">{costs.uncosted_people} {costs.uncosted_people === 1 ? 'person has' : 'people have'} work without a salary calculation ({mins(costs.uncosted_min ?? 0)}). These wages are not included.</p>}
        <details><summary className="w-fit cursor-pointer text-primary">Calculation details</summary><div className="mt-2 max-w-4xl space-y-1"><p>Employer contributions and reimbursements are excluded.</p>{costs.unallocated_wages > 0 && <p>{inr(costs.unallocated_wages)} across these employees' payroll months could not be assigned to recorded site work.</p>}{costs.note && <p>{costs.note}</p>}</div></details>
      </div>
    </Card>
  </section>;
}
