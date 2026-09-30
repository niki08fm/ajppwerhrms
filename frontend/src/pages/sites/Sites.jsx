import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Line, LineChart, ResponsiveContainer } from 'recharts';
import { KeyRound, MapPin, Plus } from 'lucide-react';
import { api } from '@/services/api';
import { useSession } from '@/context/SessionContext';
import { mins } from '@/utils';
import { Mono, PageHeader } from '@/components/bits';
import { CHART, QueryCard } from '@/components/charts';
import { SiteNetwork } from '@/components/network';
import { Chip, EmptyState, ErrorState, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PasswordOnceDialog, ResetPasswordDialog, SiteFormDialog } from '@/components/sites/SiteForm';

export default function Sites() {
  const q = useQuery({ queryKey: ['sites'], queryFn: () => api.get('/sites').then((r) => r.data) });
  const network = useQuery({ queryKey: ['sites-network'], queryFn: () => api.get('/sites-network').then((r) => r.data) });
  const [adding, setAdding] = useState(false);
  const [creds, setCreds] = useState(null);
  const [resetting, setResetting] = useState(null);
  const { can } = useSession();
  const manage = can('sites.manage');
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Sites"
        description="A site is a place with a boundary and a login — not a group of people. Everything here is derived from punches."
        actions={
          manage && (
            <Button onClick={() => setAdding(true)}>
              <Plus /> Add site
            </Button>
          )
        }
      />

      <QueryCard title="Network" description="Arrows are people who worked two sites in one day over the last seven days." query={network}>
        {(d) => <SiteNetwork nodes={d.nodes} edges={d.edges} />}
      </QueryCard>
      {q.isLoading ? (
        <SkeletonBlock className="h-48" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data.length ? (
        <Card>
          <EmptyState
            icon={<MapPin className="size-6" />}
            title="No sites yet"
            body="Add a site with its location, boundary and tablet login. The password is shown once."
            action={manage && <Button onClick={() => setAdding(true)}>Add site</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {q.data.map((s) => (
            <Card key={s.id} className="flex flex-col">
              <Link to={`/sites/${s.id}`} className="flex-1 p-4 hover:bg-accent/40">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-display text-[15px] font-semibold">{s.name}</div>
                    <div className="text-[12px] text-muted-foreground">
                      <Mono>{s.code}</Mono> · {s.state} · {s.radius_m} m
                    </div>
                  </div>
                  {!s.is_active ? <Chip tone="muted">Inactive</Chip> : !s.login_enabled && <Chip tone="warning">Login disabled</Chip>}
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="font-display text-xl font-semibold num">{s.today.on_site_now}</div>
                    <div className="text-[11px] text-muted-foreground">on site now</div>
                  </div>
                  <div>
                    <div className="font-display text-xl font-semibold num">{s.today.punched_in}</div>
                    <div className="text-[11px] text-muted-foreground">in today</div>
                  </div>
                  <div>
                    <div className="font-display text-xl font-semibold num">{mins(s.today.worked_min)}</div>
                    <div className="text-[11px] text-muted-foreground">hours here</div>
                  </div>
                </div>
                <div className="mt-2 h-10" aria-label="People per day over 14 days">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={s.sparkline}>
                      <Line dataKey="present" stroke={CHART[0]} strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-1 text-[12px] text-muted-foreground">{s.project ? `Project ${s.project.name}` : 'No project'}</div>
              </Link>
              <div className="flex items-center justify-between border-t px-4 py-2 text-[12px]">
                <Mono className="text-muted-foreground">{s.login}</Mono>
                {manage && (
                  <Button size="sm" variant="ghost" onClick={() => setResetting(s)}>
                    <KeyRound /> Reset password
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
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
