import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { addDays, DAY_STATUSES, DAY_STATUS_LABELS, OVERRIDE_REASONS, OVERRIDE_REASON_LABELS } from '@ajpwer/shared';
import { api, errorMessage, qs } from '@/lib/api';
import { useKeysetList, useListParams } from '@/lib/hooks';
import { opts, useLookups } from '@/lib/lookups';
import { hhmm, longDate, mins } from '@/lib/utils';
import { PageHeader, PersonLink } from '@/components/bits';
import { DataTable, Pager } from '@/components/data-table';
import { ListToolbar } from '@/components/list-toolbar';
import { Chip, DayChip, EmptyState, ErrorState, LockedNotice, NoMatches, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { CorrectionDrawer } from './CorrectionDrawer';

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
    { key: 'ot', label: 'Overtime only', options: [{ value: 'yes', label: 'Overtime' }] },
  ];
  const cols = [
    { id: 'name', header: 'Name', sortKey: 'name', sticky: true, width: 210, cell: (r) => <PersonLink id={r.employee.id} name={r.employee.name} code={r.employee.code} tab="attendance" /> },
    { id: 'dept', header: 'Department', cell: (r) => r.employee.department.name },
    { id: 'in', header: 'In', sortKey: 'in', align: 'right', cell: (r) => hhmm(r.in_min) },
    { id: 'out', header: 'Out', align: 'right', cell: (r) => (r.open_now ? <Chip tone="info">On site</Chip> : hhmm(r.out_min)) },
    { id: 'worked', header: 'Hours', sortKey: 'worked', align: 'right', cell: (r) => (r.day.worked_min ? mins(r.day.worked_min) : '—') },
    { id: 'late', header: 'Late', sortKey: 'late', align: 'right', cell: (r) => (r.day.late_min ? <span className="text-warning-foreground dark:text-warning">{r.day.late_min}m</span> : '—') },
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
              <span className="ml-0.5 text-[12px] num">{n}</span>
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
  const [f, setF] = useState({ status: 'PRESENT', day_value: '1', worked_min: '480', reason_code: '', reason_text: '' });
  const save = useMutation({
    mutationFn: () =>
      api.post('/attendance/overrides/bulk', {
        items: ids.map((employee_id) => ({ employee_id, work_date: date })),
        status: f.status,
        day_value: Number(f.day_value),
        worked_min: Number(f.worked_min),
        reason_code: f.reason_code,
        reason_text: f.reason_text,
      }),
    onSuccess: (r) => {
      const failed = r.data.results.filter((x) => !x.ok);
      toast.success(`Corrected ${r.data.applied} of ${ids.length}.${failed.length ? ` ${failed.length} skipped: ${failed[0].message}` : ''}`);
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
      title={`Correct ${ids.length} days on ${longDate(date)}`}
      description="The same correction and one reason, applied to each. One audit entry per person."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!f.reason_code || f.reason_text.trim().length < 8} onClick={() => save.mutate()}>
            Apply to {ids.length}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Status">
          {(id) => (
            <Select id={id} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              {DAY_STATUSES.filter((s) => s !== 'NOT_JOINED' && s !== 'EXITED').map((s) => (
                <option key={s} value={s}>
                  {DAY_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Day value">
          {(id) => (
            <Select id={id} value={f.day_value} onChange={(e) => setF({ ...f, day_value: e.target.value })}>
              {['0', '0.5', '1'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Worked (min)">{(id) => <Input id={id} type="number" value={f.worked_min} onChange={(e) => setF({ ...f, worked_min: e.target.value })} />}</Field>
        <Field label="Category" className="sm:col-span-3">
          {(id) => (
            <Select id={id} value={f.reason_code} onChange={(e) => setF({ ...f, reason_code: e.target.value })}>
              <option value="">Choose…</option>
              {OVERRIDE_REASONS.map((r) => (
                <option key={r} value={r}>
                  {OVERRIDE_REASON_LABELS[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Explanation" className="sm:col-span-3" hint="At least eight characters">
          {(id) => <Textarea id={id} value={f.reason_text} onChange={(e) => setF({ ...f, reason_text: e.target.value })} />}
        </Field>
      </div>
    </Dialog>
  );
}
