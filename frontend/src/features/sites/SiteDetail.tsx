import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Pie, PieChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { istTime, mins } from '@/lib/utils';
import { Mono, PageHeader, PersonLink, Stat } from '@/components/bits';
import { axis, CHART, grid, tooltipStyle } from '@/components/charts';
import { Chip, EmptyState, ErrorState, SkeletonBlock } from '@/components/states';
import { Card, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/form';

interface Day {
  site: { id: string; code: string; name: string; state: string; radius_m: number; project: { name: string } | null };
  date: string;
  today: { punched_in: number; on_site_now: number; worked_min: number; avg_min: number };
  on_site_now: { id: string; code: string; name: string; designation: string; since: string }[];
  people_per_day: { date: string; present: number }[];
  department_mix: { department: string; person_days: number }[];
  arrivals_by_hour: { hour: number; count: number }[];
  movement: { site_id: string; site_name: string; people: number; days: number }[];
  punches: { id: string; employee: { id: string; code: string; name: string }; direction: string; punched_at: string; method: string; match_score: number | null; distance_m: number | null; flagged: boolean; flag_reason: string | null }[];
}

export default function SiteDetail() {
  const { id } = useParams();
  const { data: lk } = useLookups();
  const [date, setDate] = useState(lk?.today ?? new Date().toISOString().slice(0, 10));
  const q = useQuery({ queryKey: ['site-day', id, date], queryFn: () => api.get<{ data: Day }>(`/sites/${id}/day`, { date }).then((r) => r.data) });
  if (q.isLoading) return <SkeletonBlock className="h-96" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        crumbs={[{ label: 'Sites', to: '/sites' }, { label: d.site.name }]}
        title={d.site.name}
        description={`${d.site.state} · ${d.site.radius_m} m boundary${d.site.project ? ` · project ${d.site.project.name}` : ''}`}
        meta={<Input type="date" className="w-40" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />}
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Punched in" value={d.today.punched_in} sub="different people" />
        <Stat label="On site now" value={d.today.on_site_now} sub="last punch is an IN here" tone="success" />
        <Stat label="Hours here" value={mins(d.today.worked_min)} />
        <Stat label="Average per person" value={mins(d.today.avg_min)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="People per day, 30 days" />
          <div className="p-3">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={d.people_per_day} margin={{ left: -18 }}>
                <CartesianGrid {...grid} />
                <XAxis dataKey="date" {...axis} tickFormatter={(v: string) => v.slice(8)} interval={3} />
                <YAxis {...axis} allowDecimals={false} />
                <Tooltip {...tooltipStyle} />
                <Bar dataKey="present" fill={CHART[0]} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card>
          <CardHeader title="Department mix, 30 days" description="By person-days" />
          <div className="p-3">
            {d.department_mix.length ? (
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={d.department_mix} dataKey="person_days" nameKey="department" innerRadius={45} outerRadius={75}>
                    {d.department_mix.map((_, i) => (
                      <Cell key={i} fill={CHART[i % CHART.length]} />
                    ))}
                  </Pie>
                  <Tooltip {...tooltipStyle} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <p className="py-8 text-center text-[13px] text-muted-foreground">No punches in 30 days.</p>
            )}
            <ul className="text-[12px]">
              {d.department_mix.map((m, i) => (
                <li key={m.department} className="flex items-center gap-2">
                  <span className="size-2 rounded-sm" style={{ background: CHART[i % CHART.length] }} /> {m.department} — {m.person_days}
                </li>
              ))}
            </ul>
          </div>
        </Card>
        <Card>
          <CardHeader title="Arrivals by hour" />
          <div className="p-3">
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={d.arrivals_by_hour} margin={{ left: -24 }}>
                <XAxis dataKey="hour" {...axis} />
                <YAxis {...axis} allowDecimals={false} />
                <Tooltip {...tooltipStyle} labelFormatter={(h: number) => `${h}:00–${h}:59`} />
                <Bar dataKey="count" fill={CHART[2]} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card>
          <CardHeader title="Movement, 14 days" description="People who worked here and at another site the same day" />
          <ul className="divide-y text-[13px]">
            {d.movement.map((m) => (
              <li key={m.site_id} className="flex justify-between px-4 py-2">
                <Link to={`/sites/${m.site_id}`} className="hover:underline">
                  {m.site_name}
                </Link>
                <span className="text-muted-foreground">
                  {m.people} people · {m.days} person-days
                </span>
              </li>
            ))}
            {!d.movement.length && <li className="px-4 py-6 text-center text-muted-foreground">No two-site days.</li>}
          </ul>
        </Card>
        <Card>
          <CardHeader title="On site now" />
          <ul className="divide-y text-[13px]">
            {d.on_site_now.map((p) => (
              <li key={p.id} className="flex justify-between px-4 py-1.5">
                <PersonLink id={p.id} name={p.name} code={p.code} />
                <span className="text-muted-foreground num">since {istTime(p.since)}</span>
              </li>
            ))}
            {!d.on_site_now.length && <li className="px-4 py-6 text-center text-muted-foreground">Nobody.</li>}
          </ul>
        </Card>
      </div>
      <Card>
        <CardHeader title="Punches" />
        {!d.punches.length ? (
          <EmptyState title="No punches" body="Punches from this site's tablet appear here." />
        ) : (
          <table className="data-table w-full">
            <thead>
              <tr>
                <th>Time</th>
                <th>Person</th>
                <th>Direction</th>
                <th>Method</th>
                <th className="text-right">Match</th>
                <th className="text-right">Distance</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.punches.map((p) => (
                <tr key={p.id}>
                  <td className="num">{istTime(p.punched_at)}</td>
                  <td>
                    <PersonLink id={p.employee.id} name={p.employee.name} code={p.employee.code} />
                  </td>
                  <td>{p.direction}</td>
                  <td>{p.method.toLowerCase()}</td>
                  <td className="text-right num">{p.match_score !== null ? `${Math.round(p.match_score * 100)}%` : '—'}</td>
                  <td className="text-right num">{p.distance_m !== null ? `${p.distance_m} m` : '—'}</td>
                  <td>{p.flagged && <Chip tone="warning" title={p.flag_reason ?? ''}>Flagged</Chip>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <p className="text-[12px] text-muted-foreground">
        Tablet login <Mono>{`site-${d.site.code.toLowerCase()}`}</Mono>. Distances are stored as metres from the centre — never a coordinate trail.
      </p>
    </div>
  );
}
