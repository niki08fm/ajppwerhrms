import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, ImageOff, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, API_BASE, download, errorMessage } from '@/services/api';
import { useSession } from '@/context/SessionContext';
import { istTime } from '@/utils';
import { KV, PageHeader, PersonLink } from '@/components/bits';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Select, Textarea } from '@/components/ui/form';
import { TabsContent, TabsList, TabsRoot } from '@/components/ui/overlay';

/** What is waiting: face exceptions with evidence, and pending leave. */
export default function Approvals() {
  const [tab, setTab] = useState('face');
  const fx = useQuery({ queryKey: ['face-exceptions'], queryFn: () => api.get('/face-exceptions', { status: 'PENDING' }).then((r) => r.data) });
  const leave = useQuery({ queryKey: ['leave', 'pending'], queryFn: () => api.get('/leave', { 'filter[status]': 'PENDING', limit: 200 }).then((r) => r.data) });
  const moves = useQuery({ queryKey: ['site-changes'], queryFn: () => api.get('/site-changes') });
  const { can } = useSession();
  return (
    <div>
      <PageHeader
        title="Approvals"
        description="When the camera cannot identify someone, nothing is marked present until a person decides here."
        actions={
          can('reports.export') && (
            <Button variant="outline" onClick={() => download('/punch-attempts.csv', 'punch-attempts.csv').catch((e) => toast.error(errorMessage(e)))}>
              <Download /> Punch attempts (CSV)
            </Button>
          )
        }
      />
      <TabsRoot value={tab} onValueChange={setTab}>
        <TabsList
          tabs={[
            { value: 'face', label: 'Face exceptions', badge: fx.data?.length ? <Chip tone="warning">{fx.data.length}</Chip> : undefined },
            { value: 'leave', label: 'Leave', badge: leave.data?.length ? <Chip tone="info">{leave.data.length}</Chip> : undefined },
            { value: 'moves', label: 'Site changes', badge: moves.data?.meta.unreviewed ? <Chip tone="warning">{moves.data.meta.unreviewed}</Chip> : undefined },
          ]}
        />

        <TabsContent value="face" className="pt-4">
          {fx.isLoading ? (
            <SkeletonRows rows={4} />
          ) : fx.isError ? (
            <ErrorState error={fx.error} onRetry={() => fx.refetch()} />
          ) : !fx.data.length ? (
            <Card>
              <EmptyState title="Nothing waiting" body="Face exceptions from the site tablets appear here." />
            </Card>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {fx.data.map((f) => (
                <ExceptionCard key={f.id} f={f} />
              ))}
            </div>
          )}
        </TabsContent>
        <TabsContent value="leave" className="pt-4">
          <LeaveQueue q={leave} />
        </TabsContent>
        <TabsContent value="moves" className="pt-4">
          <SiteChanges q={moves} />
        </TabsContent>
      </TabsRoot>
    </div>
  );
}

function ExceptionCard({ f }) {
  const qc = useQueryClient();
  const people = useQuery({ queryKey: ['people', 'active-fx'], queryFn: () => api.get('/employees', { 'filter[status]': 'ACTIVE,NOTICE', limit: 200 }).then((r) => r.data) });
  const [who, setWho] = useState(f.best_match?.id ?? f.claimed?.id ?? '');
  const [dir, setDir] = useState(f.direction ?? '');
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const decide = useMutation({
    mutationFn: (decision) => api.post(`/face-exceptions/${f.id}/decide`, decision === 'APPROVE' ? { decision, employee_id: who, ...(dir ? { direction: dir } : {}) } : { decision, reason }),
    onSuccess: (_d, decision) => {
      toast.success(decision === 'APPROVE' ? `Punch written at ${istTime(f.occurred_at)} — the time of the attempt, not now.` : 'Rejected. The reason is the record of why nobody was marked present.');
      qc.invalidateQueries({ queryKey: ['face-exceptions'] });
      qc.invalidateQueries({ queryKey: ['dashboard', 'people'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card>
      <CardHeader title={`${f.site.name} · ${istTime(f.occurred_at, true)}`} description={f.reason} />
      <CardBody className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-[13px] text-muted-foreground">{f.crops ? `Face at the tablet, ${f.crops} tr${f.crops === 1 ? 'y' : 'ies'}` : 'Gate snapshot'}</div>
          {f.crops ? (
            <div className="grid grid-cols-3 gap-1.5">
              {Array.from({ length: f.crops }, (_, n) => (
                <img key={n} src={`${API_BASE}/face-exceptions/${f.id}/crops/${n}`} alt={`Face crop, try ${n + 1}`} className="aspect-square w-full rounded-md border object-cover" />
              ))}
            </div>
          ) : f.has_snapshot ? (
            <img src={`${API_BASE}/face-exceptions/${f.id}/snapshot`} alt="Gate snapshot" className="aspect-[4/3] w-full rounded-md border object-cover" />
          ) : (
            <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 rounded-md border bg-muted text-[13px] text-muted-foreground">
              <ImageOff className="size-5" /> No snapshot (or past its 30 days)
            </div>
          )}
          <p className="mt-1 text-[12px] text-muted-foreground">Only embeddings are stored for enrolled people, not photographs. Compare against the person in front of you or their ID.</p>
        </div>
        <div className="flex flex-col gap-3 text-[14px]">
          <KV
            cols={1}
            items={[
              [
                'Best match',
                f.best_match ? (
                  <>
                    <PersonLink id={f.best_match.id} name={f.best_match.name} code={f.best_match.code} /> · {f.score !== null ? `${Math.round(f.score * 100)}%` : ''}
                  </>
                ) : (
                  'Nobody close'
                ),
              ],
              ...(f.kind === 'FAILED_TRIES' ? [['Typed at the tablet', f.claimed ? `${f.claimed_name} · ID ${f.claimed.code} (${f.claimed.name})` : f.claimed_name]] : []),
              ['Distance from centre', f.distance_m !== null ? `${f.distance_m} m` : '—'],
            ]}
          />

          <label className="flex flex-col gap-1">
            <span className="text-[13px] font-medium">Who it actually was</span>
            <Select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Choose…</option>
              {people.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.code})
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[13px] font-medium">Direction</span>
            <Select value={dir} onChange={(e) => setDir(e.target.value)}>
              <option value="">Infer from their last punch</option>
              <option value="IN">In</option>
              <option value="OUT">Out</option>
            </Select>
          </label>
          {rejecting && (
            <Textarea
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why nobody is being marked present (at least eight characters)"
              aria-label="Reason for rejecting"
            />
          )}
          <div className="mt-auto flex justify-end gap-2">
            {rejecting ? (
              <>
                <Button variant="outline" onClick={() => setRejecting(false)}>
                  Cancel
                </Button>
                <Button variant="destructive" disabled={reason.trim().length < 8} loading={decide.isPending} onClick={() => decide.mutate('REJECT')}>
                  Reject
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => setRejecting(true)}>
                  <X /> Reject
                </Button>
                <Button disabled={!who} loading={decide.isPending} onClick={() => decide.mutate('APPROVE')}>
                  <Check /> Approve at {istTime(f.occurred_at)}
                </Button>
              </>
            )}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function LeaveQueue({ q }) {
  const qc = useQueryClient();
  const decide = useMutation({
    mutationFn: ({ id, decision }) => api.post(`/leave/${id}/decide`, { decision }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leave'] });
      qc.invalidateQueries({ queryKey: ['dashboard', 'people'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (q.isLoading) return <SkeletonRows rows={4} />;
  if (q.isError) return <ErrorState error={q.error} />;
  if (!q.data.length)
    return (
      <Card>
        <EmptyState
          title="No pending leave"
          body="Pending requests appear here."
          action={
            <Link to="/leave" className="text-primary hover:underline">
              All leave
            </Link>
          }
        />
      </Card>
    );
  return (
    <Card>
      <div className="overflow-x-auto"><table className="data-table w-full">
        <tbody>
          {q.data.map((r) => (
            <tr key={r.id}>
              <td>
                <PersonLink id={r.employee.id} name={r.employee.name} code={r.employee.code} />
              </td>
              <td>{r.leave_name ?? r.leave_type}</td>
              <td className="num">
                {r.from_date} → {r.to_date} ({r.days} d)
              </td>
              <td className="max-w-xs truncate">{r.reason}</td>
              <td className="text-right">
                <span className="flex justify-end gap-1">
                  <Button size="sm" variant="outline" onClick={() => decide.mutate({ id: r.id, decision: 'REJECT' })}>
                    Reject
                  </Button>
                  <Button size="sm" onClick={() => decide.mutate({ id: r.id, decision: 'APPROVE' })}>
                    Approve
                  </Button>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
    </Card>
  );
}

/**
 * People who used "Change site" on a tablet. Travel counts only when they punched
 * in at the named site the same day; HR can set any figure, which is final.
 */
function SiteChanges({ q }) {
  if (q.isLoading) return <SkeletonRows rows={4} />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data.data.length)
    return (
      <Card>
        <EmptyState title="No site changes" body="When someone leaves one site for another with Change site on the tablet, it appears here with the travel time." />
      </Card>
    );
  return (
    <Card>
      <table className="w-full text-[14px]">
        <thead className="border-b text-left text-[13px] text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Person</th>
            <th className="px-4 py-2 font-medium">From → to</th>
            <th className="px-4 py-2 font-medium">Left · arrived</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Travel counted</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {q.data.data.map((c) => (
            <SiteChangeRow key={c.id} c={c} />
          ))}
        </tbody>
      </table>
    </Card>
  );
}

const MOVE_STATUS = { PENDING: ['info', 'On the way'], COUNTED: ['success', 'Arrived same day'], NOT_COUNTED: ['muted', 'Not counted'] };

function SiteChangeRow({ c }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [minutes, setMinutes] = useState(String(c.effective_travel_min));
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => api.patch(`/site-changes/${c.id}`, { travel_min: Number(minutes), reason }),
    onSuccess: () => {
      toast.success('Travel time saved. The day is recomputed with it.');
      setEditing(false);
      qc.invalidateQueries({ queryKey: ['site-changes'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const [tone, label] = MOVE_STATUS[c.status];
  return (
    <tr className="align-top">
      <td className="px-4 py-2">{c.employee && <PersonLink id={c.employee.id} name={c.employee.name} code={c.employee.code} />}</td>
      <td className="px-4 py-2">
        {c.from_site?.name} → {c.to_site?.name}
      </td>
      <td className="px-4 py-2 num">
        {istTime(c.left_at, true)} · {c.arrived_at ? istTime(c.arrived_at) : '—'}
      </td>
      <td className="px-4 py-2">
        <Chip tone={tone}>{label}</Chip>
        {c.reviewed_at && <div className="mt-1 text-[12px] text-muted-foreground">Set by {c.reviewed_by}</div>}
      </td>
      <td className="px-4 py-2 num">
        {editing ? (
          <div className="flex w-56 flex-col gap-1.5">
            <Input type="number" min={0} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} aria-label="Travel minutes" />
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (e.g. bus takes 30 min)" aria-label="Reason" />
          </div>
        ) : (
          `${c.effective_travel_min} min`
        )}
      </td>
      <td className="px-4 py-2 text-right">
        {editing ? (
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={minutes === '' || reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            {c.reviewed_at ? 'Change' : 'Review'}
          </Button>
        )}
      </td>
    </tr>
  );
}
