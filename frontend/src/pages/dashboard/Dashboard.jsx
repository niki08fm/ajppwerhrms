import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { DAY_STATUS_LABELS } from '@ajpwer/shared';
import { api } from '@/services/api';
import { mins, monthLabel } from '@/utils';
import { PageHeader, PersonLink, Stat } from '@/components/bits';
import { axis, CHART, grid, QueryCard, rupeesShort, tooltipStyle } from '@/components/charts';
import { SiteNetwork } from '@/components/network';
import { Chip, ErrorState, SkeletonBlock } from '@/components/states';
import { Card } from '@/components/ui/card';

function TodayTiles() {
  const q = useQuery({ queryKey: ['dashboard', 'today'], queryFn: () => api.get('/dashboard/today').then((r) => r.data), refetchInterval: 60_000 });
  if (q.isLoading)
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonBlock key={i} className="h-[76px]" />
        ))}
      </div>
    );
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} compact />;
  const t = q.data;
  const d = `/attendance?date=${t.date}`;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Stat label="Headcount" value={t.headcount} sub={`${t.off} on an off day`} to="/people?status=ACTIVE" />
      <Stat label="Present" value={t.present} sub={`${t.on_site_now} on site now`} tone="success" to={d} />
      <Stat label="Absent" value={t.absent} tone={t.absent ? 'destructive' : undefined} sub={t.missing_punch ? `${t.missing_punch} missing a punch` : undefined} to={`${d}&status=ABSENT`} />
      <Stat label="Late" value={t.late} tone={t.late ? 'warning' : undefined} to={`${d}&late=yes`} />
      <Stat label="On leave" value={t.on_leave} to={`${d}&status=ON_LEAVE`} />
      <Stat label="Overtime today" value={mins(t.ot_min)} to="/overtime" />
    </div>
  );
}

export default function Dashboard() {
  const network = useQuery({ queryKey: ['sites-network'], queryFn: () => api.get('/sites-network').then((r) => r.data) });
  const matrix = useQuery({ queryKey: ['dashboard', 'matrix'], queryFn: () => api.get('/dashboard/matrix').then((r) => r.data) });
  const trend = useQuery({ queryKey: ['dashboard', 'trend'], queryFn: () => api.get('/dashboard/trend').then((r) => r.data) });
  const mix = useQuery({ queryKey: ['dashboard', 'mix'], queryFn: () => api.get('/dashboard/status-mix').then((r) => r.data) });
  const net = useQuery({ queryKey: ['dashboard', 'net'], queryFn: () => api.get('/dashboard/net-by-month').then((r) => r.data) });
  const people = useQuery({
    queryKey: ['dashboard', 'people'],
    queryFn: () => api.get('/dashboard/people').then((r) => r.data),
  });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Today" description="The morning glance: who is in, where, and what needs attention." />
      <TodayTiles />
      {people.data && (people.data.held_back.length > 0 || people.data.approvals.face + people.data.approvals.leave > 0) && (
        <div className="flex flex-wrap gap-2 text-[13px]">
          {people.data.approvals.face > 0 && (
            <Link to="/approvals" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 hover:bg-warning/20">
              {people.data.approvals.face} face exception{people.data.approvals.face > 1 ? 's' : ''} waiting
            </Link>
          )}
          {people.data.approvals.leave > 0 && (
            <Link to="/approvals" className="rounded-md border border-info/30 bg-info/10 px-3 py-1.5 hover:bg-info/20">
              {people.data.approvals.leave} leave request{people.data.approvals.leave > 1 ? 's' : ''} pending
            </Link>
          )}
          {people.data.held_back.length > 0 && (
            <span className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5">
              {people.data.held_back.length} held back from payroll and not yet paid:{' '}
              {people.data.held_back.slice(0, 3).map((h, i) => (
                <span key={h.id}>
                  {i > 0 && ', '}
                  <PersonLink id={h.employee.id} name={h.employee.name} /> ({monthLabel(h.period_ym)})
                </span>
              ))}
            </span>
          )}
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-5">
        <QueryCard
          className="xl:col-span-3"
          title="Site network"
          description="Circle size is today's punch-ins; the ring is the department mix; arrows are people who worked two sites in a day over the last seven days."
          query={network}
        >
          {(d) => <SiteNetwork nodes={d.nodes} edges={d.edges} />}
        </QueryCard>
        <QueryCard className="xl:col-span-2" title="Department by site, today" description="Distinct people who punched at each site." query={matrix}>
          {(rows) => {
            const sites = [...new Map(rows.map((r) => [r.site_id, r.site])).entries()];
            const depts = [...new Set(rows.map((r) => r.department))];
            if (!rows.length) return <p className="py-10 text-center text-[13px] text-muted-foreground">No punches yet today.</p>;
            const max = Math.max(...rows.map((r) => r.people));
            return (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr>
                      <th className="px-2 py-1 text-left font-medium text-muted-foreground">Department</th>
                      {sites.map(([id, name]) => (
                        <th key={id} className="px-2 py-1 text-right font-medium text-muted-foreground">
                          <Link to={`/sites/${id}`} className="hover:underline">
                            {name}
                          </Link>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {depts.map((d) => (
                      <tr key={d} className="border-t">
                        <td className="px-2 py-1.5">{d}</td>
                        {sites.map(([id]) => {
                          const v = rows.find((r) => r.department === d && r.site_id === id)?.people ?? 0;
                          return (
                            <td
                              key={id}
                              className="px-2 py-1.5 text-right num"
                              style={{ background: v ? `color-mix(in oklch, var(--chart-1) ${Math.round((v / max) * 35)}%, transparent)` : undefined }}
                            >
                              {v || '·'}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }}
        </QueryCard>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <QueryCard title="Attendance, 30 days" description="Present as a share of headcount in employment." query={trend}>
          {(rows) => (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={rows} margin={{ left: -18, right: 8, top: 6 }}>
                <CartesianGrid {...grid} />
                <XAxis dataKey="date" {...axis} tickFormatter={(d) => d.slice(8)} interval={4} />
                <YAxis {...axis} domain={[0, 100]} unit="%" />
                <Tooltip {...tooltipStyle} formatter={(v) => [`${v}%`, 'Present']} />
                <Area dataKey="rate" stroke={CHART[0]} fill={CHART[0]} fillOpacity={0.15} strokeWidth={2} connectNulls />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </QueryCard>
        <QueryCard title="This month by status" description="Person-days so far." query={mix}>
          {(d) => {
            const data = Object.entries(d.mix)
              .map(([k, v]) => ({ status: DAY_STATUS_LABELS[k] ?? k, days: v }))
              .sort((a, b) => b.days - a.days);
            return (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={data} layout="vertical" margin={{ left: 30, right: 12 }}>
                  <XAxis type="number" {...axis} />
                  <YAxis type="category" dataKey="status" {...axis} width={90} />
                  <Tooltip {...tooltipStyle} />
                  <Bar dataKey="days" fill={CHART[2]} radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            );
          }}
        </QueryCard>
        <QueryCard title="Net pay by month" description="From payroll snapshots." query={net}>
          {(rows) =>
            rows.length ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={rows} margin={{ left: -6, right: 8 }}>
                  <CartesianGrid {...grid} />
                  <XAxis dataKey="period_ym" {...axis} tickFormatter={(v) => monthLabel(v).slice(0, 3)} />
                  <YAxis {...axis} tickFormatter={rupeesShort} />
                  <Tooltip {...tooltipStyle} formatter={(v) => [rupeesShort(v), 'Net']} labelFormatter={(l) => monthLabel(l)} />
                  <Bar dataKey="net" fill={CHART[0]} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="py-10 text-center text-[13px] text-muted-foreground">No payroll has been run yet.</p>
            )
          }
        </QueryCard>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <QueryCard
          title="Hiring pipeline"
          query={people}
          actions={
            <Link to="/offers" className="text-[12px] text-primary hover:underline">
              Open
            </Link>
          }
        >
          {(d) => (
            <div className="grid grid-cols-3 gap-3">
              {['OFFER', 'ACCEPTED', 'ONBOARDING'].map((s) => (
                <Card key={s} className="px-3 py-2">
                  <div className="text-[12px] text-muted-foreground">{s === 'OFFER' ? 'Offered' : s === 'ACCEPTED' ? 'Accepted' : 'Onboarding'}</div>
                  <div className="font-display text-2xl font-semibold num">{d.pipeline[s] ?? 0}</div>
                </Card>
              ))}
            </div>
          )}
        </QueryCard>
        <QueryCard
          title="Leavers"
          description="On notice, by last day."
          query={people}
          actions={
            <Link to="/exits" className="text-[12px] text-primary hover:underline">
              Open
            </Link>
          }
        >
          {(d) =>
            d.leavers.length ? (
              <ul className="divide-y text-[13px]">
                {d.leavers.map((l) => (
                  <li key={l.id} className="flex items-center justify-between py-1.5">
                    <PersonLink id={l.id} name={l.name} code={l.code} tab="exit" />
                    <Chip tone="warning">Last day {l.last_day}</Chip>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-6 text-center text-[13px] text-muted-foreground">Nobody is on notice.</p>
            )
          }
        </QueryCard>
      </div>
    </div>
  );
}
