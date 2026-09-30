import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Line, LineChart, ResponsiveContainer } from 'recharts';
import { KeyRound, MapPin, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { mins } from '@/utils';
import { Mono, PageHeader } from '@/components/bits';
import { CHART, QueryCard } from '@/components/charts';
import { SiteNetwork } from '@/components/network';
import { Chip, EmptyState, ErrorState, Notice, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';

export default function Sites() {
  const q = useQuery({ queryKey: ['sites'], queryFn: () => api.get('/sites').then((r) => r.data) });
  const network = useQuery({ queryKey: ['sites-network'], queryFn: () => api.get('/sites-network').then((r) => r.data) });
  const [adding, setAdding] = useState(false);
  const [creds, setCreds] = useState(null);
  const qc = useQueryClient();
  const reissue = useMutation({
    mutationFn: (id) => api.post(`/sites/${id}/reissue-login`),
    onSuccess: (r) => setCreds(r.data),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Sites"
        description="A site is a place with a boundary and a login — not a group of people. Everything here is derived from punches."
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus /> Add site
          </Button>
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
            body="Add a site with its boundary. Its tablet login is generated and shown once."
            action={<Button onClick={() => setAdding(true)}>Add site</Button>}
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
                  {!s.is_active && <Chip tone="muted">Inactive</Chip>}
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
                <Button size="sm" variant="ghost" loading={reissue.isPending && reissue.variables === s.id} onClick={() => reissue.mutate(s.id)}>
                  <KeyRound /> Reissue login
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
      {adding && (
        <AddSite
          onClose={() => setAdding(false)}
          onCreated={(c) => {
            setCreds(c);
            qc.invalidateQueries({ queryKey: ['sites'] });
          }}
        />
      )}
      {creds && (
        <Dialog open onOpenChange={(o) => !o && setCreds(null)} title="Tablet login" description={creds.note} footer={<Button onClick={() => setCreds(null)}>I have copied it</Button>}>
          <div className="flex flex-col gap-2 text-[14px]">
            <div>
              Login: <Mono className="text-[14px]">{creds.login}</Mono>
            </div>
            <div>
              Password: <Mono className="text-[14px]">{creds.password}</Mono>
            </div>
            <Notice>
              The tablet signs in at <Mono>/tablet</Mono> and only works inside the site's boundary.
            </Notice>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function AddSite({ onClose, onCreated }) {
  const { data: lk } = useLookups();
  const qc = useQueryClient();
  const [f, setF] = useState({ code: '', name: '', state: 'Andhra Pradesh', lat: '', lng: '', radius_m: '300', project_id: '' });
  const locate = () =>
    navigator.geolocation.getCurrentPosition(
      (p) => setF((x) => ({ ...x, lat: p.coords.latitude.toFixed(6), lng: p.coords.longitude.toFixed(6) })),
      () => toast.error('Location unavailable. Type the coordinates instead.'),
      { enableHighAccuracy: true },
    );
  const save = useMutation({
    mutationFn: () => api.post('/sites', { code: f.code, name: f.name, state: f.state, lat: Number(f.lat), lng: Number(f.lng), radius_m: Number(f.radius_m), project_id: f.project_id || null }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['lookups'] });
      onCreated(r.data.credentials);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add a site"
      description="The state defaults professional tax for people hired to work here; it does not decide it."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!f.code || !f.name || !f.lat || !f.lng} loading={save.isPending} onClick={() => save.mutate()}>
            Create site
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" hint="Upper-case, e.g. ALPHA">
          {(id) => <Input id={id} className="font-mono uppercase" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />}
        </Field>
        <Field label="Name">{(id) => <Input id={id} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        <Field label="State">
          {(id) => (
            <Select id={id} value={f.state} onChange={(e) => setF({ ...f, state: e.target.value })}>
              {lk?.states.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Project">
          {(id) => (
            <Select id={id} value={f.project_id} onChange={(e) => setF({ ...f, project_id: e.target.value })}>
              <option value="">None</option>
              {lk?.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Latitude">{(id) => <Input id={id} value={f.lat} onChange={(e) => setF({ ...f, lat: e.target.value })} />}</Field>
        <Field label="Longitude">{(id) => <Input id={id} value={f.lng} onChange={(e) => setF({ ...f, lng: e.target.value })} />}</Field>
        <Field label="Boundary radius (metres)">{(id) => <Input id={id} type="number" value={f.radius_m} onChange={(e) => setF({ ...f, radius_m: e.target.value })} />}</Field>
        <div className="flex items-end">
          <Button variant="outline" onClick={locate}>
            <MapPin /> Use my location
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
