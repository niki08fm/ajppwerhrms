import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { addDays, DAY_STATUSES, DAY_STATUS_LABELS } from '@ajpwer/shared';
import { api, errorMessage, qs } from '@/services/api';
import { useKeysetList, useListParams } from '@/hooks';
import { opts, useLookups } from '@/hooks/useLookups';
import { hhmm, longDate, mins } from '@/utils';
import { PageHeader, PersonLink } from '@/components/bits';
import { DataTable, Pager } from '@/components/data-table';
import { ListToolbar } from '@/components/list-toolbar';
import { Chip, DayChip, EmptyState, ErrorState, LockedNotice, NoMatches, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, Segmented, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { CorrectionDrawer } from '../../components/attendance/CorrectionDrawer';

/** One day, everyone. */
export default function Register() {
  const lp = useListParams({ sort: 'name' });
  const nav = useNavigate();
  const { data: lk } = useLookups();
  const date = lp.searchParams.get('date') ?? lk?.today ?? new Date().toISOString().slice(0, 10);
  const params = useMemo(() => {
    const p = { ...lp.apiParams, date };
    delete p['filter[date]'];
    return p;
  }, [lp.apiParams, date]);
  const list = useKeysetList(['register'], '/attendance', params, !!date);
  const [open, setOpen] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [bulk, setBulk] = useState(false);
  const siteName = (id) => lk?.sites.find((s) => s.id === id)?.name ?? id;
  const counts = list.meta?.counts ?? {};
  const frozen = list.meta?.frozen;

  const filters = [
    { key: 'dept', label: 'Department', options: opts(lk?.departments) },
    { key: 'pay_group', label: 'Pay group', options: opts(lk?.pay_groups) },
    { key: 'site', label: 'Site punched at', options: opts(lk?.sites) },
    { key: 'status', label: 'Status', options: DAY_STATUSES.map((s) => ({ value: s, label: DAY_STATUS_LABELS[s] })) },
    { key: 'corrected', label: 'Has correction', options: [{ value: 'yes', label: 'Corrected' }] },
    { key: 'late', label: 'Late only', options: [{ value: 'yes', label: 'Late' }] },
    { key: 'early', label: 'Left early only', options: [{ value: 'yes', label: 'Left early' }] },
    { key: 'ot', label: 'Overtime only', options: [{ value: 'yes', label: 'Overtime' }] },
  ];
  const cols = [
    { id: 'name', header: 'Name', sortKey: 'name', sticky: true, width: 210, cell: (r) => <PersonLink id={r.employee.id} name={r.employee.name} code={r.employee.code} tab="attendance" /> },
    { id: 'dept', header: 'Department', cell: (r) => r.employee.department.name },
    { id: 'in', header: 'In', sortKey: 'in', align: 'right', cell: (r) => hhmm(r.in_min) },
    { id: 'out', header: 'Out', align: 'right', cell: (r) => (r.open_now ? <Chip tone="info">On site</Chip> : hhmm(r.out_min)) },
    { id: 'worked', header: 'Hours', sortKey: 'worked', align: 'right', cell: (r) => (r.day.worked_min ? mins(r.day.worked_min) : '—') },
    { id: 'late', header: 'Late', sortKey: 'late', align: 'right', cell: (r) => (r.day.late_min ? <span className="text-warning-foreground dark:text-warning">{mins(r.day.late_min)}</span> : '—') },
    {
      id: 'early',
      header: 'Left early',
      sortKey: 'early',
      align: 'right',
      cell: (r) => (r.day.early_min ? <span className="text-warning-foreground dark:text-warning" title={`Day ended ${hhmm(r.day.due_out_min)}`}>{mins(r.day.early_min)}</span> : '—'),
    },
    { id: 'ot', header: 'OT', sortKey: 'ot', align: 'right', cell: (r) => (r.day.ot_min ? mins(r.day.ot_min) : '—') },
    { id: 'sites', header: 'Sites', cell: (r) => (r.day.sites.length ? r.day.sites.map(siteName).join(' + ') : '—') },
    {
      id: 'status',
      header: 'Status',
      cell: (r) => (r.open_now && r.day.status === 'MISSING_PUNCH' ? <Chip tone="info">In, not out yet</Chip> : <DayChip status={r.day.status} overridden={!!r.override} />),
    },
    {
      id: 'fix',
      header: '',
      align: 'right',
      cell: (r) => (
        <Button
          size="sm"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(r.employee.id);
          }}
        >
          <Wrench /> Correct
        </Button>
      ),
    },
  ];
  const setDate = (d) => lp.set({ date: d });
  const filtered = !!lp.q || Object.keys(lp.filters).filter((k) => k !== 'date').length > 0;

  return (
    <div>
      <PageHeader
        title="Attendance"
        description={`${longDate(date)}. Computed from the punch ledger; corrections are layered on top and never edit a punch.`}
        meta={
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" onClick={() => setDate(addDays(date, -1))} aria-label="Previous day">
              <ChevronLeft />
            </Button>
            <Input type="date" className="w-40" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
            <Button variant="outline" size="icon" onClick={() => setDate(addDays(date, 1))} aria-label="Next day">
              <ChevronRight />
            </Button>
          </div>
        }
      />

      {frozen?.frozen && (
        <div className="mb-3">
          <LockedNotice title="This month's attendance is submitted">{frozen.reason}</LockedNotice>
        </div>
      )}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([s, n]) => (
            <button key={s} onClick={() => lp.set({ status: lp.filters.status === s ? null : s })} className={`rounded-full ${lp.filters.status === s ? 'ring-2 ring-ring' : ''}`}>
              <DayChip status={s} /> <span className="sr-only">{n}</span>
              <span className="ml-0.5 text-[13px] num">{n}</span>
            </button>
          ))}
      </div>
      <Card>
        <ListToolbar
          q={lp.q}
          onQ={(q) => lp.set({ q })}
          placeholder="Search name or code"
          searching="name and employee code"
          filters={filters}
          values={Object.fromEntries(Object.entries(lp.filters).filter(([k]) => k !== 'date'))}
          onFilter={(k, v) => lp.set({ [k]: v })}
          onClear={() => {
            lp.clearFilters();
            lp.set({ date });
          }}
          list="attendance"
          searchParams={lp.searchParams}
          onApplyView={(q) => nav(`/attendance?${q}`)}
          exportPath={`/attendance${qs({ ...params, format: 'csv', limit: undefined, cursor: undefined })}`}
          exportName={`attendance-${date}.csv`}
          total={list.total}
        >
          {selected.size > 0 && !frozen?.frozen && (
            <Button size="sm" onClick={() => setBulk(true)}>
              Correct {selected.size} days with one reason
            </Button>
          )}
        </ListToolbar>
        {list.isLoading ? (
          <SkeletonRows rows={12} cols={9} />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : !list.rows.length ? (
          filtered ? (
            <NoMatches onClear={lp.clearFilters} />
          ) : (
            <EmptyState title="Nobody is employed on this date" body="Activate people from Offers and onboarding; they appear here from their joining date." />
          )
        ) : (
          <DataTable
            columns={cols}
            rows={list.rows}
            rowId={(r) => r.employee.id}
            sort={lp.sort}
            onSort={lp.toggleSort}
            onRowClick={(r) => setOpen(r.employee.id)}
            selectable={!frozen?.frozen}
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
      {open && <CorrectionDrawer employeeId={open} date={date} open onOpenChange={(o) => !o && setOpen(null)} />}
      {bulk && <BulkCorrect ids={[...selected]} date={date} onClose={() => setBulk(false)} onDone={() => setSelected(new Set())} />}
    </div>
  );
}

function BulkCorrect({ ids, date, onClose, onDone }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ status: 'PRESENT', ot: '0', reason_text: '' });
  const save = useMutation({
    mutationFn: () =>
      api.post('/attendance/overrides/bulk', {
        items: ids.map((employee_id) => ({ employee_id, work_date: date })),
        status: f.status,
        ot_min: f.status === 'PRESENT' ? Math.round(Number(f.ot || 0) * 60) : 0,
        reason_text: f.reason_text,
      }),
    onSuccess: (r) => {
      const failed = r.data.results.filter((x) => !x.ok);
      toast.success(`Marked ${r.data.applied} of ${ids.length}.${failed.length ? ` ${failed.length} skipped: ${failed[0].message}` : ''}`);
      qc.invalidateQueries({ queryKey: ['register'] });
      onDone();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Mark ${ids.length} ${ids.length === 1 ? 'person' : 'people'} for ${longDate(date)}`}
      description="The same mark and one reason for each. To give someone their own in and out times, open their day instead."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={f.reason_text.trim().length < 3} onClick={() => save.mutate()}>
            Mark {ids.length}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <Segmented
            label="Mark"
            value={f.status}
            onChange={(status) => setF({ ...f, status })}
            options={[
              { value: 'PRESENT', label: 'Full day' },
              { value: 'HALF_DAY', label: 'Half day' },
              { value: 'ABSENT', label: 'Absent' },
            ]}
          />
          {f.status === 'PRESENT' && (
            <Field label="Overtime (hours)" className="w-36">
              {(id) => <Input id={id} type="number" min={0} step={0.5} value={f.ot} onChange={(e) => setF({ ...f, ot: e.target.value })} />}
            </Field>
          )}
        </div>
        <Field label="Reason" required>
          {(id) => <Input id={id} value={f.reason_text} placeholder="e.g. Tablet at the site was down all day" onChange={(e) => setF({ ...f, reason_text: e.target.value })} />}
        </Field>
      </div>
    </Dialog>
  );
}
