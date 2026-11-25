import { useMemo, useState } from 'react';
import * as Pop from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarRange, Check, ChevronDown, Download, FileSpreadsheet, LayoutList, Search } from 'lucide-react';
import { addMonths, COMPANIES, formatYearMonth, istDate, ymOf } from '@ajpwer/shared';
import { api, download, errorMessage } from '@/services/api';
import { useSession } from '@/context/SessionContext';
import { useDebounced } from '@/hooks';
import { cn } from '@/utils';
import { Money, Mono, PageHeader, PersonLink, Stat } from '@/components/bits';
import { DataTable } from '@/components/data-table';
import { Chip, EmptyState, ErrorState, Notice, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/form';

/*
 * The report center: every payroll report over a period of months, added up, plus joiners,
 * exits and overtime hours. Periods are whole months; presets end with last month.
 */

const thisMonth = () => ymOf(istDate(new Date()));
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortYm = (ym) => `${SHORT[Number(ym.slice(5, 7)) - 1]} ’${ym.slice(2, 4)}`;
const fyStart = (ym) => `${Number(ym.slice(5, 7)) >= 4 ? ym.slice(0, 4) : Number(ym.slice(0, 4)) - 1}-04`;
const PRESETS = [
  { key: 'last', label: 'Last month', range: (now) => [addMonths(now, -1), addMonths(now, -1)] },
  { key: '3m', label: 'Last 3 months', range: (now) => [addMonths(now, -3), addMonths(now, -1)] },
  { key: '6m', label: 'Last 6 months', range: (now) => [addMonths(now, -6), addMonths(now, -1)] },
  { key: '12m', label: 'Last 12 months', range: (now) => [addMonths(now, -12), addMonths(now, -1)] },
  { key: 'fy', label: 'This tax year', range: (now) => [fyStart(addMonths(now, -1)), addMonths(now, -1)] },
  { key: 'custom', label: 'Custom', range: null },
];

const GROUP_HELP = {
  Payroll: 'Pay added up over the months',
  Statutory: 'PF, ESI, PT and TDS for the period',
  People: 'Joiners, exits, overtime and salary revisions',
  Analysis: 'Departments, settlements and one-offs',
};

/** The report chooser: a dropdown with a search box, reports grouped. */
function ReportPicker({ groups, value, onChange }) {
  const [open, setOpen] = useState(false);
  const current = groups.flatMap(([, items]) => items).find((x) => x.key === value);
  return (
    <Pop.Root open={open} onOpenChange={setOpen}>
      <Pop.Trigger asChild>
        <button
          aria-label={`Report: ${current?.label ?? 'choose'}`}
          className="flex h-10 w-full items-center gap-2 rounded-md border bg-card px-3 text-left shadow-xs hover:border-primary/40 sm:w-80"
        >
          <LayoutList className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-[13px] text-muted-foreground">Report</span>
          <span className="min-w-0 flex-1 truncate font-medium">{current?.label ?? 'Choose a report'}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </Pop.Trigger>
      <Pop.Portal>
        <Pop.Content align="start" sideOffset={6} className="z-50 w-[min(92vw,22rem)] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg">
          <Command label="Reports" loop>
            <div className="flex items-center gap-2 border-b px-3">
              <Search className="size-4 text-muted-foreground" aria-hidden />
              <Command.Input autoFocus placeholder="Search reports…" className="h-10 w-full bg-transparent text-[14px] outline-none placeholder:text-muted-foreground" />
            </div>
            <Command.List className="max-h-[60vh] overflow-y-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-[13px] text-muted-foreground">No report by that name.</Command.Empty>
              {groups.map(([group, items]) => (
                <Command.Group
                  key={group}
                  heading={<span className="flex flex-col"><span>{group}</span><span className="font-normal normal-case tracking-normal text-muted-foreground/80">{GROUP_HELP[group]}</span></span>}
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:uppercase"
                >
                  {items.map((item) => (
                    <Command.Item
                      key={item.key}
                      value={`${item.label} ${group}`}
                      onSelect={() => { onChange(item.key); setOpen(false); }}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[14px] data-[selected=true]:bg-accent"
                    >
                      <Check className={cn('size-4 text-primary', item.key === value ? 'opacity-100' : 'opacity-0')} aria-hidden />
                      {item.label}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </Pop.Content>
      </Pop.Portal>
    </Pop.Root>
  );
}

export default function ReportCenter() {
  const { can } = useSession();
  const [sp, setSp] = useSearchParams();
  const now = thisMonth();
  const preset = sp.get('period') ?? '6m';
  const report = sp.get('report') ?? 'summary';
  const company = sp.get('company') ?? '';
  const [customFrom, setCustomFrom] = useState(sp.get('from') ?? addMonths(now, -3));
  const [customTo, setCustomTo] = useState(sp.get('to') ?? addMonths(now, -1));
  const [from, to] = preset === 'custom' ? [customFrom, customTo] : PRESETS.find((p) => p.key === preset).range(now);
  const set = (patch) =>
    setSp((p) => {
      const n = new URLSearchParams(p);
      for (const [k, v] of Object.entries(patch)) (v ? n.set(k, v) : n.delete(k));
      return n;
    });
  const [text, setText] = useState('');
  const q = useDebounced(text, 250);
  const list = useQuery({ queryKey: ['period-reports'], queryFn: () => api.get('/reports/period').then((r) => r.data), staleTime: Infinity });
  const valid = /^\d{4}-\d{2}$/.test(from) && /^\d{4}-\d{2}$/.test(to) && from <= to;
  const r = useQuery({
    queryKey: ['period-report', report, from, to, company, q],
    queryFn: () => api.get(`/reports/period/${report}`, { from, to, company: company || undefined, q: q || undefined }).then((x) => x.data),
    enabled: valid,
    placeholderData: (prev) => (prev?.key === report ? prev : undefined),
  });
  const [exporting, setExporting] = useState(null);
  const [exportError, setExportError] = useState(null);
  const exp = async (format) => {
    setExportError(null);
    setExporting(format);
    try {
      const qs = new URLSearchParams({ from, to, format, ...(company ? { company } : {}), ...(q ? { q } : {}) });
      await download(`/reports/period/${report}?${qs}`, `report-${report}-${from}${to !== from ? `-to-${to}` : ''}.${format}`);
    } catch (e) {
      setExportError(errorMessage(e));
    } finally {
      setExporting(null);
    }
  };
  const groups = useMemo(() => {
    const out = new Map();
    for (const item of list.data ?? []) out.set(item.group, [...(out.get(item.group) ?? []), item]);
    return [...out];
  }, [list.data]);
  const current = list.data?.find((x) => x.key === report);
  const rep = r.data;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Report center"
        description="Every payroll report for any run of months, added up: pay, statutory, joiners, exits and overtime. Figures come from each month's saved payroll."
      />

      {/* Report, company and period */}
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <ReportPicker groups={groups} value={report} onChange={(k) => set({ report: k })} />
          <Select className="w-full sm:w-44" aria-label="Company" value={company} onChange={(e) => set({ company: e.target.value })}>
            <option value="">Both companies</option>
            {COMPANIES.map((c) => <option key={c.key} value={c.key}>{c.name}</option>)}
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CalendarRange className="size-4 text-muted-foreground" aria-hidden />
          <span className="text-[13px] font-medium text-muted-foreground">Period</span>
          <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1" role="radiogroup" aria-label="Period">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                role="radio"
                aria-checked={preset === p.key}
                onClick={() => set({ period: p.key, ...(p.key === 'custom' ? { from: customFrom, to: customTo } : { from: '', to: '' }) })}
                className={cn('rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors', preset === p.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
              >
                {p.label}
              </button>
            ))}
          </div>
          {preset === 'custom' && (
            <div className="flex flex-wrap items-center gap-2">
              <Input type="month" aria-label="From month" className="w-44" value={customFrom} max={customTo} onChange={(e) => { setCustomFrom(e.target.value); set({ from: e.target.value }); }} />
              <span className="text-muted-foreground">to</span>
              <Input type="month" aria-label="To month" className="w-44" value={customTo} min={customFrom} onChange={(e) => { setCustomTo(e.target.value); set({ to: e.target.value }); }} />
            </div>
          )}
        </div>
        <Coverage from={from} to={to} valid={valid} coverage={rep?.coverage} />
      </Card>

      <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="font-display text-xl font-semibold">{current?.label ?? 'Report'}</h2>
              <p className="text-[13px] text-muted-foreground">{valid ? (from === to ? formatYearMonth(from) : `${formatYearMonth(from)} – ${formatYearMonth(to)}`) : 'Choose a valid period'} · {company ? COMPANIES.find((c) => c.key === company)?.name : 'Both companies'}</p>
            </div>
          </div>
          <Card>
            {(
              <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
                {report !== 'summary' && (
                  <div className="relative w-64">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input className="pl-8" value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter by name or code" aria-label="Filter by name or code" />
                  </div>
                )}
                <span className="text-[13px] text-muted-foreground num">{rep && !rep.empty && report !== 'summary' && `${rep.rows.length.toLocaleString('en-IN')} row${rep.rows.length === 1 ? '' : 's'}${q ? ` matching “${q}”` : ''}`}</span>
                <div className="flex-1" />
                <Button variant="outline" size="sm" disabled={!can('reports.export') || !rep || r.isFetching || !!exporting} loading={exporting === 'csv'} onClick={() => exp('csv')}><Download /> CSV</Button>
                <Button variant="outline" size="sm" disabled={!can('reports.export') || !rep || r.isFetching || !!exporting} loading={exporting === 'xlsx'} onClick={() => exp('xlsx')}><FileSpreadsheet /> XLSX</Button>
              </div>
            )}
            {exportError && <p role="alert" className="border-b px-4 py-3 text-sm text-destructive">{exportError}</p>}
            {!valid ? (
              <EmptyState title="Choose a period" body="Pick the first and last month; the first must not be after the last." />
            ) : r.isLoading ? (
              <SkeletonRows rows={10} />
            ) : r.isError ? (
              <ErrorState error={r.error} onRetry={() => r.refetch()} />
            ) : rep?.empty ? (
              <EmptyState title="No payroll in this period" body={rep.notes?.[0] ?? 'Run payroll for a month in this period to see its reports.'} />
            ) : rep && report === 'summary' ? (
              <PeriodSummary rep={rep} />
            ) : rep ? (
              <ReportTable rep={rep} q={q} />
            ) : null}
          </Card>
      </div>
    </div>
  );
}

/** Which months the period covers, which have payroll and which are missing or still provisional. */
function Coverage({ from, to, valid, coverage }) {
  if (!valid || !coverage) return null;
  const run = coverage.included.length;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      <span className="text-muted-foreground">
        {coverage.months} month{coverage.months === 1 ? '' : 's'} · payroll run for <strong className="text-foreground">{run}</strong>
      </span>
      {coverage.included.map((m) => (
        <Chip key={m.ym} tone={m.state === 'RUN' ? 'warning' : 'success'} title={m.state === 'RUN' ? 'Generated, not locked yet' : m.state === 'PAID' ? 'Paid' : 'Locked'}>
          {shortYm(m.ym)}
        </Chip>
      ))}
      {coverage.missing.length > 0 && (
        <span className="text-muted-foreground">
          · not run: {coverage.missing.map((m) => formatYearMonth(m)).join(', ')}
        </span>
      )}
    </div>
  );
}

function ReportTable({ rep, q }) {
  const cols = useMemo(
    () =>
      rep.columns.map((c, i) => ({
        id: c.key,
        header: c.flat_label ?? c.label,
        align: c.money || typeof rep.rows[0]?.[c.key] === 'number' ? 'right' : 'left',
        sticky: i === 0 && rep.key === 'register' ? true : c.key === 'name' && rep.key === 'register',
        width: c.key === 'name' ? 180 : c.key === 'code' ? 80 : undefined,
        cell: (row) => {
          const v = row[c.key];
          if (c.key === 'name' && row.employee_id) return <PersonLink id={row.employee_id} name={v} />;
          if (c.money) return <Money value={v} />;
          if (c.mono) return <Mono>{String(v ?? '')}</Mono>;
          if (c.key.endsWith('_pct') && typeof v === 'number') return <span className="num">{v.toLocaleString('en-IN')}%</span>;
          return <span className={c.key === 'reason' ? 'whitespace-normal' : ''}>{typeof v === 'number' ? v.toLocaleString('en-IN') : String(v ?? '')}</span>;
        },
      })),
    [rep],
  );
  return (
    <>
      {rep.notes?.map((n) => (
        <div key={n} className="px-3 pt-2">
          <Notice>{n}</Notice>
        </div>
      ))}
      {Array.isArray(rep.extra?.by_month) && rep.extra.by_month.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {rep.extra.by_month.map((m) => (
            <Card key={m.ym} className="px-3 py-2 text-[14px]">
              <div className="text-[12px] text-muted-foreground">{m.month}</div>
              <div className="font-semibold num">{m.count}</div>
            </Card>
          ))}
        </div>
      )}
      {rep.key === 'pt' && Array.isArray(rep.extra?.by_state) && (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {rep.extra.by_state.map((s) => (
            <Card key={s.state} className="px-3 py-2 text-[14px]">
              <div className="font-medium">{s.state}</div>
              <div className="text-muted-foreground">{s.people} people · <Money value={s.amount} /></div>
            </Card>
          ))}
        </div>
      )}
      {rep.rows.length === 0 ? (
        <EmptyState title="Nothing in this report" body={q ? `No rows match “${q}”.` : 'This report has no rows for this period.'} />
      ) : (
        <DataTable
          columns={cols}
          rows={rep.rows}
          rowId={(row) => `${row.employee_id ?? ''}${row.code ?? ''}${row.item ?? ''}${row.state ?? ''}${row.department ?? ''}${row.ym ?? ''}${row.last_day ?? ''}`}
          virtualiseAbove={200}
          maxHeight="62vh"
          footer={
            rep.totals ? (
              <tr>
                {rep.columns.map((c, i) => (
                  <td key={c.key} className={cn('border-t bg-card px-3 py-2 text-[14px] font-semibold', (c.money || typeof rep.totals[c.key] === 'number') && 'text-right num', i === 0 && 'sticky left-0')}>
                    {c.money && typeof rep.totals[c.key] === 'number' ? <Money value={rep.totals[c.key]} /> : typeof rep.totals[c.key] === 'number' ? rep.totals[c.key].toLocaleString('en-IN') : String(rep.totals[c.key] ?? '')}
                  </td>
                ))}
              </tr>
            ) : undefined
          }
        />
      )}
    </>
  );
}

/** Headline figures, full salary to net pay for the period, and pay month by month. */
function PeriodSummary({ rep }) {
  const x = rep.extra;
  const max = Math.max(1, ...rep.rows.map((r) => Math.abs(r.amount)));
  const trendMax = Math.max(1, ...x.trend.map((m) => m.ctc));
  return (
    <div className="flex flex-col gap-5 p-4">
      {rep.notes?.map((n) => <Notice key={n}>{n}</Notice>)}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="People paid" value={x.headcount} sub={`${x.payslips} payslips over ${x.months_run} month${x.months_run === 1 ? '' : 's'}`} />
        <Stat label="Gross" value={<Money value={x.gross} />} />
        <Stat label="Net pay" value={<Money value={x.net} />} />
        <Stat label="Cost to company" value={<Money value={x.ctc} />} sub={<>Employer contributions <Money value={x.employer} /></>} />
        <Stat label="Overtime" value={`${x.ot_hours.toLocaleString('en-IN')} h`} sub={<><Money value={x.ot_amount} /> paid</>} />
        <Stat label="Joiners" value={x.joiners} sub="Joined in the period" />
        <Stat label="Exits" value={x.exits} sub="Last day in the period" />
        <Stat label="Average a month" value={<Money value={Math.round(x.net / Math.max(1, x.months_run))} />} sub="Net pay" />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <section>
          <h4 className="mb-2 font-display font-semibold">From full salary to net pay</h4>
          <table className="w-full text-[14px]">
            <tbody>
              {rep.rows.filter((r) => r.total || r.amount !== 0).map((r) => (
                <tr key={r.step} className={cn('border-b', r.total && 'font-semibold')}>
                  <td className="w-48 py-1.5">{r.step}</td>
                  <td className="py-1.5">
                    <div className="h-2.5 rounded-sm" style={{ width: `${(Math.abs(r.amount) / max) * 100}%`, background: r.total ? 'var(--primary)' : r.amount < 0 ? 'var(--destructive)' : 'var(--chart-3)', opacity: r.total ? 1 : 0.7 }} />
                  </td>
                  <td className="w-36 py-1.5 text-right"><Money value={r.amount} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section>
          <h4 className="mb-2 font-display font-semibold">Month by month</h4>
          <table className="w-full text-[14px]">
            <thead className="text-left text-[12px] text-muted-foreground">
              <tr><th className="pb-1 font-medium">Month</th><th className="pb-1 font-medium">Cost to company</th><th className="pb-1 text-right font-medium">Net pay</th><th className="pb-1 text-right font-medium">People</th></tr>
            </thead>
            <tbody>
              {x.trend.map((m) => (
                <tr key={m.ym} className="border-b">
                  <td className="w-32 py-1.5">
                    {m.month}
                    {m.state === 'Generated' && <span className="ml-1 text-[11px] text-warning-foreground dark:text-warning">draft</span>}
                  </td>
                  <td className="py-1.5 pr-3">
                    <div className="flex items-center gap-2">
                      <div className="h-2.5 min-w-16 flex-1 rounded-sm bg-muted">
                        <div className="h-2.5 rounded-sm bg-primary/70" style={{ width: `${(m.ctc / trendMax) * 100}%` }} />
                      </div>
                      <span className="w-24 text-right text-[12px] whitespace-nowrap text-muted-foreground"><Money value={m.ctc} /></span>
                    </div>
                  </td>
                  <td className="w-32 py-1.5 text-right"><Money value={m.net} /></td>
                  <td className="w-16 py-1.5 text-right num">{m.people}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
