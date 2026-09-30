import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Pencil, Plus } from 'lucide-react';
import { CALENDAR_METHOD_INFO, POLICY_KIND_LABELS } from '@ajpwer/shared';
import { api } from '@/lib/api';
import { hhmm } from '@/lib/utils';
import { PageHeader } from '@/components/bits';
import { Chip, EmptyState, ErrorState, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';

export default function PayGroups() {
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['pay-groups'], queryFn: () => api.get('/pay-groups').then((r) => r.data) });
  return (
    <div>
      <PageHeader
        title="Pay groups"
        description="The centre of gravity. Calendar method, weekly off, shift, salary structure and every policy hang off the pay group, never off the person. Change a policy here and everyone in the group changes together."
        actions={
          <Button onClick={() => nav('/setup/pay-groups/new')}>
            <Plus /> New pay group
          </Button>
        }
      />

      {q.isLoading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <SkeletonBlock className="h-72" />
          <SkeletonBlock className="h-72" />
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data.length ? (
        <Card>
          <EmptyState
            title="No pay groups yet"
            body="Build policies and a salary structure first, then create a pay group that attaches them."
            action={<Button onClick={() => nav('/setup/pay-groups/new')}>Create a pay group</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {q.data.map((g) => (
            <Card key={g.id}>
              <CardHeader
                title={g.name}
                description={`${g.headcount} people · paid on day ${g.pay_day}`}
                actions={
                  <Button variant="outline" size="sm" onClick={() => nav(`/setup/pay-groups/${g.id}/edit`)}>
                    <Pencil /> Edit
                  </Button>
                }
              />

              <CardBody className="flex flex-col gap-3 text-[13px]">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[12px] text-muted-foreground">Calendar</div>
                    {CALENDAR_METHOD_INFO[g.calendar_method].label} <span className="text-muted-foreground">(÷{g.divisor_this_month} this month)</span>
                  </div>
                  <div>
                    <div className="text-[12px] text-muted-foreground">Weekly off</div>
                    {g.weekly_off.join(', ') || 'None'}
                  </div>
                  <div>
                    <div className="text-[12px] text-muted-foreground">Shift</div>
                    {g.shift.name} ({hhmm(g.shift.start_min)}–{hhmm(g.shift.end_min)})
                  </div>
                  <div>
                    <div className="text-[12px] text-muted-foreground">Structure</div>
                    {g.structure ? (
                      <Link to="/setup/structures" className="hover:underline">
                        {g.structure.name}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </div>
                </div>
                <div>
                  <div className="mb-1 text-[12px] text-muted-foreground">Policies attached</div>
                  <ul className="flex flex-col gap-1">
                    {g.policies.map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-2">
                        <span>
                          <span className="text-muted-foreground">{POLICY_KIND_LABELS[p.kind]}:</span> {p.name}
                        </span>
                        <Chip tone={p.valid_to ? 'muted' : 'default'}>
                          v{p.version} · {p.valid_from}
                          {p.valid_to ? ` → ${p.valid_to}` : ' →'}
                        </Chip>
                      </li>
                    ))}
                  </ul>
                </div>
                {g.warnings.length > 0 && (
                  <ul className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/10 p-2">
                    {g.warnings.map((w, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-[12px]">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{' '}
                        <span>
                          <strong>{POLICY_KIND_LABELS[w.kind]}:</strong> {w.message}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
