import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { AJPWER_LEAVE_TYPES } from '@ajpwer/shared';
import { api, errorMessage } from '@/lib/api';
import { useKeysetList, useListParams } from '@/lib/hooks';
import { opts, useLookups } from '@/lib/lookups';
import { PageHeader, PersonLink } from '@/components/bits';
import { DataTable, Pager, type Col } from '@/components/data-table';
import { ListToolbar, type FilterDef } from '@/components/list-toolbar';
import { Chip, EmptyState, ErrorState, NoMatches, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Dialog, TabsContent, TabsList, TabsRoot } from '@/components/ui/overlay';

interface Req {
  id: string;
  employee: { id: string; code: string; name: string; department: { name: string } };
  leave_type: string;
  from_date: string;
  to_date: string;
  days: number;
  reason: string | null;
  status: string;
  decided_by: string | null;
}

const STATUS_TONE = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'destructive', CANCELLED: 'muted' } as const;
const typeName = (c: string) => AJPWER_LEAVE_TYPES.find((t) => t.code === c)?.name ?? c;

export default function Leave() {
  const lp = useListParams({ sort: '-from' });
  const nav = useNavigate();
  const { data: lk } = useLookups();
  const qc = useQueryClient();
  const [tab, setTab] = useState('requests');
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const list = useKeysetList<Req>(['leave'], '/leave', lp.apiParams, tab === 'requests');
  const decide = useMutation({
    mutationFn: ({ ids, decision }: { ids: string[]; decision: 'APPROVE' | 'REJECT' }) => (ids.length === 1 ? api.post(`/leave/${ids[0]}/decide`, { decision }) : api.post('/leave/bulk-decide', { ids, decision })),
    onSuccess: () => {
      toast.success('Done');
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['leave'] });
      qc.invalidateQueries({ queryKey: ['leave-balances'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const filters: FilterDef[] = useMemo(
    () => [
      { key: 'type', label: 'Type', options: AJPWER_LEAVE_TYPES.map((t) => ({ value: t.code, label: t.name })) },
      { key: 'status', label: 'Status', options: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() })) },
      { key: 'from', label: 'From', type: 'date' },
      { key: 'to', label: 'To', type: 'date' },
      { key: 'dept', label: 'Department', options: opts(lk?.departments) },
    ],
    [lk],
  );
  const cols: Col<Req>[] = [
    { id: 'name', header: 'Name', sticky: true, width: 200, cell: (r) => <PersonLink id={r.employee.id} name={r.employee.name} code={r.employee.code} /> },
    { id: 'type', header: 'Type', cell: (r) => typeName(r.leave_type) },
    { id: 'from', header: 'From', sortKey: 'from', cell: (r) => <span className="num">{r.from_date}</span> },
    { id: 'to', header: 'To', cell: (r) => <span className="num">{r.to_date}</span> },
    { id: 'days', header: 'Days', align: 'right', cell: (r) => r.days },
    { id: 'reason', header: 'Reason', cell: (r) => <span className="max-w-xs truncate">{r.reason}</span> },
    { id: 'status', header: 'Status', cell: (r) => <Chip tone={STATUS_TONE[r.status as keyof typeof STATUS_TONE]}>{r.status.charAt(0) + r.status.slice(1).toLowerCase()}</Chip> },
    {
      id: 'act',
      header: '',
      align: 'right',
      cell: (r) =>
        r.status === 'PENDING' ? (
          <span className="flex justify-end gap-1">
            <Button size="sm" variant="outline" onClick={() => decide.mutate({ ids: [r.id], decision: 'REJECT' })}>
              Reject
            </Button>
            <Button size="sm" onClick={() => decide.mutate({ ids: [r.id], decision: 'APPROVE' })}>
              Approve
            </Button>
          </span>
        ) : null,
    },
  ];
  return (
    <div>
      <PageHeader
        title="Leave"
        description="Approved paid leave makes a day worth one; unpaid leave makes it zero and is reported as LOP leave. There is no compensatory off: working an off day is paid, not banked."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> Record leave
          </Button>
        }
      />
      <TabsRoot value={tab} onValueChange={setTab}>
        <TabsList
          tabs={[
            { value: 'requests', label: 'Requests' },
            { value: 'balances', label: 'Balances' },
          ]}
        />
        <TabsContent value="requests" className="pt-4">
          <Card>
            <ListToolbar
              q={lp.q}
              onQ={(q) => lp.set({ q })}
              placeholder="Search name or code"
              searching="name and employee code"
              filters={filters}
              values={lp.filters}
              onFilter={(k, v) => lp.set({ [k]: v })}
              onClear={lp.clearFilters}
              list="leave"
              searchParams={lp.searchParams}
              onApplyView={(q) => nav(`/leave?${q}`)}
            >
              {selected.size > 0 && (
                <>
                  <Button size="sm" variant="outline" onClick={() => decide.mutate({ ids: [...selected], decision: 'REJECT' })}>
                    Reject {selected.size}
                  </Button>
                  <Button size="sm" onClick={() => decide.mutate({ ids: [...selected], decision: 'APPROVE' })}>
                    Approve {selected.size}
                  </Button>
                </>
              )}
            </ListToolbar>
            {list.isLoading ? (
              <SkeletonRows rows={8} />
            ) : list.isError ? (
              <ErrorState error={list.error} onRetry={() => list.refetch()} />
            ) : !list.rows.length ? (
              lp.q || Object.keys(lp.filters).length ? <NoMatches onClear={lp.clearFilters} /> : <EmptyState title="No leave recorded" body="Record leave on someone's behalf; approve or reject pending requests here." />
            ) : (
              <DataTable columns={cols} rows={list.rows} rowId={(r) => r.id} sort={lp.sort} onSort={lp.toggleSort} selectable selected={selected} onSelectedChange={setSelected} fetching={list.isFetching && !list.isLoading} />
            )}
            <Pager shown={list.rows.length} total={list.total} page={list.page} hasPrev={list.hasPrev} hasNext={list.hasNext} onPrev={list.prev} onNext={list.next} limit={lp.limit} onLimit={(n) => lp.set({ limit: String(n) })} />
          </Card>
        </TabsContent>
        <TabsContent value="balances" className="pt-4">
          {tab === 'balances' && <Balances />}
        </TabsContent>
      </TabsRoot>
      {creating && <RecordLeave onClose={() => setCreating(false)} />}
    </div>
  );
}

function Balances() {
  const [q, setQ] = useState('');
  const r = useQuery({
    queryKey: ['leave-balances', q],
    queryFn: () => api.get<{ data: { employee: { id: string; code: string; name: string }; balances: { leave_type: string; name: string; accrued: number; used: number; pending: number; balance: number; entitlement: number }[] }[] }>('/leave/balances', { q }).then((x) => x.data),
  });
  const types = r.data?.[0]?.balances.filter((b) => b.entitlement > 0) ?? [];
  return (
    <Card>
      <div className="border-b px-3 py-2">
        <Input className="w-64" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search" />
      </div>
      {r.isLoading ? (
        <SkeletonRows rows={8} />
      ) : r.isError ? (
        <ErrorState error={r.error} />
      ) : (
        <div className="max-h-[65vh] overflow-auto">
          <table className="data-table w-full">
            <thead className="sticky top-0">
              <tr>
                <th className="sticky left-0">Name</th>
                {types.map((t) => (
                  <th key={t.leave_type} className="text-right">
                    {t.name} <span className="font-normal">(accrued / used / left)</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {r.data!.map((row) => (
                <tr key={row.employee.id}>
                  <td className="sticky left-0 bg-card">
                    <PersonLink id={row.employee.id} name={row.employee.name} code={row.employee.code} />
                  </td>
                  {types.map((t) => {
                    const b = row.balances.find((x) => x.leave_type === t.leave_type)!;
                    return (
                      <td key={t.leave_type} className="text-right num">
                        {b.accrued} / {b.used} / <strong>{b.balance}</strong>
                        {b.pending > 0 && <span className="text-muted-foreground"> ({b.pending} pending)</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t px-3 py-2 text-[12px] text-muted-foreground">Balances are derived from the leave policy and the requests — a convenience, not a source of truth. Paid leave accrues monthly and is encashable on exit.</p>
    </Card>
  );
}

function RecordLeave({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const people = useQuery({ queryKey: ['people', 'active-leave'], queryFn: () => api.get<{ data: { id: string; name: string; code: string }[] }>('/employees', { 'filter[status]': 'ACTIVE,NOTICE', limit: 200 }).then((r) => r.data) });
  const [f, setF] = useState({ employee_id: '', leave_type: 'CL', from_date: '', to_date: '', days: '1', reason: '', approve: true });
  const save = useMutation({
    mutationFn: async () => {
      const r = await api.post<{ data: { id: string } }>('/leave', { employee_id: f.employee_id, leave_type: f.leave_type, from_date: f.from_date, to_date: f.to_date || f.from_date, days: Number(f.days), reason: f.reason || undefined });
      if (f.approve) await api.post(`/leave/${r.data.id}/decide`, { decision: 'APPROVE' });
    },
    onSuccess: () => {
      toast.success('Leave recorded');
      qc.invalidateQueries({ queryKey: ['leave'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Record leave"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!f.employee_id || !f.from_date} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Person" className="sm:col-span-2">
          {(id) => (
            <Select id={id} value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value })}>
              <option value="">Choose…</option>
              {people.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.code})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Type">
          {(id) => (
            <Select id={id} value={f.leave_type} onChange={(e) => setF({ ...f, leave_type: e.target.value })}>
              {AJPWER_LEAVE_TYPES.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.name} {t.paid ? '' : '(unpaid)'}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Days">{(id) => <Input id={id} type="number" step="0.5" min="0.5" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} />}</Field>
        <Field label="From">{(id) => <Input id={id} type="date" value={f.from_date} onChange={(e) => setF({ ...f, from_date: e.target.value })} />}</Field>
        <Field label="To">{(id) => <Input id={id} type="date" value={f.to_date} min={f.from_date} onChange={(e) => setF({ ...f, to_date: e.target.value })} />}</Field>
        <Field label="Reason" className="sm:col-span-2">
          {(id) => <Textarea id={id} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}
        </Field>
        <label className="flex items-center gap-2 text-[13px] sm:col-span-2">
          <input type="checkbox" checked={f.approve} onChange={(e) => setF({ ...f, approve: e.target.checked })} /> Approve now
        </label>
      </div>
    </Dialog>
  );
}
