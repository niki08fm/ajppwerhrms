import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Field, Select } from '@/components/ui/form';
import { refreshEmployeePay, ReviseDialog } from './SalaryHistory';

/** The employee's two pay choices, together above the revision history. */
export function SalaryAssignment({ e, salary }) {
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const history = useQuery({ queryKey: ['salary-history', e.id], queryFn: () => api.get(`/employees/${e.id}/salary`).then(r => r.data) });
  const [group, setGroup] = useState(e.pay_group.id);
  const [structure, setStructure] = useState(salary?.structure_id ?? '');
  const [changingStructure, setChangingStructure] = useState(false);
  useEffect(() => setGroup(e.pay_group.id), [e.pay_group.id]);
  useEffect(() => setStructure(salary?.structure_id ?? ''), [salary?.id, salary?.structure_id]);
  const saveGroup = useMutation({
    mutationFn: () => api.patch(`/employees/${e.id}`, { pay_group_id: group, updated_at: e.updated_at }),
    onSuccess: () => { toast.success('Pay group saved'); refreshEmployeePay(qc, e.id); },
    onError: error => toast.error(errorMessage(error)),
  });
  const current = history.data?.find(row => row.id === salary?.id);
  const latest = history.data?.slice().sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0];
  const protectedUpdate = !!salary && current?.can_edit === false;
  return <Card className="min-w-0" role="region" aria-label="Pay group and salary structure">
    <CardHeader title="Pay group and salary structure" className="px-4 py-3" />
    <div className="grid gap-3 p-4 sm:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-2">
        <Field label="Pay group">{id => <Select id={id} value={group} disabled={e.read_only || saveGroup.isPending} onChange={ev => setGroup(ev.target.value)}>
          {(lk?.pay_groups ?? [e.pay_group]).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>}</Field>
        {!e.read_only && <Button size="sm" variant="outline" loading={saveGroup.isPending} disabled={!group || group === e.pay_group.id} onClick={() => saveGroup.mutate()}>Save pay group</Button>}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <Field label="Salary structure">{id => <Select id={id} value={structure} disabled={e.read_only || history.isLoading || history.isError} onChange={ev => setStructure(ev.target.value)}>
          <option value="">Choose structure</option>
          {(lk?.structures ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>}</Field>
        {!e.read_only && <Button size="sm" variant="outline" disabled={!structure || structure === salary?.structure_id || history.isLoading || history.isError} onClick={() => setChangingStructure(true)}>Apply structure</Button>}
      </div>
    </div>
    {changingStructure && <ReviseDialog
      e={e}
      initialSalary={protectedUpdate ? latest ?? salary : salary}
      revision={!protectedUpdate ? current ?? null : null}
      defaultStructureId={structure}
      protectedUpdate={protectedUpdate}
      minimumMonth={protectedUpdate ? latest?.next_revision_month : undefined}
      onClose={() => setChangingStructure(false)}
    />}
  </Card>;
}
