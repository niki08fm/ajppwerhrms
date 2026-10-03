import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Power } from 'lucide-react';
import { toast } from 'sonner';
import { Bar, BarChart, CartesianGrid, Pie, PieChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, errorMessage } from '@/services/api';
import { useSession } from '@/context/SessionContext';
import { useLookups } from '@/hooks/useLookups';
import { istTime, mins } from '@/utils';
import { Mono, PageHeader, PersonLink, Stat } from '@/components/bits';
import { axis, CHART, grid, tooltipStyle } from '@/components/charts';
import { Chip, EmptyState, ErrorState, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { PasswordOnceDialog, ResetPasswordDialog, SiteFormDialog } from '@/components/sites/SiteForm';

export default function SiteDetail() {
  const { id } = useParams();
  const { data: lk } = useLookups();
  const [date, setDate] = useState(lk?.today ?? new Date().toISOString().slice(0, 10));
  const q = useQuery({ queryKey: ['site-day', id, date], queryFn: () => api.get(`/sites/${id}/day`, { date }).then((r) => r.data) });
  const { can } = useSession();
  const [editing, setEditing] = useState(false);
  if (q.isLoading) return <SkeletonBlock className="h-96" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        crumbs={[{ label: 'Sites', to: '/sites' }, { label: d.site.name }]}
        title={d.site.name}
        description={`${d.site.address ? `${d.site.address} · ` : ''}${d.site.state} · ${d.site.radius_m} m boundary${d.site.project ? ` · project ${d.site.project.name}` : ''}`}
        meta={<Input type="date" className="w-40" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />}
        actions={
          can('sites.manage') && (
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil /> Edit site
            </Button>
          )
        }
      />
      {editing && <SiteFormDialog site={d.site} onClose={() => setEditing(false)} />}

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
                <XAxis dataKey="date" {...axis} tickFormatter={(v) => v.slice(8)} interval={3} />
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
              <p className="py-8 text-center text-[14px] text-muted-foreground">No punches in 30 days.</p>
            )}
            <ul className="text-[13px]">
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
                <Tooltip {...tooltipStyle} labelFormatter={(h) => `${h}:00–${h}:59`} />
                <Bar dataKey="count" fill={CHART[2]} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card>
          <CardHeader title="Movement, 14 days" description="People who worked here and at another site the same day" />
          <ul className="divide-y text-[14px]">
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
          <ul className="divide-y text-[14px]">
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
          <div className="overflow-x-auto"><table className="data-table w-full">
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
                  <td>
                    {p.flagged && (
                      <Chip tone="warning" title={p.flag_reason ?? ''}>
                        Flagged
                      </Chip>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
      <TabletLogin site={d.site} manage={can('sites.manage')} />
      <p className="text-[13px] text-muted-foreground">
        Centre <span className="num">{d.site.lat.toFixed(6)}, {d.site.lng.toFixed(6)}</span>. Distances are stored as metres from the centre — never a coordinate trail.
      </p>
    </div>
  );
}

/** Login ID, last sign-in, whether a tablet is signed in; reset the password, disable or enable the login. */
function TabletLogin({ site, manage }) {
  const qc = useQueryClient();
  const [resetting, setResetting] = useState(false);
  const [creds, setCreds] = useState(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const toggle = useMutation({
    mutationFn: (enabled) => api.post(`/sites/${site.id}/login-enabled`, { enabled }),
    onSuccess: (r) => {
      setConfirmOff(false);
      qc.invalidateQueries({ queryKey: ['site-day', site.id] });
      qc.invalidateQueries({ queryKey: ['sites'] });
      toast.success(r.data.login_enabled ? 'Login enabled. The current password works again.' : 'Login disabled. Every tablet at this site has been signed out.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader
        title="Tablet login"
        description="The tablet signs in at /tablet with this login ID, only inside the site's boundary. Forgotten passwords are reset here; the tablet cannot change its own."
        actions={
          manage && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setResetting(true)}>
                <KeyRound /> Reset password
              </Button>
              {site.login_enabled ? (
                <Button size="sm" variant="outline" onClick={() => setConfirmOff(true)}>
                  <Power /> Disable login
                </Button>
              ) : (
                <Button size="sm" variant="outline" loading={toggle.isPending} onClick={() => toggle.mutate(true)}>
                  <Power /> Enable login
                </Button>
              )}
            </div>
          )
        }
      />
      <dl className="grid grid-cols-2 gap-3 p-4 text-[14px] md:grid-cols-4">
        <div>
          <dt className="text-[13px] text-muted-foreground">Login ID</dt>
          <dd>
            <Mono>{site.login}</Mono>
          </dd>
        </div>
        <div>
          <dt className="text-[13px] text-muted-foreground">Login</dt>
          <dd>{site.login_enabled ? <Chip tone="success">Enabled</Chip> : <Chip tone="warning">Disabled</Chip>}</dd>
        </div>
        <div>
          <dt className="text-[13px] text-muted-foreground">Last sign-in</dt>
          <dd className="num">{site.last_login_at ? istTime(site.last_login_at, true) : 'Never'}</dd>
        </div>
        <div>
          <dt className="text-[13px] text-muted-foreground">Tablet signed in now</dt>
          <dd>{site.tablet_signed_in ? <Chip tone="success">Yes</Chip> : <Chip tone="muted">No</Chip>}</dd>
        </div>
      </dl>
      {resetting && (
        <ResetPasswordDialog
          site={site}
          onClose={() => setResetting(false)}
          onDone={(c) => {
            setResetting(false);
            setCreds(c);
          }}
        />
      )}
      {creds && <PasswordOnceDialog creds={creds} onClose={() => setCreds(null)} />}
      {confirmOff && (
        <Dialog
          open
          onOpenChange={(o) => !o && setConfirmOff(false)}
          title={`Disable the login for ${site.name}?`}
          description="Every tablet signed in to this site is signed out, and none can sign in until you enable the login again."
          footer={
            <>
              <Button variant="outline" onClick={() => setConfirmOff(false)}>
                Cancel
              </Button>
              <Button variant="destructive" loading={toggle.isPending} onClick={() => toggle.mutate(false)}>
                Disable login
              </Button>
            </>
          }
        />
      )}
    </Card>
  );
}
