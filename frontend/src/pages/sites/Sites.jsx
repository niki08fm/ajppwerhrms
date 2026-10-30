import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Building2, Loader2, MapPin, Plus, Search, Users } from 'lucide-react';
import { api } from '@/services/api';
import { useSession } from '@/context/SessionContext';
import { Mono, PageHeader } from '@/components/bits';
import { CHART } from '@/components/charts';
import { Chip, EmptyState, ErrorState, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/form';
import { PasswordOnceDialog, SiteFormDialog } from '@/components/sites/SiteForm';

export default function Sites() {
  const q = useQuery({ queryKey: ['sites'], queryFn: () => api.get('/sites').then((r) => r.data), refetchInterval: 60_000 });
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [creds, setCreds] = useState(null);
  const { can } = useSession();
  const manage = can('sites.manage');
  const sites = q.data ?? [];
  const filtered = sites.filter((site) => [site.name, site.code, site.state, site.project?.name].some((value) => String(value ?? '').toLowerCase().includes(search.trim().toLowerCase())));
  const currentPeople = sites.reduce((sum, site) => sum + site.today.on_site_now, 0);
  const occupiedSites = sites.filter((site) => site.today.on_site_now > 0).length;
  const siteColours = new Map(sites.map((site, index) => [site.id, CHART[index % CHART.length]]));
  const liveLabel = q.isFetching ? 'Updating' : q.isError ? 'Could not refresh' : 'Live';
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
          <Card className="flex flex-wrap items-center justify-between gap-5 px-5 py-5 sm:px-6">
            <div className="flex items-center gap-3">
              <div className="rounded-xl bg-primary/10 p-3 text-primary"><Users className="size-5" /></div>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-muted-foreground">Across all sites</div>
                <div className="num text-3xl font-semibold leading-tight">{currentPeople} <span className="text-[14px] font-normal text-muted-foreground">people on site now</span></div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-muted-foreground">
              <span className="inline-flex items-center gap-2"><Building2 className="size-4" />{occupiedSites} of {sites.length} sites with people</span>
              <span className="inline-flex items-center gap-1.5 text-primary" role="status">{q.isFetching ? <Loader2 className="size-3 animate-spin" /> : !q.isError && <span className="size-1.5 rounded-full bg-primary" />}{liveLabel}</span>
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
                <Card key={s.id} className="group flex min-w-0 flex-col overflow-hidden border-t-2 transition-shadow hover:shadow-md" style={{ borderTopColor: siteColours.get(s.id) }}>
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
                        <div className="num text-[36px] font-semibold leading-none">{s.today.on_site_now}</div>
                        <div className="mt-1.5 text-[13px] text-muted-foreground">people on site now</div>
                      </div>
                      {!s.is_active ? <Chip tone="muted">Inactive</Chip> : !s.login_enabled ? <Chip tone="warning">Login disabled</Chip> : <Chip tone="success">Active</Chip>}
                    </div>
                    <div className="mt-5 flex items-center justify-between gap-3 border-t pt-3 text-[12px] text-muted-foreground"><span><span className="num font-semibold text-foreground">{s.today.punched_in}</span> in today</span><span className="inline-flex items-center gap-1 text-primary">Open site <ArrowUpRight className="size-3.5" /></span></div>
                    {s.project && <div className="mt-2 truncate text-[12px] text-muted-foreground">{s.project.name}</div>}
                  </Link>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
      {adding && <SiteFormDialog onClose={() => setAdding(false)} onCreated={setCreds} />}
      {creds && <PasswordOnceDialog creds={creds} onClose={() => setCreds(null)} />}
    </div>
  );
}
