import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, FileSpreadsheet, Printer, Search } from 'lucide-react';
import { api, download, errorMessage } from '@/services/api';
import { useSession } from '@/context/SessionContext';
import { useDebounced } from '@/hooks';
import { cn, monthLabel, istTime } from '@/utils';
import { Money, Mono, PersonLink, Stat } from '@/components/bits';
import { DataTable } from '@/components/data-table';
import { EmptyState, ErrorState, Notice, SkeletonRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/form';
import { PayslipZipDownload } from './PayslipZipDownload';

const REPORTS = [
  ['summary', 'Summary'],
  ['payslips', 'Payslips'],
  ['register', 'Salary register'],
  ['bank', 'Bank transfer'],
  ['pf', 'PF (ECR)'],
  ['esi', 'ESI'],
  ['pt', 'Professional tax'],
  ['tds', 'TDS / Income tax'],
  ['department', 'By department'],
  ['change', 'Change vs last month'],
  ['settlements', 'Settlements'],
  ['adhoc', 'One-time adjustments'],
];

/** Every report of a generated month, optionally for one company (`AJ` or `TP`). */
export function Reports({ ym, period, company }) {
  const { can } = useSession();
  const [exportError, setExportError] = useState(null);
  const scope = `${ym}:${company ?? 'all'}`;
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'summary';
  const [text, setText] = useState('');
  const q = useDebounced(text, 250);
  const r = useQuery({
    queryKey: ['report', ym, tab, q, company ?? 'all'],
    queryFn: () => api.get(`/payroll/periods/${ym}/report/${tab}`, { q, company }).then((x) => x.data),
    placeholderData: (prev) => (prev?.key === tab ? prev : undefined),
  });
  const [exporting, setExporting] = useState(null);
  const exp = async (format) => {
    setExportError(null);
    setExporting(format);
    try {
      await download(`/payroll/periods/${ym}/report/${tab}?format=${format}${company ? `&company=${company}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`, `payroll-${tab}-${ym}${company ? `-${company.toLowerCase()}` : ''}.${format}`);
    } catch (e) {
      setExportError({ scope: `${scope}:${tab}`, message: errorMessage(e) });
    } finally {
      setExporting(null);
    }
  };
  const setTab = (t) =>
    setSp((p) => {
      const n = new URLSearchParams(p);
      n.set('tab', t);
      return n;
    });

  const rep = r.data;
  const exportDisabled = !can('reports.export') || r.isFetching || r.isError || !rep || text !== q || !!exporting;
  const cols = useMemo(() => {
    if (!rep) return [];
    return rep.columns.map((c, i) => ({
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
        return <span className={c.key === 'reason' ? 'whitespace-normal' : ''}>{String(v ?? '')}</span>;
      },
    }));
  }, [rep]);

  return (
    <div className="flex flex-col gap-3">
      <div className="payroll-report-context flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-lg font-semibold">{REPORTS.find(([key]) => key === tab)?.[1] ?? 'Payroll report'}</h2><p className="mt-1 text-xs text-muted-foreground">{monthLabel(ym)} · {company ? company === 'TP' ? 'Techpi' : 'AJ Power' : 'Both companies'} · Generated payroll figures</p></div>
        <details className="max-w-lg text-xs text-muted-foreground"><summary className="cursor-pointer">Generated {istTime(period.run_at, true)} IST · {period.run_by}</summary><p className="mt-2">These figures come from the saved payroll. <button className="text-primary underline" onClick={() => setTab('change')}>Review changes against last month</button> before locking.</p></details>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b">
      <div className="flex gap-1" role="tablist" aria-label="Common payroll reports">
        {REPORTS.slice(0,4).map(([k, l]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[14px] font-medium',
              tab === k ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {l}
          </button>
        ))}
      </div>
      <label className="mb-2 flex items-center gap-2 text-sm">Report
        <Select className="w-64" aria-label="Choose payroll report" value={tab} onChange={e=>setTab(e.target.value)}>
          {[['Payroll',REPORTS.slice(0,4)],['Statutory',REPORTS.slice(4,8)],['Analysis and adjustments',REPORTS.slice(8)]].map(([label,items])=><optgroup label={label} key={label}>{items.map(([key,name])=><option key={key} value={key}>{name}</option>)}</optgroup>)}
        </Select>
      </label>
      </div>
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          {tab !== 'summary' && (
            <div className="relative w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-8" value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter by name or code" aria-label="Filter by name or code" />
            </div>
          )}
          <span className="text-[13px] text-muted-foreground num">{rep && tab !== 'summary' && `${rep.rows.length.toLocaleString('en-IN')} rows${q ? ` matching “${q}”` : ''}`}</span>
          <div className="flex-1" />
          {tab === 'payslips' && <PayslipZipDownload ym={ym} company={company} q={q} disabled={exportDisabled || !rep?.rows.length} />}
          <Button variant="outline" size="sm" disabled={exportDisabled} loading={exporting === 'csv'} onClick={() => exp('csv')}>
            <Download /> CSV
          </Button>
          <Button variant="outline" size="sm" disabled={exportDisabled} loading={exporting === 'xlsx'} onClick={() => exp('xlsx')}>
            <FileSpreadsheet /> XLSX
          </Button>
        </div>
        {exportError?.scope === `${scope}:${tab}` && <p role="alert" className="border-b px-4 py-3 text-sm text-destructive">{exportError.message}</p>}
        {r.isLoading ? (
          <SkeletonRows rows={10} />
        ) : r.isError ? (
          <ErrorState error={r.error} onRetry={() => r.refetch()} />
        ) : rep && tab === 'summary' ? (
          <Summary rep={rep} />
        ) : rep ? (
          <>
            {rep.notes?.map((n) => (
              <div key={n} className="px-3 pt-2">
                <Notice>{n}</Notice>
              </div>
            ))}
            {rep.key === 'pt' && Array.isArray(rep.extra?.by_state) && (
              <div className="flex flex-wrap gap-2 px-3 pt-3">
                {rep.extra.by_state.map((s) => (
                  <Card key={s.state} className="px-3 py-2 text-[14px]">
                    <div className="font-medium">{s.state}</div>
                    <div className="text-muted-foreground">
                      {s.people} people · <Money value={s.amount} />
                    </div>
                  </Card>
                ))}
              </div>
            )}
            {rep.rows.length === 0 ? (
              <EmptyState title="Nothing in this report" body={q ? `No rows match “${q}”.` : 'This report has no rows for this month.'} />
            ) : (
              <DataTable
                columns={
                  rep.key === 'payslips'
                    ? [
                        ...cols,
                        {
                          id: 'print',
                          header: '',
                          cell: (row) => (
                            <a
                              href={`/print/payslip/${ym}/${row.employee_id}`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-primary hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Printer className="size-3.5" /> Payslip
                            </a>
                          ),
                        },
                      ]
                    : cols
                }
                rows={rep.rows}
                rowId={(row) => `${row.employee_id ?? ''}${row.code ?? ''}${row.item ?? ''}${row.state ?? ''}${row.department ?? ''}`}
                virtualiseAbove={200}
                maxHeight="62vh"
                footer={
                  rep.totals ? (
                    <tr>
                      {rep.columns.map((c, i) => (
                        <td key={c.key} className={cn('border-t bg-card px-3 py-2 text-[14px] font-semibold', c.money && 'text-right num', i === 0 && 'sticky left-0')}>
                          {c.money && typeof rep.totals[c.key] === 'number' ? <Money value={rep.totals[c.key]} /> : String(rep.totals[c.key] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ) : undefined
                }
              />
            )}
            {rep.key === 'bank' && Array.isArray(rep.extra?.recoverable) && rep.extra.recoverable.length > 0 && (
              <div className="border-t p-3 text-[14px]">
                <h4 className="font-semibold">Recoverable — not in the bank file</h4>
                {rep.extra.recoverable.map((x) => (
                  <div key={x.name}>
                    {x.name}: <Money value={x.recoverable} />
                  </div>
                ))}
              </div>
            )}
            {rep.key === 'pf' && rep.totals && (
              <p className="border-t px-3 py-2 text-[14px]">
                Total challan including admin: <Money value={rep.totals.challan} paise />
              </p>
            )}
          </>
        ) : null}
      </Card>
    </div>
  );
}

function Summary({ rep }) {
  const x = rep.extra;
  const max = Math.max(...rep.rows.map((r) => Math.abs(r.amount)));
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Headcount" value={x.headcount} />
        <Stat label="Gross" value={<Money value={x.gross} />} />
        <Stat label="Net pay" value={<Money value={x.net} />} />
        <Stat label="Employer contributions" value={<Money value={x.employer} />} />
        <Stat label="Cost to company" value={<Money value={x.ctc} />} />
      </div>
      <div>
        <h4 className="mb-2 font-display font-semibold">From full salary to net pay</h4>
        <table className="w-full max-w-3xl text-[14px]">
          <tbody>
            {rep.rows.map((r) => {
              const v = r.amount;
              return (
                <tr key={r.step} className={cn('border-b', Boolean(r.total) && 'font-semibold')}>
                  <td className="w-56 py-1.5">{r.step}</td>
                  <td className="py-1.5">
                    <div
                      className="h-2.5 rounded-sm"
                      style={{ width: `${(Math.abs(v) / max) * 100}%`, background: r.total ? 'var(--primary)' : v < 0 ? 'var(--destructive)' : 'var(--chart-3)', opacity: r.total ? 1 : 0.7 }}
                    />
                  </td>
                  <td className="w-40 py-1.5 text-right">
                    <Money value={v} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <details className="text-[13px] text-muted-foreground">
        <summary className="cursor-pointer">Calculation details</summary>
        <p className="mt-2">Engine {x.engine_version} · statutory rates row <Mono>{x.statutory_rates_id?.slice(0, 8)}</Mono>. Reopening this month later never applies today's rates to it.</p>
      </details>
    </div>
  );
}
