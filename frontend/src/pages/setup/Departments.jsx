import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Plus, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/services/api';
import { useSession } from '@/context/SessionContext';
import { cn } from '@/utils';
import { PageHeader } from '@/components/bits';
import { EmptyState, ErrorState, PermissionDenied, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/form';
import { Dialog, Tooltip } from '@/components/ui/overlay';

const COLOURS = [
  { value: 'chart-1', label: 'Teal' },
  { value: 'chart-2', label: 'Green' },
  { value: 'chart-3', label: 'Cyan' },
  { value: 'chart-4', label: 'Yellow' },
  { value: 'chart-5', label: 'Blue' },
];

const swatchColour = (value) => /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value ?? '') ? value : `var(--${value || 'chart-1'}, var(--chart-1))`;

function refreshDepartments(queryClient) {
  for (const key of ['departments', 'lookups', 'people', 'employee', 'site-day', 'sites', 'dashboard']) queryClient.invalidateQueries({ queryKey: [key] });
}

const canDelete = (department) => department.can_delete === true && department.assigned_count === 0;
const deleteReason = (department) => department.assigned_count > 0
  ? `${department.assigned_count} employee record${department.assigned_count === 1 ? ' is' : 's are'} linked to this department. Departments with employee records cannot be deleted.`
  : 'This department cannot be deleted while employee records are linked to it.';

export default function Departments() {
  const { can } = useSession();
  const read = can('people.read');
  const manage = can('setup.write');
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [deleteError, setDeleteError] = useState('');
  const q = useQuery({ queryKey: ['departments'], queryFn: () => api.get('/departments').then((response) => response.data), enabled: read, refetchInterval: 60_000, refetchOnWindowFocus: true });
  const remove = useMutation({
    mutationFn: (department) => api.del(`/departments/${department.id}`),
    onSuccess: () => {
      refreshDepartments(queryClient);
      setDeleting(null);
      setDeleteError('');
      toast.success('Department deleted.');
    },
    onError: (error) => {
      setDeleteError(errorMessage(error));
      queryClient.invalidateQueries({ queryKey: ['departments'] });
    },
  });
  const deleteTarget = deleting && (q.data?.find((department) => department.id === deleting.id) ?? deleting);
  if (!read) return <PermissionDenied message="You need employee viewing access to see departments." />;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Departments" description="Manage names and chart colours. Assign employees from their profiles." actions={manage && <Button onClick={() => setAdding(true)}><Plus /> Add department</Button>} />
      <Card>
        {q.isLoading ? <SkeletonRows rows={5} cols={3} /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? <EmptyState icon={<Users className="size-6" />} title="No departments yet" body="Add a department to group employees and see their headcounts in charts." /> : (
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead><tr><th>Department</th><th className="text-right">Active employees</th>{manage && <th className="text-right">Actions</th>}</tr></thead>
              <tbody>
                {q.data.map((department) => <tr key={department.id}>
                  <td><div className="flex items-center gap-2.5"><span aria-hidden="true" className="size-3 shrink-0 rounded-full" style={{ background: swatchColour(department.colour) }} /><span className="font-medium">{department.name}</span></div></td>
                  <td className="text-right num">{department.headcount}</td>
                  {manage && <td className="text-right"><div className="flex justify-end gap-1">
                    <Tooltip content="Edit department"><Button variant="ghost" size="icon" aria-label={`Edit ${department.name}`} onClick={() => setEditing(department)}><Pencil /></Button></Tooltip>
                    {canDelete(department) ? <Tooltip content="Delete department"><Button variant="ghost" size="icon" aria-label={`Delete ${department.name}`} className="text-destructive hover:text-destructive" onClick={() => { setDeleting(department); setDeleteError(''); }}><Trash2 /></Button></Tooltip> : <Tooltip content={deleteReason(department)}><span className="inline-flex" tabIndex={0} aria-label={`Cannot delete ${department.name}: ${deleteReason(department)}`}><Button variant="ghost" size="icon" aria-label={`Delete ${department.name}`} disabled><Trash2 /></Button></span></Tooltip>}
                  </div></td>}
                </tr>)}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {manage && (adding || editing) && <DepartmentDialog key={editing?.id ?? 'new'} department={editing} onClose={() => { setAdding(false); setEditing(null); }} />}
      {manage && deleteTarget && <Dialog open title={`Delete ${deleteTarget.name}?`} description="Only departments without linked employee records can be deleted." onOpenChange={(open) => { if (!open && !remove.isPending) setDeleting(null); }} footer={<><Button variant="outline" disabled={remove.isPending} onClick={() => setDeleting(null)}>Cancel</Button><Button variant="destructive" disabled={!canDelete(deleteTarget)} loading={remove.isPending} onClick={() => remove.mutate(deleteTarget)}>Delete department</Button></>}>
        <p className="text-[14px] text-muted-foreground">This removes the department from employee selection and charts.</p>
        {!canDelete(deleteTarget) && <p className="mt-2 text-[13px] text-muted-foreground">{deleteReason(deleteTarget)}</p>}
        {deleteError && <p className="mt-3 text-[13px] text-destructive" role="alert">{deleteError}</p>}
      </Dialog>}
    </div>
  );
}

function DepartmentDialog({ department, onClose }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(department?.name ?? '');
  const [colour, setColour] = useState(department?.colour ?? 'chart-1');
  const [nameError, setNameError] = useState('');
  const [error, setError] = useState('');
  const save = useMutation({
    mutationFn: (body) => department ? api.patch(`/departments/${department.id}`, body) : api.post('/departments', body),
    onSuccess: () => {
      refreshDepartments(queryClient);
      toast.success(department ? 'Department updated.' : 'Department added.');
      onClose();
    },
    onError: (cause) => cause.field === 'name' ? setNameError(errorMessage(cause)) : setError(errorMessage(cause)),
  });
  const changed = !department || name.trim() !== department.name || colour !== department.colour;
  const submit = (event) => {
    event.preventDefault();
    setError('');
    const cleanName = name.trim();
    if (!cleanName) return setNameError('Enter a department name.');
    if (cleanName.length > 80) return setNameError('Use 80 characters or less.');
    setNameError('');
    if (!changed || save.isPending) return;
    const body = department ? { ...(cleanName !== department.name ? { name: cleanName } : {}), ...(colour !== department.colour ? { colour } : {}) } : { name: cleanName, colour };
    save.mutate(body);
  };
  return (
    <Dialog open title={department ? 'Edit department' : 'Add department'} description="The colour identifies this department in workforce charts." onOpenChange={(open) => { if (!open && !save.isPending) onClose(); }} footer={<><Button variant="outline" disabled={save.isPending} onClick={onClose}>Cancel</Button><Button type="submit" form="department-form" disabled={!changed} loading={save.isPending}>{department ? 'Save changes' : 'Add department'}</Button></>}>
      <form id="department-form" onSubmit={submit} className="space-y-4">
        <Field label="Department name" required error={nameError}>{(id, invalid) => <Input id={id} autoFocus disabled={save.isPending} value={name} aria-invalid={invalid || undefined} onChange={(event) => { setName(event.target.value); setNameError(''); setError(''); }} />}</Field>
        <fieldset><legend className="mb-2 text-[13px] font-medium">Chart colour</legend>
          {!COLOURS.some((item) => item.value === colour) && <p className="mb-2 flex items-center gap-2 text-[12px] text-muted-foreground"><span className="size-3 rounded-full" style={{ background: swatchColour(colour) }} /> Current colour</p>}
          <div className="flex flex-wrap gap-2" role="group" aria-label="Department chart colour">
          {COLOURS.map((item) => <button key={item.value} type="button" aria-label={item.label} aria-pressed={colour === item.value} disabled={save.isPending} onClick={() => { setColour(item.value); setError(''); }} className={cn('flex items-center gap-2 rounded-md border px-3 py-2 text-[13px] transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50', colour === item.value ? 'border-primary bg-accent' : 'border-border')}><span className="flex size-4 items-center justify-center rounded-full" style={{ background: `var(--${item.value})` }}>{colour === item.value && <Check className="size-3" style={{ color: item.value === 'chart-4' ? 'var(--foreground)' : 'var(--primary-foreground)' }} />}</span>{item.label}</button>)}
        </div></fieldset>
        {error && <p className="text-[13px] text-destructive" role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}
