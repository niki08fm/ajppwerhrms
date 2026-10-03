import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/services/api';
import { useDebounced, useKeysetList, useListParams, useNewFromUrl } from '@/hooks';
import { opts, useLookups } from '@/hooks/useLookups';
import { dateSpan, monthLabel } from '@/utils';
import { PageHeader, PersonLink } from '@/components/bits';
import { DataTable, Pager } from '@/components/data-table';
import { ListToolbar } from '@/components/list-toolbar';
import { Chip, EmptyState, ErrorState, NoMatches, Notice, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Dialog, TabsContent, TabsList, TabsRoot } from '@/components/ui/overlay';

const STATUS_TONE = { PENDING: 'warning', APPROVED: 'success', REJECTED: 'destructive', CANCELLED: 'muted' };

function useLeaveTypes() {
  return useQuery({ queryKey: ['leave-types'], queryFn: () => api.get('/leave/types').then((r) => r.data), staleTime: 5 * 60_000 });
}

export default function Leave() {
  const lp = useListParams({ sort: '-from' });
  const nav = useNavigate();
  const { data: lk } = useLookups();
  const types = useLeaveTypes();
  const qc = useQueryClient();
  const [tab, setTab] = useState('requests');
  const [creating, setCreating] = useState(false);
  useNewFromUrl(useCallback(() => setCreating(true), []));
  const [selected, setSelected] = useState(new Set());
  const list = useKeysetList(['leave'], '/leave', lp.apiParams, tab === 'requests');
  const decide = useMutation({
    mutationFn: ({ ids, decision }) => (ids.length === 1 ? api.post(`/leave/${ids[0]}/decide`, { decision }) : api.post('/leave/bulk-decide', { ids, decision })),
    onSuccess: () => {
      toast.success('Done');
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['leave'] });
      qc.invalidateQueries({ queryKey: ['leave-balances'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const filters = useMemo(
    () => [
      { key: 'type', label: 'Type', options: (types.data ?? []).map((t) => ({ value: t.code, label: t.name })) },
      { key: 'status', label: 'Status', options: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() })) },
      { key: 'from', label: 'From', type: 'date' },
      { key: 'to', label: 'To', type: 'date' },
      { key: 'dept', label: 'Department', options: opts(lk?.departments) },
    ],
    [lk, types.data],
  );
  const cols = [
    { id: 'name', header: 'Name', sticky: true, width: 200, cell: (r) => <PersonLink id={r.employee.id} name={r.employee.name} code={r.employee.code} tab="attendance" /> },
    { id: 'type', header: 'Type', cell: (r) => r.leave_name },
    { id: 'from', header: 'Dates', sortKey: 'from', cell: (r) => <span className="num">{dateSpan(r.from_date, r.to_date)}</span> },
    { id: 'days', header: 'Days', align: 'right', cell: (r) => <span className="num">{r.days}</span> },
    {
      id: 'reason',
      header: 'Reason',
      cell: (r) => (
        <span className="block max-w-56 truncate" title={r.reason}>
          {r.reason}
        </span>
      ),
    },
    { id: 'status', header: 'Status', cell: (r) => <Chip tone={STATUS_TONE[r.status]}>{r.status.charAt(0) + r.status.slice(1).toLowerCase()}</Chip> },
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
        description="Absences nobody applied for, and the missing half of half days, are paid from paid leave automatically while it lasts, up to its monthly limit. Every other kind — sick, maternity, paternity, bereavement and the rest — is recorded here by HR on the person's behalf and paid from its own balance."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> Record leave
          </Button>
        }
      />

      <TabsRoot value={tab} onValueChange={setTab}>
        <TabsList
          tabs={[
            { value: 'requests', label: 'Recorded leave' },
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
              lp.q || Object.keys(lp.filters).length ? (
                <NoMatches onClear={lp.clearFilters} />
              ) : (
                <EmptyState title="No leave recorded" body="Record leave on someone's behalf; approve or reject pending requests here." />
              )
            ) : (
              <DataTable
                columns={cols}
                rows={list.rows}
                rowId={(r) => r.id}
                sort={lp.sort}
                onSort={lp.toggleSort}
                selectable
                selected={selected}
                onSelectedChange={setSelected}
                fetching={list.isFetching && !list.isLoading}
              />
            )}
            <Pager
              shown={list.rows.length}
              total={list.total}
              page={list.page}
              hasPrev={list.hasPrev}
              hasNext={list.hasNext}
              onPrev={list.prev}
              onNext={list.next}
              limit={lp.limit}
              onLimit={(n) => lp.set({ limit: String(n) })}
            />
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

const fmt = (n) => (n === null || n === undefined ? '—' : String(n));

function Balances() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [adjusting, setAdjusting] = useState(null);
  const r = useQuery({ queryKey: ['leave-balances', dq], queryFn: () => api.get('/leave/balances', { q: dq }) });
  const rows = r.data?.data ?? [];
  // Only types that keep a balance get a column.
  const types = [];
  for (const row of rows) for (const t of row.types ?? []) if (t.closing !== null && !types.some((x) => x.code === t.code)) types.push({ code: t.code, name: t.name, auto: t.auto_apply });
  const year = rows.find((x) => x.year)?.year;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <Input className="w-64" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or code" aria-label="Search" />
        {year && (
          <span className="text-[13px] text-muted-foreground">
            Leave year {monthLabel(year.start)} to {monthLabel(year.end)}, as of {r.data.meta.date}
          </span>
        )}
      </div>
      {r.isLoading ? (
        <SkeletonRows rows={8} />
      ) : r.isError ? (
        <ErrorState error={r.error} />
      ) : !rows.length ? (
        <EmptyState title="Nobody here" body="Balances show for everyone active or leaving." />
      ) : (
        <div className="max-h-[65vh] overflow-auto">
          <div className="overflow-x-auto"><table className="data-table w-full">
            <thead className="sticky top-0">
              <tr>
                <th className="sticky left-0">Name</th>
                {types.map((t) => (
                  <th key={t.code} className="text-right">
                    {t.name} {t.auto && <span className="font-normal">(pays absences)</span>}
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.employee.id}>
                  <td className="sticky left-0 bg-card">
                    <PersonLink id={row.employee.id} name={row.employee.name} code={row.employee.code} tab="attendance" />
                  </td>
                  {types.map((t) => {
                    const b = row.types?.find((x) => x.code === t.code);
                    if (!b) return <td key={t.code} className="text-right text-muted-foreground">—</td>;
                    const brought = b.year_opening;
                    return (
                      <td
                        key={t.code}
                        className="text-right num"
                        title={`Brought forward ${brought} · earned ${b.earned_ytd} · added by HR ${b.adjusted_ytd} · taken ${b.used_ytd} · automatic ${b.auto_ytd}`}
                      >
                        <strong>{fmt(b.balance)}</strong>
                        <span className="block text-[12px] text-muted-foreground">
                          {b.used_ytd || b.auto_ytd ? `taken ${b.used_ytd + b.auto_ytd}${b.auto_ytd ? ` (${b.auto_ytd} auto)` : ''}` : 'none taken'}
                          {b.pending > 0 ? ` · ${b.pending} pending` : ''}
                        </span>
                      </td>
                    );
                  })}
                  <td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setAdjusting(row.employee)}>
                      <SlidersHorizontal /> Adjust
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}
      <p className="border-t px-3 py-2 text-[13px] text-muted-foreground">
        Worked out month by month from each pay group's leave policy, the leave recorded, attendance and HR's adjustments. Months in a locked payroll keep the leave they were paid with. Leave is
        tracked from the first payroll run, or the first adjustment, whichever is earlier: use Adjust to enter everyone's opening balances in that month, and to correct a balance later.
      </p>
      {adjusting && <Adjust employee={adjusting} onClose={() => setAdjusting(null)} />}
    </Card>
  );
}

/** HR adds days to a balance or takes them away: opening balances when tracking starts, and corrections. */
function Adjust({ employee, onClose }) {
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const types = useQuery({ queryKey: ['leave-types', employee.id], queryFn: () => api.get('/leave/types', { employee_id: employee.id }).then((r) => r.data) });
  const list = useQuery({ queryKey: ['leave-adjustments', employee.id], queryFn: () => api.get('/leave/adjustments', { employee_id: employee.id }).then((r) => r.data) });
  const withBalance = (types.data ?? []).filter((t) => t.balance !== null);
  const [f, setF] = useState({ leave_type: '', direction: '1', days: '', date: lk?.today ?? '', reason: '' });
  const type = f.leave_type || withBalance[0]?.code || '';
  const done = () => {
    qc.invalidateQueries({ queryKey: ['leave-balances'] });
    qc.invalidateQueries({ queryKey: ['leave-adjustments', employee.id] });
    qc.invalidateQueries({ queryKey: ['leave-types', employee.id] });
    qc.invalidateQueries({ queryKey: ['emp-attendance'] });
  };
  const save = useMutation({
    mutationFn: () => api.post('/leave/adjustments', { employee_id: employee.id, leave_type: type, date: f.date, days: Number(f.days) * Number(f.direction), reason: f.reason }),
    onSuccess: () => {
      toast.success('Balance adjusted');
      done();
      setF({ ...f, days: '', reason: '' });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id) => api.del(`/leave/adjustments/${id}`),
    onSuccess: () => {
      toast.success('Adjustment removed');
      done();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const current = withBalance.find((t) => t.code === type);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      wide
      title={`Adjust leave — ${employee.name}`}
      description="Add days for an opening balance or a correction, or take days away. The change counts in the month of its date; a locked month cannot take one."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button loading={save.isPending} disabled={!type || !Number(f.days) || !f.date || f.reason.trim().length < 8} onClick={() => save.mutate()}>
            Save adjustment
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Leave type" hint={current ? `${current.balance} left today` : undefined}>
            {(id) => (
              <Select id={id} value={type} onChange={(e) => setF({ ...f, leave_type: e.target.value })}>
                {withBalance.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Add or take away">
            {(id) => (
              <Select id={id} value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>
                <option value="1">Add days</option>
                <option value="-1">Take days away</option>
              </Select>
            )}
          </Field>
          <Field label="Days">{(id) => <Input id={id} type="number" step="0.25" min="0.25" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} />}</Field>
          <Field label="Counts in the month of">{(id) => <Input id={id} type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />}</Field>
          <Field label="Reason" className="sm:col-span-4" hint="At least eight characters, e.g. “Opening balance from the old system”">
            {(id) => <Textarea id={id} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}
          </Field>
        </div>
        <div>
          <div className="mb-1 text-[13px] font-medium text-muted-foreground">Adjustments so far</div>
          {!list.data?.length ? (
            <p className="text-[14px] text-muted-foreground">None.</p>
          ) : (
            <table className="w-full text-[14px]">
              <tbody>
                {list.data.map((a) => (
                  <tr key={a.id} className="border-t">
                    <td className="py-1.5 num">{a.date}</td>
                    <td>{a.leave_type}</td>
                    <td className="text-right num">{a.days > 0 ? `+${a.days}` : a.days}</td>
                    <td className="max-w-xs truncate px-2 text-muted-foreground">{a.reason}</td>
                    <td className="text-right">
                      <Button size="icon" variant="ghost" onClick={() => remove.mutate(a.id)} aria-label="Remove adjustment">
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** HR records leave on the person's behalf, choosing from their pay group's leave types. */
function RecordLeave({ onClose }) {
  const qc = useQueryClient();
  const people = useQuery({ queryKey: ['people', 'active-leave'], queryFn: () => api.get('/employees', { 'filter[status]': 'ACTIVE,NOTICE', limit: 200 }).then((r) => r.data) });
  const [f, setF] = useState({ employee_id: '', leave_type: '', from_date: '', to_date: '', half: false, reason: '', approve: true });
  const types = useQuery({
    queryKey: ['leave-types', f.employee_id],
    queryFn: () => api.get('/leave/types', { employee_id: f.employee_id }).then((r) => r.data),
    enabled: !!f.employee_id,
  });
  const type = f.leave_type || types.data?.[0]?.code || '';
  const to = f.half ? f.from_date : f.to_date || f.from_date;
  const body = { employee_id: f.employee_id, leave_type: type, from_date: f.from_date, to_date: to, days: f.half ? 0.5 : 1, reason: f.reason || undefined };
  const ready = !!f.employee_id && !!type && !!f.from_date && to >= f.from_date;
  const check = useQuery({
    queryKey: ['leave-preview', body],
    queryFn: () => api.post('/leave/preview', body).then((r) => r.data),
    enabled: ready,
    placeholderData: (p) => p,
  });
  const save = useMutation({
    mutationFn: async () => {
      const r = await api.post('/leave', body);
      if (f.approve) await api.post(`/leave/${r.data.id}/decide`, { decision: 'APPROVE' });
      return r;
    },
    onSuccess: (r) => {
      toast.success(r.warnings?.length ? `Leave recorded. ${r.warnings[0]}` : 'Leave recorded');
      qc.invalidateQueries({ queryKey: ['leave'] });
      qc.invalidateQueries({ queryKey: ['leave-balances'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const chosen = types.data?.find((t) => t.code === type);
  const c = ready ? check.data : null;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Record leave"
      description="Choose from the leave types in the person's pay group. Absences nobody records are paid from paid leave automatically."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!ready || !!c?.errors?.length} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Person" className="sm:col-span-2">
          {(id) => (
            <Select id={id} value={f.employee_id} onChange={(e) => setF({ ...f, employee_id: e.target.value, leave_type: '' })}>
              <option value="">Choose…</option>
              {people.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.code})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Type" className="sm:col-span-2" hint={chosen ? (chosen.balance !== null ? `${chosen.balance} days left today` : chosen.paid ? (chosen.allowance === 'PER_OCCASION' ? `${chosen.per_occasion} working days each time` : 'Paid, no balance') : 'Unpaid') : undefined}>
          {(id) => (
            <Select id={id} value={type} disabled={!f.employee_id} onChange={(e) => setF({ ...f, leave_type: e.target.value })}>
              {!f.employee_id && <option value="">Choose a person first</option>}
              {types.data?.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.name}
                  {t.paid ? '' : ' (unpaid)'}
                  {t.balance !== null ? ` — ${t.balance} left` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="From">{(id) => <Input id={id} type="date" value={f.from_date} onChange={(e) => setF({ ...f, from_date: e.target.value })} />}</Field>
        <Field label="To">{(id) => <Input id={id} type="date" value={to} min={f.from_date} disabled={f.half} onChange={(e) => setF({ ...f, to_date: e.target.value })} />}</Field>
        <label className="flex items-center gap-2 text-[14px] sm:col-span-2">
          <input type="checkbox" checked={f.half} onChange={(e) => setF({ ...f, half: e.target.checked })} /> Half a day (the other half is worked)
        </label>
        <Field label="Reason" className="sm:col-span-2">
          {(id) => <Textarea id={id} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />}
        </Field>
        <label className="flex items-center gap-2 text-[14px] sm:col-span-2">
          <input type="checkbox" checked={f.approve} onChange={(e) => setF({ ...f, approve: e.target.checked })} /> Approve now
        </label>
        {c && (
          <div className="sm:col-span-2">
            {c.errors.length > 0 ? (
              <Notice tone="destructive">{c.errors.join(' ')}</Notice>
            ) : (
              <Notice tone={c.warnings.length ? 'warning' : 'info'}>
                <span className="font-medium">
                  {c.working_days} working {c.working_days === 1 ? 'day' : 'days'} of {c.type?.name}.
                </span>{' '}
                {c.warnings.join(' ') || (c.type?.paid ? 'All of it is paid.' : '')}
              </Notice>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
