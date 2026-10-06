import React, { useId, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '@/services/api';

const RANGES = [{ days: 90, label: 'Last 3 months' }, { days: 30, label: 'Last 30 days' }, { days: 7, label: 'Last 7 days' }];
const shift = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const shortDate = (date) => new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));

function AttendanceTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return <div className="attendance-hover"><strong>{shortDate(label)}</strong>{payload.map((item) => <div key={item.dataKey}><span className="attendance-key" style={{ background: item.color }} /><span>{item.name}</span><b>{item.value}</b></div>)}</div>;
}

export default function AttendanceChartPreview({ d, site, siteName }) {
  const [range, setRange] = useState(30);
  const id = useId().replaceAll(':', '');
  const start = shift(d.date, 1 - range);
  const months = useMemo(() => [...new Set(Array.from({ length: range }, (_, i) => shift(start, i).slice(0, 7)))], [start, range]);
  const queries = useQueries({ queries: months.map((ym) => ({ queryKey: ['dashboard', 'month', ym], queryFn: () => api.get('/dashboard/month', { ym }).then((r) => r.data), staleTime: 60_000 })) });
  const loading = queries.some((q) => q.isLoading);
  const failed = queries.some((q) => q.isError);
  const series = [{ key: 'present', name: site ? siteName(site) : 'Overall attendance', colour: '#168d82' }];
  // Use the company aggregate, never a sum of site counts: a worker may visit two sites.
  const rows = queries.flatMap((q) => q.data?.days ?? []).filter((day) => !day.future && day.date >= start && day.date <= d.date).sort((a, b) => a.date.localeCompare(b.date)).map((day) => ({ date: day.date, present: site ? day.sites[site] ?? 0 : day.present }));
  return <section className="attendance-chart-card" aria-labelledby="attendance-chart-title">
    <header className="attendance-chart-header"><div><h3 id="attendance-chart-title">Attendance</h3><p>{site ? siteName(site) : 'Overall attendance · all sites'} · {shortDate(start)} – {shortDate(d.date)}</p></div><div className="attendance-range" role="group" aria-label="Attendance date range">{RANGES.map((option) => <button key={option.days} type="button" aria-pressed={range === option.days} onClick={() => setRange(option.days)}>{option.label}</button>)}</div></header>
    {loading ? <div className="attendance-chart-message" role="status">Loading attendance…</div> : failed ? <div className="attendance-chart-message" role="alert">Could not load attendance. <button type="button" onClick={() => queries.filter((q) => q.isError).forEach((q) => q.refetch())}>Try again</button></div> : !rows.length || !series.length ? <div className="attendance-chart-message">No attendance in this selection.</div> : <>
      <div className="attendance-chart-plot" aria-label={`${range} day attendance chart, ${rows.length} recorded days`}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 24, right: 18, left: 0, bottom: 10 }} accessibilityLayer>
            <defs>{series.map((s) => <linearGradient key={s.key} id={`${id}-${s.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={s.colour} stopOpacity={0.48}/><stop offset="100%" stopColor={s.colour} stopOpacity={0.04}/></linearGradient>)}</defs>
            <CartesianGrid vertical={false} stroke="var(--preview-border)" strokeOpacity={0.75}/>
            <XAxis dataKey="date" tickFormatter={shortDate} tickLine={false} axisLine={false} minTickGap={32} tickMargin={14} stroke="var(--preview-muted)" fontSize={12}/>
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} stroke="var(--preview-muted)" fontSize={11}/>
            <Tooltip content={<AttendanceTooltip/>} cursor={{ stroke: 'var(--preview-muted)', strokeDasharray: '3 4', strokeOpacity: 0.4 }}/>
            {series.map((s) => <Area key={s.key} type="monotone" name={s.name} dataKey={s.key} stroke={s.colour} strokeWidth={1.8} fill={`url(#${id}-${s.key})`} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--preview-paper)' }} isAnimationActive={false} />)}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <footer className="attendance-chart-legend">{series.map((s) => <span key={s.key}><i style={{ background: s.colour }}/>{s.name}</span>)}<small>{site ? 'People who punched in at this site' : 'Company attendance · people counted once per day'}</small></footer>
      <details className="attendance-chart-data"><summary>View daily counts</summary><div><table><thead><tr><th scope="col">Date</th>{series.map((s) => <th scope="col" key={s.key}>{s.name}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.date}><th scope="row">{shortDate(row.date)}</th>{series.map((s) => <td key={s.key}>{row[s.key]}</td>)}</tr>)}</tbody></table></div></details>
    </>}
  </section>;
}
