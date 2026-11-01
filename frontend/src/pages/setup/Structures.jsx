import {useState} from 'react';
import {useSession} from '@/context/SessionContext';
import DeleteRecordDialog from '@/components/DeleteRecordDialog';
import ManageStructureDialog from '@/components/setup/ManageStructureDialog';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Lock, Plus, Users, MoreHorizontal } from 'lucide-react';
import { describeComponentRule, formatINR } from '@ajpwer/shared';
import { api } from '@/services/api';
import { Money, PageHeader, ProportionBar } from '@/components/bits';
import { Chip, EmptyState, ErrorState, Notice, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Menu } from '@/components/ui/overlay';
import { Card, CardBody, CardHeader } from '@/components/ui/card';

export const ruleOf = describeComponentRule;

export default function Structures() {
  const nav = useNavigate();
  const {can}=useSession();
  const [removing,setRemoving]=useState(null),[managing,setManaging]=useState(null);
  const q = useQuery({ queryKey: ['structures'], queryFn: () => api.get('/structures').then((r) => r.data) });
  return (
    <div>
      <PageHeader
        title="Salary structures"
        description="Choose how salary is split into earnings. Assign a structure when adding an employee or revising their salary."
        actions={
          <Button onClick={() => nav('/setup/structures/new')}>
            <Plus /> New structure
          </Button>
        }
      />

      {q.isLoading ? (
        <SkeletonBlock className="h-80" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data.length ? (
        <Card>
          <EmptyState
            title="No structures yet"
            body="Build one with Basic, HRA, DA and any allowances. Whatever is left of gross becomes the Special Allowance."
            action={<Button onClick={() => nav('/setup/structures/new')}>Build a structure</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {q.data.map((s) => (
            <Card key={s.id}>
              <CardHeader
                title={s.name}
                description={
                  s.people
                    ? `${s.people} ${s.people === 1 ? 'employee' : 'employees'} assigned`
                    : 'Available to assign to employees'
                }
                actions={
                  <>
                    {can('setup.write')&&can('people.read')&&<Button variant="outline" size="sm" onClick={()=>setManaging(s)}><Users/> Manage employees</Button>}
                    {s.immutable && <Chip tone="muted"><Lock className="size-3"/> In use</Chip>}
                    {can('setup.write') && <Menu trigger={<Button size="sm" variant="ghost" aria-label={`Salary structure actions for ${s.name}`}><MoreHorizontal/> Actions</Button>} items={[
                      {label:'Duplicate and edit',onSelect:()=>nav(`/setup/structures/new?from=${s.id}`)},
                      'sep', {label:'Delete salary structure',destructive:true,onSelect:()=>setRemoving(s)},
                    ]}/>}
                  </>
                }
              />

              <CardBody className="flex flex-col gap-3">
                <ProportionBar parts={s.sample.monthly.map((c, i) => ({ label: c.name, value: c.amount, colour: s.components.filter((x) => x.frequency === 'MONTHLY')[i]?.colour }))} />
                <details><summary className="cursor-pointer text-sm font-medium text-primary">View salary components</summary><div className="mt-3 overflow-x-auto"><table className="w-full text-[14px]">
                  <thead className="text-left text-[13px] text-muted-foreground">
                    <tr>
                      <th className="py-1">Component</th>
                      <th>Rule</th>
                      <th>Tax</th>
                      <th>PF base</th>
                      <th>ESI wage</th>
                      <th className="text-right">At {formatINR(s.sample.gross)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.components.map((c) => {
                      const amt = (c.frequency === 'MONTHLY' ? s.sample.monthly : s.sample.yearly).find((x) => x.name === c.name)?.amount ?? 0;
                      return (
                        <tr key={c.seq} className="border-t">
                          <td className="py-1">
                            {c.name}
                            {c.frequency === 'YEARLY' && <span className="text-[12px] text-muted-foreground"> (yearly, month {c.pay_month})</span>}
                          </td>
                          <td className="text-muted-foreground">{ruleOf(c)}</td>
                          <td>{c.is_taxable ? 'Taxable' : 'Exempt'}</td>
                          <td>{c.counts_as_wages ? <Chip tone="info">PF base</Chip> : ''}</td>
                          <td>{c.frequency === 'MONTHLY' && c.counts_as_esi_wages !== false ? <Chip tone="info">ESI wage</Chip> : ''}</td>
                          <td className="text-right">
                            <Money value={amt} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table></div></details>
                {s.validation.warnings.map((w) => (
                  <Notice key={w} tone="warning">
                    {w}
                  </Notice>
                ))}
                <p className="text-[12px] text-muted-foreground">
                  Sample at {formatINR(s.sample.gross)} a month{s.components.some((c) => c.calc_type === 'PCT_CTC') ? `, a CTC of ${formatINR(s.sample.annual_ctc)} a year` : ''}. Whatever is left of
                  gross is the Special Allowance.
                </p>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
      {removing&&<DeleteRecordDialog kind="structure" id={removing.id} onClose={()=>setRemoving(null)} onManage={can('people.read')?()=>{setManaging(removing);setRemoving(null);}:undefined}/>}
      {managing&&<ManageStructureDialog structure={managing} onClose={()=>setManaging(null)}/>}
    </div>
  );
}
