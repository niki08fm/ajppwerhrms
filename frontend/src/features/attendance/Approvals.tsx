import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ImageOff, X } from 'lucide-react';
import { toast } from 'sonner';
import { AJPWER_LEAVE_TYPES } from '@ajpwer/shared';
import { api, API_BASE, errorMessage } from '@/lib/api';
import { istTime } from '@/lib/utils';
import { KV, PageHeader, PersonLink } from '@/components/bits';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Select, Textarea } from '@/components/ui/form';
import { TabsContent, TabsList, TabsRoot } from '@/components/ui/overlay';

interface Fx {
  id: string;
  occurred_at: string;
  site: { code: string; name: string };
  score: number | null;
  reason: string;
  direction: 'IN' | 'OUT' | null;
  distance_m: number | null;
  best_match: { id: string; code: string; name: string; designation: string } | null;
  claimed: { id: string; code: string; name: string } | null;
  has_snapshot: boolean;
  status: string;
}

/** What is waiting: face exceptions with evidence, and pending leave. */
export default function Approvals() {
  const [tab, setTab] = useState('face');
  const fx = useQuery({ queryKey: ['face-exceptions'], queryFn: () => api.get<{ data: Fx[] }>('/face-exceptions', { status: 'PENDING' }).then((r) => r.data) });
  const leave = useQuery({ queryKey: ['leave', 'pending'], queryFn: () => api.get<{ data: { id: string; employee: { id: string; code: string; name: string }; leave_type: string; from_date: string; to_date: string; days: number; reason: string | null }[] }>('/leave', { 'filter[status]': 'PENDING', limit: 200 }).then((r) => r.data) });
  return (
    <div>
      <PageHeader title="Approvals" description="When the camera cannot identify someone, nothing is marked present until a person decides here." />
      <TabsRoot value={tab} onValueChange={setTab}>
        <TabsList
          tabs={[
            { value: 'face', label: 'Face exceptions', badge: fx.data?.length ? <Chip tone="warning">{fx.data.length}</Chip> : undefined },
            { value: 'leave', label: 'Leave', badge: leave.data?.length ? <Chip tone="info">{leave.data.length}</Chip> : undefined },
          ]}
        />
        <TabsContent value="face" className="pt-4">
          {fx.isLoading ? (
            <SkeletonRows rows={4} />
          ) : fx.isError ? (
            <ErrorState error={fx.error} onRetry={() => fx.refetch()} />
          ) : !fx.data!.length ? (
            <Card>
              <EmptyState title="Nothing waiting" body="Face exceptions from the site tablets appear here." />
            </Card>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {fx.data!.map((f) => (
                <ExceptionCard key={f.id} f={f} />
              ))}
            </div>
          )}
        </TabsContent>
        <TabsContent value="leave" className="pt-4">
          <LeaveQueue q={leave} />
        </TabsContent>
      </TabsRoot>
    </div>
  );
}

function ExceptionCard({ f }: { f: Fx }) {
  const qc = useQueryClient();
  const people = useQuery({ queryKey: ['people', 'active-fx'], queryFn: () => api.get<{ data: { id: string; name: string; code: string }[] }>('/employees', { 'filter[status]': 'ACTIVE,NOTICE', limit: 200 }).then((r) => r.data) });
  const [who, setWho] = useState(f.best_match?.id ?? f.claimed?.id ?? '');
  const [dir, setDir] = useState<string>(f.direction ?? '');
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const decide = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') => api.post(`/face-exceptions/${f.id}/decide`, decision === 'APPROVE' ? { decision, employee_id: who, ...(dir ? { direction: dir } : {}) } : { decision, reason }),
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
          <div className="mb-1 text-[12px] text-muted-foreground">Gate snapshot</div>
          {f.has_snapshot ? (
            <img src={`${API_BASE}/face-exceptions/${f.id}/snapshot`} alt="Gate snapshot" className="aspect-[4/3] w-full rounded-md border object-cover" />
          ) : (
            <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 rounded-md border bg-muted text-[12px] text-muted-foreground">
              <ImageOff className="size-5" /> No snapshot (or past its 30 days)
            </div>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground">Only embeddings are stored for enrolled people, not photographs. Compare against the person in front of you or their ID.</p>
        </div>
        <div className="flex flex-col gap-3 text-[13px]">
          <KV
            cols={1}
            items={[
              ['Best match', f.best_match ? <><PersonLink id={f.best_match.id} name={f.best_match.name} code={f.best_match.code} /> · {f.score !== null ? `${Math.round(f.score * 100)}%` : ''}</> : 'Nobody close'],
              ['Distance from centre', f.distance_m !== null ? `${f.distance_m} m` : '—'],
            ]}
          />
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium">Who it actually was</span>
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
            <span className="text-[12px] font-medium">Direction</span>
            <Select value={dir} onChange={(e) => setDir(e.target.value)}>
              <option value="">Infer from their last punch</option>
              <option value="IN">In</option>
              <option value="OUT">Out</option>
            </Select>
          </label>
          {rejecting && <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why nobody is being marked present (at least eight characters)" aria-label="Reason for rejecting" />}
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

function LeaveQueue({ q }: { q: ReturnType<typeof useQuery<{ id: string; employee: { id: string; code: string; name: string }; leave_type: string; from_date: string; to_date: string; days: number; reason: string | null }[]>> }) {
  const qc = useQueryClient();
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'APPROVE' | 'REJECT' }) => api.post(`/leave/${id}/decide`, { decision }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leave'] });
      qc.invalidateQueries({ queryKey: ['dashboard', 'people'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (q.isLoading) return <SkeletonRows rows={4} />;
  if (q.isError) return <ErrorState error={q.error} />;
  if (!q.data!.length)
    return (
      <Card>
        <EmptyState title="No pending leave" body="Pending requests appear here." action={<Link to="/leave" className="text-primary hover:underline">All leave</Link>} />
      </Card>
    );
  return (
    <Card>
      <table className="data-table w-full">
        <tbody>
          {q.data!.map((r) => (
            <tr key={r.id}>
              <td>
                <PersonLink id={r.employee.id} name={r.employee.name} code={r.employee.code} />
              </td>
              <td>{AJPWER_LEAVE_TYPES.find((t) => t.code === r.leave_type)?.name ?? r.leave_type}</td>
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
      </table>
    </Card>
  );
}
