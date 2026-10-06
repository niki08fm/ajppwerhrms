import { useId, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { addDays } from '@ajpwer/shared';
import { api } from '@/services/api';
import './AttendanceChart.css';

const RANGES = [
  { days: 90, label: 'Last 3 months' },
  { days: 30, label: 'Last 30 days' },
  { days: 7, label: 'Last 7 days' },
];
const shortDate = (date) => new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
const COLOUR = 'var(--chart-1)';

function AttendanceTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const point = payload[0];
  return (
    <div className="attendance-hover">
      <strong>{shortDate(label)}</strong>
      <div>
        <span className="attendance-key" style={{ background: COLOUR }} />
        <span>{point.name}</span>
        <b className="num">{point.value}</b>
      </div>
    </div>
  );
}

/** One attendance series: the company aggregate, or the selected site's counts. */
export default function AttendanceChart({ d, site, siteName }) {
  const [range, setRange] = useState(30);
  const gradientId = `attendance-${useId().replaceAll(':', '')}`;
  const start = addDays(d.date, 1 - range);
  const months = useMemo(
    () => [...new Set(Array.from({ length: range }, (_, i) => addDays(start, i).slice(0, 7)))],
    [start, range],
  );
  const queries = useQueries({
    queries: months.map((ym) => ({
      queryKey: ['dashboard', 'month', ym],
      queryFn: () => api.get('/dashboard/month', { ym }).then((r) => r.data),
      staleTime: 60_000,
      refetchInterval: d.is_today && ym === d.today.slice(0, 7) ? 60_000 : false,
    })),
  });
  const loading = queries.some((q) => q.isLoading);
  const failed = queries.some((q) => q.isError);
  const name = site ? siteName(site) : 'Overall attendance';
  // Site totals can overlap when someone moves. The overall series counts each person once.
  const rows = queries
    .flatMap((q) => q.data?.days ?? [])
    .filter((day) => !day.future && day.date >= start && day.date <= d.date)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => ({ date: day.date, present: site ? day.sites?.[site] ?? 0 : day.present }));

  return (
    <section className="attendance-chart-card" aria-labelledby="attendance-chart-title">
      <header className="attendance-chart-header">
        <div>
          <h3 id="attendance-chart-title">Attendance</h3>
          <p>{site ? name : 'Overall attendance · all sites'} · {shortDate(start)} – {shortDate(d.date)}</p>
        </div>
        <div className="attendance-range" role="group" aria-label="Attendance date range">
          {RANGES.map((option) => (
            <button key={option.days} type="button" aria-pressed={range === option.days} onClick={() => setRange(option.days)}>
              {option.label}
            </button>
          ))}
        </div>
      </header>
      {loading ? (
        <div className="attendance-chart-message" role="status">Loading attendance…</div>
      ) : failed ? (
        <div className="attendance-chart-message" role="alert">
          Could not load attendance.
          <button type="button" onClick={() => queries.filter((q) => q.isError).forEach((q) => q.refetch())}>Try again</button>
        </div>
      ) : !rows.length ? (
        <div className="attendance-chart-message">No attendance in this selection.</div>
      ) : (
        <>
          <div className="attendance-chart-plot" aria-label={`${range} day attendance chart, ${rows.length} recorded days`}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={rows} margin={{ top: 24, right: 18, left: 0, bottom: 10 }} accessibilityLayer>
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={COLOUR} stopOpacity={0.48} />
                    <stop offset="100%" stopColor={COLOUR} stopOpacity={0.04} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.75} />
                <XAxis dataKey="date" tickFormatter={shortDate} tickLine={false} axisLine={false} minTickGap={32} tickMargin={14} stroke="var(--muted-foreground)" fontSize={12} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={32} stroke="var(--muted-foreground)" fontSize={11} />
                <Tooltip content={<AttendanceTooltip />} cursor={{ stroke: 'var(--muted-foreground)', strokeDasharray: '3 4', strokeOpacity: 0.4 }} />
                <Area type="monotone" name={name} dataKey="present" stroke={COLOUR} strokeWidth={1.8} fill={`url(#${gradientId})`} dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--card)' }} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <footer className="attendance-chart-legend">
            <span><i style={{ background: COLOUR }} />{name}</span>
            <small>{site ? 'People who punched in at this site' : 'Company attendance · people counted once per day'}</small>
          </footer>
          <details className="attendance-chart-data">
            <summary>View daily counts</summary>
            <div>
              <table>
                <thead><tr><th scope="col">Date</th><th scope="col">{name}</th></tr></thead>
                <tbody>
                  {rows.map((row) => <tr key={row.date}><th scope="row">{shortDate(row.date)}</th><td className="num">{row.present}</td></tr>)}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
