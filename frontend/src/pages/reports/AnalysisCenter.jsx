import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowUpRight, Table2 } from 'lucide-react';
import { COMPANIES, formatINR } from '@ajpwer/shared';
import { api } from '@/services/api';
import { cn } from '@/utils';
import { PageHeader } from '@/components/bits';
import { EmptyState, ErrorState, SkeletonBlock } from '@/components/states';
import { Card, CardHeader } from '@/components/ui/card';
import { Select } from '@/components/ui/form';
import { rupeesShort } from '@/components/charts';

/*
 * The analysis center: a financial year of payroll as charts. Every chart has a tooltip with
 * the numbers, and the month-by-month table below holds the same figures. Colours follow the
 * figure everywhere: CTC blue, normal wages orange, net pay aqua, OT violet, other earnings
 * magenta, employer contributions green (a validated palette, light and dark).
 */

const V = (n) => `var(--viz-${n})`;
const COLOR = { ctc: V(1), normal: V(2), net: V(3), ot: V(7), other: V(5), employer: V(6) };
const LABEL = { ctc: 'Cost to company', normal: 'Normal wages', net: 'Net pay', ot: 'OT wages', other: 'Other earnings', employer: 'Employer PF + ESI' };
const SLICES = [V(1), V(2), V(3), V(4), V(5), V(6), V(7)];
const inr = (p) => formatINR(Math.round(p ?? 0));
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '—');

const axis = { stroke: 'var(--muted-foreground)', fontSize: 12, tickLine: false, axisLine: { stroke: 'var(--viz-axis)' } };
const yAxis = { ...axis, axisLine: false, width: 64, tickFormatter: rupeesShort };
const grid = <CartesianGrid stroke="var(--viz-grid)" vertical={false} />;
/** Legend text in the text colour; the swatch beside it carries the series colour. */
const legendText = (value) => <span style={{ color: 'var(--foreground)' }}>{value}</span>;

/** The analyses, one at a time. */
const VIEWS = [
  { key: 'cost', label: 'Cost to company, month by month', group: 'Cost' },
  { key: 'split', label: 'Where the cost goes', group: 'Cost' },
  { key: 'dept', label: 'Cost by department', group: 'Cost' },
  { key: 'site', label: 'Cost by site', group: 'Cost' },
  { key: 'statutory', label: 'Statutory each month', group: 'Cost' },
  { key: 'ot_month', label: 'OT hours each month', group: 'Overtime' },
  { key: 'ot_top', label: 'Most overtime (top 10)', group: 'Overtime' },
  { key: 'ot_dept', label: 'OT by department', group: 'Overtime' },
  { key: 'ot_site', label: 'OT by site', group: 'Overtime' },
  { key: 'people', label: 'People paid, joiners and exits', group: 'Workforce' },
  { key: 'gender', label: 'Men and women', group: 'Workforce' },
  { key: 'table', label: 'Month-wise summary table', group: 'Summary' },
];

/** A compact headline figure. */
function Kpi({ label, value, sub }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <div className="truncate text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className="text-[20px] leading-tight font-semibold whitespace-nowrap num">{value}</div>
      {sub && <div className="truncate text-[12px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** One tooltip for every chart: the month (or item) and each figure with its colour. */
function Tip({ active, payload, label, extra }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="min-w-48 rounded-lg border bg-popover px-3 py-2 text-[13px] text-popover-foreground shadow-lg">
      <div className="mb-1.5 font-semibold">{row.label ?? row.name ?? label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-2 text-muted-foreground">
            <span className="size-2.5 rounded-sm" style={{ background: p.color ?? p.payload.fill }} />
            {p.name}
          </span>
          <span className="font-medium num">{p.unit === 'h' ? `${p.value} h` : p.unit === 'n' ? p.value : inr(p.value)}</span>
        </div>
      ))}
      {extra?.(row)}
    </div>
  );
}

function ChartCard({ title, description, children, className, actions }) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader title={title} description={description} actions={actions} />
      <div className="flex-1 px-3 pb-3">{children}</div>
    </Card>
  );
}

/** A donut with its legend beside it: name, value and share. Slices beyond 7 fold into Other. */
function Donut({ items, valueKey, unit, total, size = 180 }) {
  const top = items.slice(0, 7);
  const rest = items.slice(7);
  const data = [...top.map((x, i) => ({ ...x, fill: SLICES[i] })), ...(rest.length ? [{ name: `Other (${rest.length})`, [valueKey]: rest.reduce((a, x) => a + x[valueKey], 0), fill: 'var(--viz-other)' }] : [])];
  const sum = total ?? data.reduce((a, x) => a + x[valueKey], 0);
  return (
    <div className="mx-auto grid w-full max-w-3xl items-center gap-6 py-4 sm:grid-cols-[auto_1fr]" style={{ '--donut': `${size}px` }}>
      <div className="mx-auto" style={{ width: size, height: size }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie data={data} dataKey={valueKey} nameKey="name" innerRadius={size * 0.3} outerRadius={size * 0.47} paddingAngle={1.5} stroke="var(--card)" strokeWidth={2} isAnimationActive={false}>
              {data.map((d) => <Cell key={d.name} fill={d.fill} />)}
            </Pie>
            <Tooltip content={<Tip />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="flex flex-col gap-2 text-[14px]">
        {data.map((d) => (
          <li key={d.name} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: d.fill }} />
            <span className="min-w-0 flex-1 truncate">{d.name}</span>
            <span className="font-medium num">{unit === 'n' ? d[valueKey] : rupeesShort(d[valueKey])}</span>
            <span className="w-12 text-right text-muted-foreground num">{pct(d[valueKey], sum)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function AnalysisCenter() {
  const [sp, setSp] = useSearchParams();
  const params = { fy: sp.get('fy') ?? '', company: sp.get('company') ?? '', department_id: sp.get('department') ?? '', site_id: sp.get('site') ?? '' };
  const set = (patch) => setSp((p) => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(patch)) (v ? n.set(k, v) : n.delete(k));
    return n;
  });
  const view = VIEWS.some((v) => v.key === sp.get('view')) ? sp.get('view') : 'cost';
  const q = useQuery({
    queryKey: ['analysis', params],
    queryFn: () => api.get('/analysis', Object.fromEntries(Object.entries(params).filter(([, v]) => v))).then((r) => r.data),
    placeholderData: (prev) => prev,
  });
  const d = q.data;
  const run = useMemo(() => (d ? d.months.filter((m) => m.state) : []), [d]);
  // Months with no payroll are gaps in the charts, not zeros.
  const chart = useMemo(() => (d ? d.months.map((m) => (m.state ? { ...m, pf: m.pf_ee + m.er_pf, esi: m.esi_ee + m.er_esi } : { ym: m.ym, label: m.label, short: m.short, state: null })) : []), [d]);
  const [picked, setPicked] = useState(null);
  // Lines hidden from the cost chart (tap a legend name); hiding the big ones zooms in on OT.
  const [hidden, setHidden] = useState(() => new Set());
  const toggle = (key) => setHidden((h) => { const n = new Set(h); n.has(key) ? n.delete(key) : n.add(key); return n.size === 4 ? h : n; });
  const selected = d?.months.find((m) => m.ym === picked) ?? run.at(-1) ?? null;
  const reportLink = (report) => {
    const qs = new URLSearchParams({ period: 'custom', from: `${d.fy}-04`, to: `${d.fy + 1}-03`, report, ...(params.company ? { company: params.company } : {}), ...(params.department_id ? { department: params.department_id } : {}), ...(params.site_id ? { site: params.site_id } : {}) });
    return `/reports?${qs}`;
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Analysis center" description="Choose what to see in View. Hover or tap a chart for the numbers." />

      {/* View and filters: one row */}
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-full font-medium sm:w-80" aria-label="Analysis to show" value={view} onChange={(e) => set({ view: e.target.value })}>
          {['Cost', 'Overtime', 'Workforce', 'Summary'].map((g) => (
            <optgroup key={g} label={g}>{VIEWS.filter((v) => v.group === g).map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}</optgroup>
          ))}
        </Select>
        <Select className="w-full sm:w-36" aria-label="Financial year" value={params.fy || String(d?.fy ?? '')} onChange={(e) => set({ fy: e.target.value })}>
          {(d?.years ?? []).map((y) => <option key={y} value={y}>FY {y}-{String(y + 1).slice(2)}</option>)}
        </Select>
        <Select className="w-full sm:w-40" aria-label="Company" value={params.company} onChange={(e) => set({ company: e.target.value })}>
          <option value="">Both companies</option>
          {COMPANIES.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
        </Select>
        <Select className="w-full sm:w-44" aria-label="Department" value={params.department_id} onChange={(e) => set({ department: e.target.value })}>
          <option value="">All departments</option>
          {(d?.filters.departments ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </Select>
        <Select className="w-full sm:w-44" aria-label="Site" value={params.site_id} onChange={(e) => set({ site: e.target.value })}>
          <option value="">All sites</option>
          {(d?.filters.sites ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          <option value="none">No site (no punches)</option>
        </Select>
      </div>

      {q.isLoading ? (
        <SkeletonBlock className="h-[480px]" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !run.length ? (
        <Card><EmptyState title="No payroll in this year yet" body="Run payroll for a month of this financial year to see its analysis." /></Card>
      ) : (
        <div className={cn('flex flex-col gap-4 transition-opacity', q.isFetching && 'opacity-60')}>
          {/* Headline figures: one compact strip */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
            <Kpi label="Cost to company" value={rupeesShort(d.totals.ctc)} sub={`${d.months_run} month${d.months_run === 1 ? '' : 's'} run`} />
            <Kpi label="Normal wages" value={rupeesShort(d.totals.normal)} sub={`${pct(d.totals.normal, d.totals.ctc)} of cost`} />
            <Kpi label="OT wages" value={rupeesShort(d.totals.ot)} sub={`${pct(d.totals.ot, d.totals.gross)} of gross`} />
            <Kpi label="Net pay" value={rupeesShort(d.totals.net)} />
            <Kpi label="OT hours" value={d.totals.ot_hours.toLocaleString('en-IN')} sub={`${Math.round((d.totals.ot_hours / Math.max(1, d.months_run)) * 10) / 10} h a month`} />
            <Kpi label="Avg headcount" value={d.totals.avg_headcount} sub={`${d.totals.people} people paid`} />
            <Kpi label="Joiners · Exits" value={`${d.totals.joiners} · ${d.totals.exits}`} />
            <Kpi label="Attrition" value={`${d.totals.attrition_pct}%`} />
          </div>

          {/* One analysis at a time, chosen in the View dropdown */}
          {view === 'cost' && (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <ChartCard
              title="Cost to company, month by month"
              description="Cost to company, normal wages, net pay and OT wages. Tap a month to see its numbers."
            >
              <div className="h-[calc(100vh-29rem)] min-h-[300px]">
                <ResponsiveContainer>
                  <ComposedChart data={chart} margin={{ top: 10, right: 12, left: 0, bottom: 0 }} onClick={(e) => e?.activePayload?.[0] && setPicked(e.activePayload[0].payload.ym)}>
                    {grid}
                    <XAxis dataKey="short" {...axis} />
                    <YAxis {...yAxis} />
                    <Tooltip content={<Tip extra={(r) => r.state && (
                      <div className="mt-1.5 border-t pt-1.5 text-muted-foreground">
                        OT hours <span className="float-right font-medium text-foreground num">{r.ot_hours} h</span><br />
                        People <span className="float-right font-medium text-foreground num">{r.people}</span>
                      </div>
                    )} />} cursor={{ stroke: 'var(--viz-axis)', strokeWidth: 1 }} />
                    <Legend
                      iconType="plainline"
                      wrapperStyle={{ fontSize: 13, cursor: 'pointer' }}
                      onClick={(e) => toggle(e.dataKey)}
                      formatter={(value, entry) => <span style={{ color: entry.inactive ? 'var(--muted-foreground)' : 'var(--foreground)', textDecoration: entry.inactive ? 'line-through' : 'none' }}>{value}</span>}
                    />
                    <Area hide={hidden.has('ctc')} dataKey="ctc" name={LABEL.ctc} stroke={COLOR.ctc} fill={COLOR.ctc} fillOpacity={0.12} strokeWidth={2} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--card)' }} connectNulls={false} isAnimationActive={false} />
                    <Line hide={hidden.has('normal')} dataKey="normal" name={LABEL.normal} stroke={COLOR.normal} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--card)' }} isAnimationActive={false} />
                    <Line hide={hidden.has('net')} dataKey="net" name={LABEL.net} stroke={COLOR.net} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--card)' }} isAnimationActive={false} />
                    <Line hide={hidden.has('ot')} dataKey="ot" name={LABEL.ot} stroke={COLOR.ot} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--card)' }} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
            {selected && <MonthCard m={selected} />}
          </div>
          )}
          {view === 'split' && (
            <ChartCard title="Where the cost goes" description="Each month's cost to company, by part">
              <div className="h-[calc(100vh-29rem)] min-h-[300px]">
                <ResponsiveContainer>
                  <BarChart data={chart} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                    {grid}
                    <XAxis dataKey="short" {...axis} />
                    <YAxis {...yAxis} />
                    <Tooltip content={<Tip />} cursor={{ fill: 'var(--accent)' }} />
                    <Legend iconType="square" wrapperStyle={{ fontSize: 13 }} formatter={legendText} />
                    {['normal', 'ot', 'other', 'employer'].map((k, i, all) => (
                      <Bar key={k} dataKey={k} name={LABEL[k]} stackId="cost" fill={COLOR[k]} stroke="var(--card)" strokeWidth={1} radius={i === all.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={36} isAnimationActive={false} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
          )}
          {view === 'dept' && (
            <ChartCard title="Cost by department" description={`Cost to company for ${d.label}`}>
              <Donut size={260} items={d.departments} valueKey="ctc" total={d.totals.ctc} />
            </ChartCard>
          )}
          {view === 'site' && (
            <ChartCard title="Cost by site" description="Split by the days each person worked at each site">
              <div style={{ height: Math.max(160, d.sites.length * 38 + 30) }}>
                <ResponsiveContainer>
                  <BarChart data={d.sites} layout="vertical" margin={{ top: 4, right: 56, left: 8, bottom: 0 }}>
                    <XAxis type="number" {...axis} tickFormatter={rupeesShort} hide />
                    <YAxis type="category" dataKey="name" {...axis} axisLine={false} width={150} />
                    <Tooltip content={<Tip extra={(r) => <div className="mt-1 text-muted-foreground">{r.people} people · OT {r.ot_hours} h</div>} />} cursor={{ fill: 'var(--accent)' }} />
                    <Bar dataKey="ctc" name={LABEL.ctc} fill={COLOR.ctc} radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false} label={{ position: 'right', formatter: rupeesShort, fontSize: 12, fill: 'var(--muted-foreground)' }} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
          )}
          {view === 'statutory' && (
            <ChartCard title="Statutory each month" description="PF (employee and employer), ESI, professional tax and income tax">
              <div className="h-[calc(100vh-29rem)] min-h-[300px]">
                <ResponsiveContainer>
                  <BarChart data={chart} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                    {grid}
                    <XAxis dataKey="short" {...axis} />
                    <YAxis {...yAxis} />
                    <Tooltip content={<Tip />} cursor={{ fill: 'var(--accent)' }} />
                    <Legend iconType="square" wrapperStyle={{ fontSize: 13 }} formatter={legendText} />
                    {[['pf', 'PF'], ['esi', 'ESI'], ['pt', 'Professional tax'], ['tds', 'Income tax']].map(([k, name], i, all) => (
                      <Bar key={k} dataKey={k} name={name} stackId="st" fill={V(i + 1)} stroke="var(--card)" strokeWidth={1} radius={i === all.length - 1 ? [4, 4, 0, 0] : 0} maxBarSize={36} isAnimationActive={false} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
          )}
          {view === 'ot_month' && (
            <ChartCard title="OT hours each month" description="Hours paid as overtime">
              <div className="h-[calc(100vh-29rem)] min-h-[300px]">
                <ResponsiveContainer>
                  <BarChart data={chart} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                    {grid}
                    <XAxis dataKey="short" {...axis} />
                    <YAxis {...axis} axisLine={false} width={40} />
                    <Tooltip content={<Tip extra={(r) => r.state && <div className="mt-1 text-muted-foreground">OT wages {inr(r.ot)}</div>} />} cursor={{ fill: 'var(--accent)' }} />
                    <Bar dataKey="ot_hours" name="OT hours" unit="h" fill={COLOR.ot} radius={[4, 4, 0, 0]} maxBarSize={32} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
          )}
          {view === 'ot_top' && (
            <ChartCard title="Most overtime" description="The ten people with the most OT hours this year">
              <div style={{ height: Math.max(160, d.top_ot.length * 30 + 20) }}>
                <ResponsiveContainer>
                  <BarChart data={d.top_ot} layout="vertical" margin={{ top: 4, right: 48, left: 8, bottom: 0 }}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="name" {...axis} axisLine={false} width={140} />
                    <Tooltip content={<Tip extra={(r) => <div className="mt-1 text-muted-foreground">{r.code} · {r.department} · {inr(r.ot)}</div>} />} cursor={{ fill: 'var(--accent)' }} />
                    <Bar dataKey="ot_hours" name="OT hours" unit="h" fill={COLOR.ot} radius={[0, 4, 4, 0]} maxBarSize={18} isAnimationActive={false} label={{ position: 'right', formatter: (v) => `${v} h`, fontSize: 12, fill: 'var(--muted-foreground)' }} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
          )}
          {view === 'ot_dept' && (
            <ChartCard title="OT by department" description="Overtime hours by department">
              <Donut size={260} items={[...d.departments].filter((x) => x.ot_hours > 0).sort((a, b) => b.ot_hours - a.ot_hours)} valueKey="ot_hours" unit="n" />
            </ChartCard>
          )}
          {view === 'ot_site' && (
            <ChartCard title="OT by site" description="Overtime hours by site">
              <Donut size={260} items={[...d.sites].filter((x) => x.ot_hours > 0).sort((a, b) => b.ot_hours - a.ot_hours)} valueKey="ot_hours" unit="n" />
            </ChartCard>
          )}
          {view === 'people' && (
            <ChartCard title="People paid each month">
              <div className="h-[calc(100vh-29rem)] min-h-[300px]">
                <ResponsiveContainer>
                  <ComposedChart data={chart} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
                    {grid}
                    <XAxis dataKey="short" {...axis} />
                    <YAxis {...axis} axisLine={false} width={40} allowDecimals={false} />
                    <Tooltip content={<Tip />} cursor={{ fill: 'var(--accent)' }} />
                    <Legend iconType="square" wrapperStyle={{ fontSize: 13 }} formatter={legendText} />
                    <Bar dataKey="joiners" name="Joiners" unit="n" fill={V(3)} radius={[4, 4, 0, 0]} maxBarSize={16} isAnimationActive={false} />
                    <Bar dataKey="exits" name="Exits" unit="n" fill={V(8)} radius={[4, 4, 0, 0]} maxBarSize={16} isAnimationActive={false} />
                    <Line dataKey="headcount" name="People paid" unit="n" stroke={COLOR.ctc} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--card)' }} connectNulls={false} isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </ChartCard>
          )}
          {view === 'gender' && (
            <ChartCard title="Men and women" description={d.workforce.latest_month ? `People paid in ${d.months.find((m) => m.ym === d.workforce.latest_month)?.label}` : ''}>
              <Donut size={260} items={d.workforce.gender.map((g) => ({ name: g.label, value: g.value }))} valueKey="value" unit="n" />
            </ChartCard>
          )}
          {view === 'table' && (
          <Card>
            <CardHeader
              title="Month-wise summary"
              description="Every figure, month by month"
              actions={
                <div className="flex flex-wrap gap-2">
                  <Link to={reportLink('trend')} className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline"><Table2 className="size-4" /> Month by month report <ArrowUpRight className="size-3.5" /></Link>
                  <Link to={reportLink('cost')} className="inline-flex items-center gap-1 text-[13px] font-medium text-primary hover:underline"><Table2 className="size-4" /> Full cost to company <ArrowUpRight className="size-3.5" /></Link>
                </div>
              }
            />
            <div className="max-h-[calc(100vh-27rem)] overflow-auto">
              <table className="w-full min-w-[900px] text-[14px]">
                <thead className="bg-muted/60 text-left text-[12px] tracking-wide text-muted-foreground uppercase">
                  <tr>
                    {['Month', 'People', 'Normal wages', 'OT wages', 'OT hours', 'Other earnings', 'Gross', 'Employer PF + ESI', 'Cost to company', 'Net pay'].map((h, i) => (
                      <th key={h} className={cn('px-3 py-2 font-semibold', i > 0 && 'text-right')}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.months.map((m) => (
                    <tr key={m.ym} className={cn('border-t', !m.state && 'text-muted-foreground')}>
                      <td className="px-3 py-2 whitespace-nowrap">{m.label}{m.state === 'RUN' && <span className="ml-1.5 text-[11px] text-warning-foreground dark:text-warning">draft</span>}</td>
                      {m.state ? (
                        <>
                          <td className="px-3 py-2 text-right num">{m.people}</td>
                          {['normal', 'ot'].map((k) => <td key={k} className="px-3 py-2 text-right num">{inr(m[k])}</td>)}
                          <td className="px-3 py-2 text-right num">{m.ot_hours}</td>
                          {['other', 'gross', 'employer', 'ctc', 'net'].map((k) => <td key={k} className={cn('px-3 py-2 text-right num', k === 'ctc' && 'font-semibold')}>{inr(m[k])}</td>)}
                        </>
                      ) : (
                        <td colSpan={9} className="px-3 py-2 text-[13px]">No payroll run</td>
                      )}
                    </tr>
                  ))}
                  <tr className="border-t-2 font-semibold">
                    <td className="px-3 py-2">Total</td>
                    <td className="px-3 py-2 text-right num">{d.totals.people}</td>
                    <td className="px-3 py-2 text-right num">{inr(d.totals.normal)}</td>
                    <td className="px-3 py-2 text-right num">{inr(d.totals.ot)}</td>
                    <td className="px-3 py-2 text-right num">{d.totals.ot_hours}</td>
                    {['other', 'gross', 'employer', 'ctc', 'net'].map((k) => <td key={k} className="px-3 py-2 text-right num">{inr(d.totals[k])}</td>)}
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
          )}
        </div>
      )}
    </div>
  );
}

/** The selected month's numbers: what it cost and how it splits. */
function MonthCard({ m }) {
  const parts = ['normal', 'ot', 'other', 'employer'].map((k) => ({ key: k, name: LABEL[k], value: m[k], fill: COLOR[k] }));
  return (
    <Card className="flex flex-col">
      <CardHeader title={m.label} description={m.state ? (m.state === 'RUN' ? 'Generated, not locked yet' : m.state === 'PAID' ? 'Paid' : 'Locked') : 'No payroll run'} />
      {m.state ? (
        <div className="flex flex-col gap-3 px-5 pb-5">
          <div>
            <div className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">Cost to company</div>
            <div className="text-[28px] leading-tight font-semibold num">{inr(m.ctc)}</div>
          </div>
          <div className="flex h-3 overflow-hidden rounded-full bg-muted" role="img" aria-label="How the cost splits">
            {parts.map((p) => <div key={p.key} style={{ width: `${(p.value / Math.max(1, m.ctc)) * 100}%`, background: p.fill }} className="border-r-2 border-card last:border-r-0" />)}
          </div>
          <ul className="flex flex-col gap-1.5 text-[14px]">
            {parts.map((p) => (
              <li key={p.key} className="flex items-center gap-2">
                <span className="size-2.5 rounded-sm" style={{ background: p.fill }} />
                <span className="flex-1">{p.name}</span>
                <span className="font-medium num">{inr(p.value)}</span>
              </li>
            ))}
          </ul>
          <dl className="grid grid-cols-2 gap-2 border-t pt-3 text-[13px]">
            <div><dt className="text-muted-foreground">Net pay</dt><dd className="font-semibold num">{inr(m.net)}</dd></div>
            <div><dt className="text-muted-foreground">Gross</dt><dd className="font-semibold num">{inr(m.gross)}</dd></div>
            <div><dt className="text-muted-foreground">OT hours</dt><dd className="font-semibold num">{m.ot_hours} h</dd></div>
            <div><dt className="text-muted-foreground">People paid</dt><dd className="font-semibold num">{m.people}</dd></div>
            <div><dt className="text-muted-foreground">Joiners</dt><dd className="font-semibold num">{m.joiners}</dd></div>
            <div><dt className="text-muted-foreground">Exits</dt><dd className="font-semibold num">{m.exits}</dd></div>
          </dl>
        </div>
      ) : (
        <p className="px-5 pb-5 text-[14px] text-muted-foreground">Run payroll for this month to see its figures.</p>
      )}
    </Card>
  );
}
