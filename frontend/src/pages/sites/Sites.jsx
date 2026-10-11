import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, ResponsiveContainer, Tooltip, YAxis } from 'recharts';
import { ArrowUpRight, Building2, Clock3, KeyRound, MapPin, Plus, Search, Users } from 'lucide-react';
import { api } from '@/services/api';
import { useSession } from '@/context/SessionContext';
import { mins } from '@/utils';
import { Mono, PageHeader } from '@/components/bits';
import { CHART, tooltipStyle } from '@/components/charts';
import { Chip, EmptyState, ErrorState, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { PasswordOnceDialog, ResetPasswordDialog, SiteFormDialog } from '@/components/sites/SiteForm';

export default function Sites() {
  const q = useQuery({ queryKey: ['sites'], queryFn: () => api.get('/sites').then((r) => r.data), refetchInterval: 60_000 });
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [creds, setCreds] = useState(null);
  const [resetting, setResetting] = useState(null);
  const { can } = useSession();
  const manage = can('sites.manage');
  const sites = q.data ?? [];
  const filtered = sites.filter((site) => [site.name, site.code, site.state, site.project?.name].some((value) => String(value ?? '').toLowerCase().includes(search.trim().toLowerCase())));
  const currentPeople = sites.reduce((sum, site) => sum + site.today.on_site_now, 0);
  const occupiedSites = sites.filter((site) => site.today.on_site_now > 0).length;
  const workedMinutes = sites.reduce((sum, site) => sum + site.today.worked_min, 0);
  const attendancePeak = Math.max(1, ...sites.flatMap((site) => site.sparkline.map((day) => day.present)));
  const dayLabel = (date) => new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Sites"
        description="See who is on site now. Open a site for attendance, overtime and wage costs."
        actions={
          manage && (
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add site
            </Button>
          )
        }
      />

      {q.isLoading ? (
        <div className="space-y-5" aria-label="Loading sites" aria-busy="true">
          <SkeletonBlock className="h-28" />
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }, (_, index) => <SkeletonBlock key={index} className="h-80" />)}
          </div>
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !sites.length ? (
        <Card>
          <EmptyState
            icon={<MapPin className="size-6" />}
            title="No sites yet"
            body="Add a site with its location, boundary and tablet login. The password is shown once."
            action={manage && <Button onClick={() => setAdding(true)}>Add site</Button>}
          />
        </Card>
      ) : (
        <>
          <Card className="grid gap-5 px-5 py-5 sm:grid-cols-3 sm:gap-6">
            <div className="flex items-center gap-3">
              <div className="rounded-lg bg-primary/10 p-3 text-primary"><Users className="size-5" /></div>
              <div>
                <div className="text-[12px] text-muted-foreground">On site now</div>
                <div className="num text-3xl font-semibold leading-tight">{currentPeople} <span className="text-[13px] font-normal text-muted-foreground">people</span></div>
              </div>
            </div>
            <div className="flex items-center gap-3 sm:border-l sm:pl-6">
              <div className="rounded-lg bg-muted p-3 text-muted-foreground"><Building2 className="size-5" /></div>
              <div>
                <div className="text-[12px] text-muted-foreground">Sites with people now</div>
                <div className="num text-2xl font-semibold leading-tight">{occupiedSites} <span className="text-[13px] font-normal text-muted-foreground">of {sites.length} sites</span></div>
              </div>
            </div>
            <div className="flex items-center gap-3 sm:border-l sm:pl-6">
              <div className="rounded-lg bg-muted p-3 text-muted-foreground"><Clock3 className="size-5" /></div>
              <div>
                <div className="text-[12px] text-muted-foreground">Completed hours today</div>
                <div className="num text-2xl font-semibold leading-tight">{mins(workedMinutes)}</div>
              </div>
            </div>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-xl font-semibold">Your sites</h2>
              <p className="mt-0.5 text-[13px] text-muted-foreground">{search.trim() ? `${filtered.length} of ${sites.length} sites` : `${sites.filter((site) => site.is_active).length} active sites`} · Headcounts refresh every minute</p>
            </div>
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input aria-label="Search sites" placeholder="Search sites or projects" value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" />
            </div>
          </div>

          {!filtered.length ? (
            <Card><EmptyState icon={<Search className="size-6" />} title="No sites match" body="Try another site name, code or project." action={<Button variant="outline" onClick={() => setSearch('')}>Clear search</Button>} /></Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filtered.map((s) => (
                <Card key={s.id} className="group flex min-w-0 flex-col overflow-hidden transition-shadow hover:shadow-md">
                  <Link to={`/sites/${s.id}`} aria-label={`Open ${s.name}`} className="flex-1 p-5 transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="font-display text-[20px] font-semibold leading-snug">{s.name}</h3>
                        <div className="mt-1 text-[12px] text-muted-foreground"><Mono>{s.code}</Mono>{s.state && ` · ${s.state}`}</div>
                      </div>
                      <ArrowUpRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
                    </div>
                    <div className="mt-5 flex items-end justify-between gap-3">
                      <div>
                        <div className="num text-[38px] font-semibold leading-none text-primary">{s.today.on_site_now}</div>
                        <div className="mt-1.5 text-[13px] text-muted-foreground">people on site now</div>
                      </div>
                      {!s.is_active ? <Chip tone="muted">Inactive</Chip> : !s.login_enabled ? <Chip tone="warning">Login disabled</Chip> : <Chip tone="success">Active</Chip>}
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3 rounded-md bg-muted/50 px-3 py-2.5">
                      <div><div className="num text-[17px] font-semibold">{s.today.punched_in}</div><div className="text-[12px] text-muted-foreground">In today</div></div>
                      <div className="border-l pl-3"><div className="num text-[17px] font-semibold">{mins(s.today.worked_min)}</div><div className="text-[12px] text-muted-foreground">Completed hours</div></div>
                    </div>
                    <div className="mt-4 flex items-center justify-between text-[12px] text-muted-foreground"><span>Attendance</span><span>Last 14 days</span></div>
                    <div className="relative mt-2 h-16 border-b" role="img" aria-label={`${s.name}: daily attendance over the last 14 days. ${s.sparkline.map((day) => `${dayLabel(day.date)}: ${day.present}`).join('; ')}`}>
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={s.sparkline} margin={{ top: 2, right: 0, bottom: 0, left: 0 }} barCategoryGap="22%">
                          <YAxis hide domain={[0, attendancePeak]} />
                          <Tooltip {...tooltipStyle} labelFormatter={(_label, payload) => payload?.[0]?.payload?.date ? dayLabel(payload[0].payload.date) : ''} formatter={(value) => [value, 'People in']} cursor={{ fill: 'var(--muted)' }} />
                          <Bar dataKey="present" fill={CHART[0]} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                        </BarChart>
                      </ResponsiveContainer>
                      {!s.sparkline.some((day) => day.present > 0) && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-muted-foreground">No attendance recorded</div>}
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground"><span>{s.sparkline[0] && dayLabel(s.sparkline[0].date)}</span><span>{s.sparkline.at(-1) && dayLabel(s.sparkline.at(-1).date)}</span></div>
                    {s.project && <div className="mt-3 truncate text-[12px] text-muted-foreground">{s.project.name}</div>}
                  </Link>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t px-5 py-2 text-[12px]">
                    <Mono className="text-muted-foreground">{s.login}</Mono>
                    {manage && <Button size="sm" variant="ghost" onClick={() => setResetting(s)}><KeyRound /> Reset password</Button>}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
      {adding && <SiteFormDialog onClose={() => setAdding(false)} onCreated={setCreds} />}
      {resetting && (
        <ResetPasswordDialog
          site={resetting}
          onClose={() => setResetting(null)}
          onDone={(c) => {
            setResetting(null);
            setCreds(c);
          }}
        />
      )}
      {creds && <PasswordOnceDialog creds={creds} onClose={() => setCreds(null)} />}
    </div>
  );
}
