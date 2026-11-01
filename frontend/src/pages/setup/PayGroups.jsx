import {useSession} from '@/context/SessionContext';
import DeleteRecordDialog from '@/components/DeleteRecordDialog';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Plus, Users, MoreHorizontal } from 'lucide-react';
import { CALENDAR_METHOD_INFO, POLICY_KIND_LABELS } from '@ajpwer/shared';
import { api } from '@/services/api';
import { hhmm } from '@/utils';
import { PageHeader } from '@/components/bits';
import { Chip, EmptyState, ErrorState, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Menu } from '@/components/ui/overlay';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import ManagePayGroupDialog from '@/components/setup/ManagePayGroupDialog';

export default function PayGroups() {
  const nav = useNavigate();
  const {can}=useSession();
  const [removing,setRemoving]=useState(null);
  const [manage, setManage] = useState(null);
  const q = useQuery({ queryKey: ['pay-groups'], queryFn: () => api.get('/pay-groups').then((r) => r.data) });
  return (
    <div>
      <PageHeader
        title="Pay groups"
        description="Group employees who share a shift, working calendar and pay policies. Each employee keeps their own salary structure."
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
            body="Create a pay group with a shift and calendar, then attach policies and add employees."
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
                  <>
                    {can('people.read')&&<Button variant="outline" size="sm" onClick={()=>setManage(g)}><Users/> Manage employees</Button>}
                    {can('setup.write')&&<Menu trigger={<Button variant="ghost" size="sm" aria-label={`Pay group actions for ${g.name}`}><MoreHorizontal/> Actions</Button>} items={[
                      {label:'Edit pay group',onSelect:()=>nav(`/setup/pay-groups/${g.id}/edit`)},
                      'sep',{label:'Delete pay group',destructive:true,onSelect:()=>setRemoving(g)},
                    ]}/>}
                  </>
                }
              />

              <CardBody className="flex flex-col gap-3 text-[14px]">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[13px] text-muted-foreground">Calendar</div>
                    {CALENDAR_METHOD_INFO[g.calendar_method].label} <span className="text-muted-foreground">(÷{g.divisor_this_month} this month)</span>
                  </div>
                  <div>
                    <div className="text-[13px] text-muted-foreground">Weekly off</div>
                    {g.weekly_off.join(', ') || 'None'}
                  </div>
                  <div>
                    <div className="text-[13px] text-muted-foreground">Shift</div>
                    {g.shift.name} ({hhmm(g.shift.start_min)}–{hhmm(g.shift.end_min)})
                  </div>
                </div>
                <details>
                  <summary className="cursor-pointer text-sm font-medium text-primary">View {g.policies.length} pay policies</summary>
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
                </details>
                {g.warnings.length > 0 && (
                  <ul className="flex flex-col gap-1 rounded-md border border-warning/40 bg-warning/10 p-2">
                    {g.warnings.map((w, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-[13px]">
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
      {removing&&<DeleteRecordDialog kind="group" id={removing.id} onClose={()=>setRemoving(null)} onManage={can('people.read')?()=>{setManage(removing);setRemoving(null);}:undefined}/>}
      {manage && <ManagePayGroupDialog group={q.data?.find((g) => g.id === manage.id) ?? manage} groups={q.data ?? []} onClose={() => setManage(null)} />}
    </div>
  );
}
