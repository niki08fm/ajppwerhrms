import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LayoutGrid, List, Plus, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { EMPLOYEE_STATUSES, PT_STATES } from '@ajpwer/shared';
import { api, errorMessage, qs } from '@/services/api';
import { useKeysetList, useListParams, useNewFromUrl } from '@/hooks';
import { opts, useLookups } from '@/hooks/useLookups';
import { initials } from '@/utils';
import { Mono, PageHeader } from '@/components/bits';
import { DataTable, Pager } from '@/components/data-table';
import { ListToolbar } from '@/components/list-toolbar';
import { Chip, EmployeeStatusChip, EmptyState, ErrorState, NoMatches, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { useLocalStorage } from '@/hooks';
import { NewEmployeeDialog } from '../../components/people/NewEmployeeDialog';

export default function People() {
  const lp = useListParams({ sort: 'name' });
  const { data: lk } = useLookups();
  const nav = useNavigate();
  const [view, setView] = useLocalStorage('people.view', 'table');
  const [selected, setSelected] = useState(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [bulk, setBulk] = useState(null);
  const [creating, setCreating] = useState(false);
  useNewFromUrl(useCallback(() => setCreating(true), []));
  const list = useKeysetList(['people'], '/employees', lp.apiParams);

  const filters = useMemo(
    () => [
      { key: 'dept', label: 'Department', options: opts(lk?.departments) },
      { key: 'pay_group', label: 'Pay group', options: opts(lk?.pay_groups) },
      { key: 'status', label: 'Status', options: EMPLOYEE_STATUSES.map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() })) },
      { key: 'pt_state', label: 'PT state', options: (lk?.pt_states ?? [...PT_STATES]).map((s) => ({ value: s, label: s })) },
      {
        key: 'regime',
        label: 'Tax regime',
        options: [
          { value: 'NEW', label: 'New' },
          { value: 'OLD', label: 'Old' },
        ],
      },
      {
        key: 'bank',
        label: 'Bank account',
        options: [
          { value: 'has', label: 'Has bank' },
          { value: 'none', label: 'No bank' },
        ],
      },
      {
        key: 'pf',
        label: 'PF',
        options: [
          { value: 'on', label: 'PF on' },
          { value: 'off', label: 'PF off' },
        ],
      },
      { key: 'uan', label: 'UAN', options: [{ value: 'none', label: 'No UAN' }] },
      { key: 'joined_from', label: 'Joined from', type: 'date' },
      { key: 'joined_to', label: 'Joined to', type: 'date' },
    ],
    [lk],
  );

  const columns = [
    {
      id: 'name',
      header: 'Name',
      sortKey: 'name',
      sticky: true,
      width: 230,
      cell: (r) => (
        <Link to={`/people/${r.id}`} className="flex items-center gap-2 hover:underline" onClick={(e) => e.stopPropagation()}>
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold">{initials(r.name)}</span>
          <span className="truncate font-medium">{r.name}</span>
        </Link>
      ),
    },
    { id: 'code', header: 'Code', sortKey: 'code', width: 80, cell: (r) => <Mono>{r.code}</Mono> },
    { id: 'designation', header: 'Designation', sortKey: 'designation', cell: (r) => r.designation },
    { id: 'dept', header: 'Department', cell: (r) => r.department.name },
    { id: 'group', header: 'Pay group', cell: (r) => r.pay_group.name },
    { id: 'status', header: 'Status', sortKey: 'status', cell: (r) => <EmployeeStatusChip status={r.status} /> },
    { id: 'joined', header: 'Joined', sortKey: 'joined', cell: (r) => <span className="num">{r.joined_on}</span> },
    { id: 'pt', header: 'PT state', cell: (r) => r.pt_state ?? '—' },
    { id: 'regime', header: 'Regime', cell: (r) => (r.tax_regime === 'OLD' ? 'Old' : 'New') },
    {
      id: 'flags',
      header: 'Gaps',
      cell: (r) => (
        <span className="flex gap-1">
          {!r.has_bank && <Chip tone="destructive">No bank</Chip>}
          {!r.has_uan && r.pf_enabled && <Chip tone="warning">No UAN</Chip>}
        </span>
      ),
    },
  ];

  const filtered = !!lp.q || Object.keys(lp.filters).length > 0;
  const selCount = allMatching ? list.total : selected.size;

  return (
    <div>
      <PageHeader
        title="People"
        description="Everyone, whatever their status. Pay rules come from the pay group, never the person."
        actions={
          <>
            <div className="flex rounded-md border">
              <Button variant={view === 'table' ? 'secondary' : 'ghost'} size="sm" onClick={() => setView('table')} aria-label="Table view" aria-pressed={view === 'table'}>
                <List />
              </Button>
              <Button variant={view === 'cards' ? 'secondary' : 'ghost'} size="sm" onClick={() => setView('cards')} aria-label="Card view" aria-pressed={view === 'cards'}>
                <LayoutGrid />
              </Button>
            </div>
            <Button variant="outline" onClick={() => nav('/offers')}>
              <UserPlus /> Issue an offer
            </Button>
            <Button onClick={() => setCreating(true)}>
              <Plus /> Add existing employee
            </Button>
          </>
        }
      />

      <Card>
        <ListToolbar
          q={lp.q}
          onQ={(q) => lp.set({ q })}
          placeholder="Search name, code, designation, phone"
          searching="name, employee code, designation and phone"
          filters={filters}
          values={lp.filters}
          onFilter={(k, v) => lp.set({ [k]: v })}
          onClear={lp.clearFilters}
          list="people"
          searchParams={lp.searchParams}
          onApplyView={(q) => nav(`/people?${q}`)}
          exportPath={`/employees/export${qs(lp.apiParams)}`}
          exportName="people.csv"
          total={list.total}
        />

        {selCount > 0 && (
          <div className="no-print flex flex-wrap items-center gap-2 border-b bg-accent/50 px-3 py-2 text-[14px]">
            <span className="font-medium">{selCount.toLocaleString('en-IN')} selected</span>
            {!allMatching && selected.size === list.rows.length && list.total > list.rows.length && (
              <button className="text-primary hover:underline" onClick={() => setAllMatching(true)}>
                Select all {list.total.toLocaleString('en-IN')} matching
              </button>
            )}
            <div className="flex-1" />
            <Button size="sm" variant="outline" onClick={() => setBulk('pay_group')}>
              Change pay group
            </Button>
            <Button size="sm" variant="outline" onClick={() => setBulk('pt_state')}>
              Change PT state
            </Button>
            <Button size="sm" variant="outline" onClick={() => setBulk('tax_regime')}>
              Change tax regime
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSelected(new Set());
                setAllMatching(false);
              }}
            >
              Clear
            </Button>
          </div>
        )}
        {list.isLoading ? (
          <SkeletonRows rows={12} cols={8} />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : list.rows.length === 0 ? (
          filtered ? (
            <NoMatches onClear={lp.clearFilters} />
          ) : (
            <EmptyState title="No people yet" body="Issue an offer to start hiring, or add someone already on the payroll." action={<Button onClick={() => nav('/offers')}>Issue an offer</Button>} />
          )
        ) : view === 'table' ? (
          <DataTable
            columns={columns}
            rows={list.rows}
            rowId={(r) => r.id}
            sort={lp.sort}
            onSort={lp.toggleSort}
            onRowClick={(r) => nav(`/people/${r.id}`)}
            selectable
            selected={selected}
            onSelectedChange={(s) => {
              setSelected(s);
              setAllMatching(false);
            }}
            fetching={list.isFetching && !list.isLoading}
            caption="People"
          />
        ) : (
          <div className={`grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-4 ${list.isFetching ? 'opacity-60' : ''}`}>
            {list.rows.map((r) => (
              <Link key={r.id} to={`/people/${r.id}`} className="rounded-lg border bg-card p-3 hover:border-primary/40">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-full font-semibold text-primary-foreground" style={{ background: `var(--${r.department.colour})` }}>
                    {initials(r.name)}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate font-medium">{r.name}</div>
                    <div className="truncate text-[13px] text-muted-foreground">
                      {r.designation} · <Mono>{r.code}</Mono>
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1">
                  <EmployeeStatusChip status={r.status} />
                  <Chip>{r.department.name}</Chip>
                  <Chip>{r.pay_group.name}</Chip>
                  {!r.has_bank && <Chip tone="destructive">No bank</Chip>}
                </div>
              </Link>
            ))}
          </div>
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
      {bulk && (
        <BulkDialog
          action={bulk}
          ids={allMatching ? undefined : [...selected]}
          match={allMatching ? { q: lp.q || null, filter: lp.filters } : undefined}
          onClose={() => setBulk(null)}
          onDone={() => {
            setSelected(new Set());
            setAllMatching(false);
          }}
        />
      )}
      <NewEmployeeDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

/** A bulk change that affects pay shows exactly how many people and what changes before confirming. */
function BulkDialog({ action, ids, match, onClose, onDone }) {
  const { data: lk } = useLookups();
  const qc = useQueryClient();
  const [value, setValue] = useState('');
  const [preview, setPreview] = useState(null);
  const body = { ids, match, action, value };
  const doPreview = useMutation({
    mutationFn: () => api.post('/employees/bulk', { ...body, confirm: false }).then((r) => r.data),
    onSuccess: setPreview,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const apply = useMutation({
    mutationFn: () => api.post('/employees/bulk', { ...body, confirm: true }),
    onSuccess: (r) => {
      toast.success(`Changed ${r.data.applied} people. One audit entry was written for each.`);
      qc.invalidateQueries({ queryKey: ['people'] });
      onDone();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const title = action === 'pay_group' ? 'Change pay group' : action === 'pt_state' ? 'Change PT state' : 'Change tax regime';
  const options =
    action === 'pay_group'
      ? opts(lk?.pay_groups)
      : action === 'pt_state'
        ? (lk?.pt_states ?? []).map((s) => ({ value: s, label: s }))
        : [
            { value: 'NEW', label: 'New regime' },
            { value: 'OLD', label: 'Old regime' },
          ];
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      wide
      description={action === 'pay_group' ? 'Moving someone changes their calendar, weekly off, shift, salary structure and every policy at once.' : undefined}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {!preview ? (
            <Button disabled={!value} loading={doPreview.isPending} onClick={() => doPreview.mutate()}>
              Preview the change
            </Button>
          ) : (
            <Button disabled={!preview.count} loading={apply.isPending} onClick={() => apply.mutate()}>
              Change {preview.count} {preview.count === 1 ? 'person' : 'people'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Select
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setPreview(null);
          }}
          aria-label="New value"
        >
          <option value="">Choose…</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        {preview && (
          <>
            <p className="text-[14px]">
              <strong>{preview.count}</strong> of {preview.selected} selected will change. {preview.selected - preview.count > 0 && `${preview.selected - preview.count} already have this value.`}
            </p>
            <div className="max-h-72 overflow-y-auto rounded border">
              <table className="w-full text-[13px]">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-left text-muted-foreground">
                    <th className="px-2 py-1">Person</th>
                    <th className="px-2 py-1">Before</th>
                    <th className="px-2 py-1">After</th>
                    {action === 'pay_group' && <th className="px-2 py-1">Day rate</th>}
                  </tr>
                </thead>
                <tbody>
                  {preview.changes.map((c) => (
                    <tr key={c.id} className="border-t">
                      <td className="px-2 py-1">
                        {c.name} <Mono className="text-muted-foreground">{c.code}</Mono>
                      </td>
                      <td className="px-2 py-1">{c.from}</td>
                      <td className="px-2 py-1">{c.to}</td>
                      {action === 'pay_group' && <td className="px-2 py-1 num">{c.note}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
