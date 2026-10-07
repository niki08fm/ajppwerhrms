import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/services/api';
import { useKeysetList } from '@/hooks';
import { Chip, EmptyState, ErrorState, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Field, Input, Segmented, Select } from '@/components/ui/form';
import { Checkbox, Dialog } from '@/components/ui/overlay';
import { Pager } from '@/components/data-table';

/** Existing employees can join a group or move out without changing their salary agreement. */
export default function ManagePayGroupDialog({ group, groups, onClose }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState('members');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [destination, setDestination] = useState('');
  const members = useQuery({ queryKey: ['pay-group-employees', group.id], queryFn: () => api.get(`/pay-groups/${group.id}/employees`).then((r) => r.data) });
  const candidates = useKeysetList(['pay-group-candidates', group.id], '/employees', { q: search, sort: 'name', limit: 50, 'filter[status]': 'ACTIVE,NOTICE' }, tab === 'add');
  const move = useMutation({
    mutationFn: () => api.post(`/pay-groups/${tab === 'add' ? group.id : destination}/employees`, { employee_ids: [...selected] }),
    onSuccess: (response) => {
      const count = response.data.moved;
      const target = tab === 'add' ? group.name : groups.find((g) => g.id === destination)?.name;
      toast.success(`${count} ${count === 1 ? 'employee moved' : 'employees moved'} to ${target}.`);
      setSelected(new Set());
      for (const key of ['pay-group-employees', 'pay-group-candidates', 'pay-groups', 'pay-group', 'lookups', 'people', 'employee', 'employee-pay', 'employee-tax', 'payslip-preview', 'emp-timeline', 'timeline']) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const chooseTab = (value) => {
    setTab(value);
    setSearch('');
    setSelected(new Set());
  };
  const toggle = (id, checked) => setSelected((previous) => {
    const next = new Set(previous);
    checked ? next.add(id) : next.delete(id);
    return next;
  });
  const memberIds = new Set((members.data ?? []).map((e) => e.id));
  const memberRows = (members.data ?? []).filter((e) => `${e.name} ${e.code}`.toLowerCase().includes(search.trim().toLowerCase()));
  const rows = tab === 'members' ? memberRows : candidates.rows;
  const query = tab === 'members' ? members : candidates;
  const selectable = rows.filter((e) => e.status !== 'EXITED' && !e.read_only && (tab === 'members' || (!memberIds.has(e.id) && e.pay_group?.id !== group.id)));
  const allSelected = selectable.length > 0 && selectable.every((e) => selected.has(e.id));
  const someSelected = selectable.some((e) => selected.has(e.id));

  return (
    <Dialog
      open
      wide
      onOpenChange={(open) => !open && !move.isPending && onClose()}
      title={`Manage employees · ${group.name}`}
      description="Employees follow their pay group's calendar, shift and policies. Their salary and salary structure stay attached to their profile."
      footer={(
        <>
          <span className="mr-auto text-[13px] text-muted-foreground">{selected.size} selected</span>
          <Button variant="outline" onClick={onClose} disabled={move.isPending}>Close</Button>
          <Button
            loading={move.isPending}
            disabled={!selected.size || (tab === 'members' && !destination) || members.isLoading || members.isError}
            onClick={() => move.mutate()}
          >
            {tab === 'add' ? <UserPlus /> : <ArrowRightLeft />}
            {tab === 'add' ? 'Add to this pay group' : 'Move selected employees'}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-4">
        <Segmented
          label="Manage pay group employees"
          value={tab}
          onChange={chooseTab}
          options={[{ value: 'members', label: `Employees (${members.data?.length ?? group.headcount})`, disabled: move.isPending }, { value: 'add', label: 'Add employees', disabled: move.isPending }]}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Search employees">
            {(id) => <Input id={id} value={search} onChange={(e) => setSearch(e.target.value)} disabled={move.isPending} placeholder="Search by name or employee code" />}
          </Field>
          {tab === 'members' && (
            <Field label="Move to pay group">
              {(id) => (
                <Select id={id} value={destination} onChange={(e) => setDestination(e.target.value)} disabled={move.isPending}>
                  <option value="">Select pay group</option>
                  {groups.filter((g) => g.id !== group.id).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </Select>
              )}
            </Field>
          )}
        </div>
        {tab === 'add' && members.isError && <ErrorState error={members.error} onRetry={() => members.refetch()} compact />}
        {query.isLoading ? <SkeletonRows rows={6} cols={4} /> : query.isError ? (
          <ErrorState error={query.error} onRetry={() => query.refetch()} compact />
        ) : !rows.length ? (
          <EmptyState
            title={search ? 'No employees match' : tab === 'members' ? 'No employees in this pay group' : 'No active employees available'}
            body={search ? 'Try another name or employee code.' : tab === 'members' ? 'Use Add employees to assign existing employees to this group.' : 'Add an employee from People first.'}
          />
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th className="w-10">
                    <Checkbox
                      label="Select all eligible employees on this page"
                      checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                      disabled={move.isPending || !selectable.length}
                      onCheckedChange={(checked) => setSelected((previous) => {
                        const next = new Set(previous);
                        for (const e of selectable) checked ? next.add(e.id) : next.delete(e.id);
                        return next;
                      })}
                    />
                  </th>
                  <th>Employee</th>
                  <th>Code</th>
                  <th>{tab === 'add' ? 'Current pay group' : 'Status'}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((employee) => {
                  const alreadyMember = tab === 'add' && (memberIds.has(employee.id) || employee.pay_group?.id === group.id);
                  const readOnly = employee.status === 'EXITED' || employee.read_only;
                  return (
                    <tr key={employee.id}>
                      <td>
                        <Checkbox
                          label={`Select ${employee.name}`}
                          checked={selected.has(employee.id)}
                          disabled={alreadyMember || readOnly || move.isPending}
                          onCheckedChange={(checked) => toggle(employee.id, checked)}
                        />
                      </td>
                      <td><Link to={`/people/${employee.id}?tab=salary`} className="font-medium hover:underline">{employee.name}</Link></td>
                      <td className="num">{employee.code}</td>
                      <td>
                        {tab === 'add'
                          ? alreadyMember ? <Chip tone="muted">Already in this pay group</Chip> : employee.pay_group?.name ?? '—'
                          : <span>{employee.status.charAt(0) + employee.status.slice(1).toLowerCase()}</span>}
                        {readOnly && <span className="text-muted-foreground"> · read only</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {tab === 'add' && <Pager total={candidates.total} shown={candidates.rows.length} page={candidates.page} limit={50} hasNext={candidates.hasNext} hasPrev={candidates.hasPrev} onNext={candidates.next} onPrev={candidates.prev} />}
          </div>
        )}
      </div>
    </Dialog>
  );
}
