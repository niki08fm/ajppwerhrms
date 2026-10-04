import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { addDays, DAY_STATUSES, DAY_STATUS_LABELS } from '@ajpwer/shared';
import { api, errorMessage, qs } from '@/services/api';
import { useListParams } from '@/hooks';
import { opts, useLookups } from '@/hooks/useLookups';
import { cn, hhmm, longDate, mins } from '@/utils';
import { Mono, PageHeader } from '@/components/bits';
import { DataTable } from '@/components/data-table';
import { ListToolbar } from '@/components/list-toolbar';
import { Chip, DayChip, EmptyState, ErrorState, LockedNotice, NoMatches, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input, Segmented } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { CorrectionDrawer } from '../../components/attendance/CorrectionDrawer';
import { DayPicker } from '@/components/attendance/DayPicker';
import { TONE, deptColour, fullDate, viewsFor } from '@/components/attendance/dayVocab';
import { DeptAvatar } from '@/components/attendance/DeptAvatar';
import { NumberPager } from '@/components/attendance/NumberPager';
import { AttendanceTabs, MonthRegister } from '@/components/attendance/MonthRegister';

/** Attendance: the daily register (one day, everyone) or the monthly register (one month, everyone). */
export default function Register() {
  const [sp] = useSearchParams();
  return sp.get('tab') === 'month' ? <MonthRegister /> : <DailyRegister />;
}

/** One day, everyone. The filter chips use the same names and counts as the cards on Today. */
function DailyRegister() {
  const lp = useListParams({ sort: 'name' });
  const nav = useNavigate();
  const { data: lk } = useLookups();
  const today = lk?.today ?? new Date().toISOString().slice(0, 10);
  const date = lp.searchParams.get('date') ?? today;
  const view = lp.searchParams.get('view') ?? '';
  const page = Math.max(1, Number(lp.searchParams.get('page') ?? 1));
  const limit = [20, 50, 100].includes(Number(lp.searchParams.get('limit'))) ? Number(lp.searchParams.get('limit')) : 20;
  const params = useMemo(() => {
    const p = { ...lp.apiParams, date, limit, page };
    for (const k of ['filter[date]', 'filter[view]', 'filter[page]', 'filter[limit]']) delete p[k];
    if (view) p['filter[view]'] = view;
    return p;
  }, [lp.apiParams, date, view, limit, page]);
  const list = useQuery({ queryKey: ['register', params], queryFn: () => api.get('/attendance', params), placeholderData: keepPreviousData, enabled: !!date });
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  const [open, setOpen] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [bulk, setBulk] = useState(false);
  const siteName = (id) => lk?.sites.find((s) => s.id === id)?.name ?? id;
  const dept = (id) => lk?.departments.find((x) => x.id === id);
  const frozen = meta?.frozen;
  const isToday = date === today;
  const summary = meta?.summary ?? {};
  // Changing what is shown starts again at page 1.
  const setF = (patch) => lp.set({ ...patch, page: null });

  const filters = [
    { key: 'dept', label: 'Department', options: opts(lk?.departments) },
    { key: 'pay_group', label: 'Pay group', options: opts(lk?.pay_groups) },
    { key: 'site', label: 'Site punched at', options: opts(lk?.sites) },
    { key: 'status', label: 'Day counts as', options: DAY_STATUSES.map((s) => ({ value: s, label: DAY_STATUS_LABELS[s] })) },
    { key: 'corrected', label: 'Has correction', options: [{ value: 'yes', label: 'Corrected' }] },
  ];
  const quiet = (v, text, tone) => (v ? <span className={tone}>{text}</span> : <span className="text-muted-foreground/60">—</span>);
  const cols = [
    {
      id: 'name',
      header: 'Employee',
      sortKey: 'name',
      sticky: true,
      width: 230,
      cell: (r) => (
        <span className="flex items-center gap-2.5">
          <DeptAvatar name={r.employee.name} token={r.employee.department.colour ?? dept(r.employee.department.id)?.colour} />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate font-medium">{r.employee.name}</span>
            <span className="truncate text-[12px] text-muted-foreground">
              <Mono>{r.employee.code}</Mono> · {r.employee.department.name}
            </span>
          </span>
        </span>
      ),
    },
    { id: 'sites', header: 'Sites', cell: (r) => (r.day.sites.length ? r.day.sites.map(siteName).join(' → ') : <span className="text-muted-foreground/60">—</span>) },
    { id: 'in', header: 'In', sortKey: 'in', align: 'right', cell: (r) => hhmm(r.in_min) },
    { id: 'out', header: 'Out', align: 'right', cell: (r) => (r.open_now ? <Chip tone="info">On site</Chip> : r.day.status === 'MISSING_PUNCH' && !r.override ? <Chip tone="destructive">No punch-out</Chip> : hhmm(r.out_min)) },
    { id: 'worked', header: 'Worked', sortKey: 'worked', align: 'right', cell: (r) => quiet(r.live?.worked_min ?? r.day.worked_min, mins(r.live?.worked_min ?? r.day.worked_min)) },
    { id: 'late', header: 'Late', sortKey: 'late', align: 'right', cell: (r) => quiet(r.day.late_min, mins(r.day.late_min), 'text-warning-foreground dark:text-warning') },
    {
      id: 'early',
      header: 'Short',
      sortKey: 'early',
      align: 'right',
      cell: (r) => quiet(!r.open_now && r.day.early_min, <span title={`Day ended ${hhmm(r.day.due_out_min)}`}>{mins(r.day.early_min)}</span>, 'text-destructive'),
    },
    { id: 'ot', header: 'OT', sortKey: 'ot', align: 'right', cell: (r) => quiet(r.live?.ot_min ?? r.day.ot_min, mins(r.live?.ot_min ?? r.day.ot_min)) },
    {
      id: 'status',
      header: 'Day counts as',
      cell: (r) => (r.open_now && r.day.status === 'MISSING_PUNCH' ? <Chip tone="info">On site now</Chip> : <DayChip status={r.day.status} overridden={!!r.override} />),
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
  const setDate = (d) => {
    setSelected(new Set());
    setF({ date: d === today ? null : d });
  };
  const filtered = !!lp.q || !!view || Object.keys(lp.filters).filter((k) => !['date', 'view', 'page', 'limit'].includes(k)).length > 0;
  const chips = [{ key: '', label: 'Everyone', n: summary.everyone, colour: 'var(--muted-foreground)' }, ...viewsFor(isToday).map((v) => ({ key: v.key, label: v.label, n: summary[v.key], colour: v.colour === 'var(--foreground)' ? 'var(--primary)' : v.colour }))];
  // "No punch-out" shows on today too when yesterday's door is still open for someone.
  if (isToday && summary.nopunch) chips.splice(3, 0, { key: 'nopunch', label: 'No punch-out', n: summary.nopunch, colour: TONE.bad });
  const shownDepts = (lk?.departments ?? []).filter((x) => x.colour);

  return (
    <div>
      <PageHeader
        title="Attendance"
        description={`${fullDate(date)}. Computed from the punch ledger; corrections are layered on top and never edit a punch.`}
        meta={
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="outline" size="icon" onClick={() => setDate(addDays(date, -1))} aria-label="Previous day">
              <ChevronLeft />
            </Button>
            <DayPicker date={date} today={today} onChange={setDate} />
            <Button variant="outline" size="icon" onClick={() => setDate(addDays(date, 1))} disabled={date >= today} aria-label="Next day">
              <ChevronRight />
            </Button>
          </div>
        }
      />
      <AttendanceTabs active="day" />

      {frozen?.frozen && (
        <div className="mb-3">
          <LockedNotice title="This month's attendance is submitted">{frozen.reason}</LockedNotice>
        </div>
      )}
      <div className="mb-2 flex flex-wrap gap-2">
        {chips
          .filter((c) => c.key === '' || c.key === view || c.n > 0)
          .map((c) => {
            const on = view === c.key;
            return (
              <button
                key={c.key || 'all'}
                type="button"
                aria-pressed={on}
                onClick={() => setF({ view: c.key || null })}
                className={cn('inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium transition-colors', on ? 'border-primary bg-secondary' : 'bg-card hover:border-primary/40')}
              >
                <span className="size-2 rounded-full" style={{ background: c.colour }} />
                {c.label} <b className="font-semibold num">{c.n ?? '·'}</b>
              </button>
            );
          })}
      </div>
      {shownDepts.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          <span className="text-[11px] font-semibold tracking-wide uppercase">Circle = department</span>
          {shownDepts.map((x) => (
            <span key={x.id} className="inline-flex items-center gap-1">
              <span className="size-2.5 rounded-full" style={{ background: deptColour(x.colour) }} />
              {x.name}
            </span>
          ))}
        </div>
      )}
      <Card className="overflow-hidden">
        <ListToolbar
          q={lp.q}
          onQ={(q) => setF({ q })}
          placeholder="Search name or code"
          searching="name and employee code"
          filters={filters}
          values={Object.fromEntries(Object.entries(lp.filters).filter(([k]) => !['date', 'view', 'page', 'limit'].includes(k)))}
          onFilter={(k, v) => setF({ [k]: v })}
          onClear={() => {
            lp.clearFilters();
            lp.set({ date: date === today ? null : date });
          }}
          list="attendance"
          searchParams={lp.searchParams}
          onApplyView={(q) => nav(`/attendance?${q}`)}
          exportPath={`/attendance${qs({ ...params, format: 'csv', limit: undefined, page: undefined })}`}
          exportName={`attendance-${date}.csv`}
          total={meta?.total ?? 0}
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
        ) : !rows.length ? (
          filtered ? (
            <NoMatches onClear={() => setF({ view: null, q: null })} />
          ) : (
            <EmptyState title="Nobody is employed on this date" body="Activate people from Offers and onboarding; they appear here from their joining date." />
          )
        ) : (
          <DataTable
            columns={cols}
            rows={rows}
            rowId={(r) => r.employee.id}
            sort={lp.sort}
            onSort={lp.toggleSort}
            onRowClick={(r) => setOpen(r.employee.id)}
            selectable={!frozen?.frozen}
            selected={selected}
            onSelectedChange={setSelected}
            fetching={list.isFetching && !list.isLoading}
            maxHeight="720px"
          />
        )}
        <NumberPager
          page={meta?.page ?? page}
          pages={meta?.pages ?? 1}
          total={meta?.total ?? 0}
          limit={limit}
          onPage={(n) => lp.set({ page: n > 1 ? String(n) : null })}
          onLimit={(n) => lp.set({ limit: n === 20 ? null : String(n), page: null })}
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
