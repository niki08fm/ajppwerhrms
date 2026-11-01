import { useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FileSpreadsheet, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { addMonths, GENERATE_STEP, STEP } from '@ajpwer/shared';
import { api, download, errorMessage } from '@/services/api';
import { useSession } from '@/context/SessionContext';
import { useLookups } from '@/hooks/useLookups';
import { cn, inr, monthLabel } from '@/utils';
import { Chip, ErrorState, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/form';
import { Card, CardHeader } from '@/components/ui/card';
import { currentStep, StepTracker } from './Tracker';
import { PayslipZipDownload } from './PayslipZipDownload';

export const useSummary = (ym, enabled = true) =>
  useQuery({ queryKey: ['payroll-summary', ym], queryFn: () => api.get(`/payroll/periods/${ym}/summary`).then((r) => r.data), enabled: !!ym && enabled, staleTime: 60_000 });

const lakh = (p) => `₹${(p / 100 / 1e5).toFixed(1)}L`;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** The reports offered once a month is generated, with the format each is downloaded in. */
const REPORT_TILES = [
  ['register', 'Salary register', 'Every person, every component'],
  ['bank', 'Bank transfer', 'Who is paid and how much; held salaries left out'],
  ['payslips', 'Payslips', 'Download one PDF per employee in a ZIP folder'],
  ['pf', 'PF (ECR)', 'For the EPFO portal'],
  ['esi', 'ESI', 'For the ESIC portal'],
  ['pt', 'Professional tax', 'By state'],
  ['tds', 'TDS / Income tax', 'TDS deducted this month'],
  ['change', 'Change vs last month', 'Who changed and why'],
  ['settlements', 'Settlements', 'F&F paid in this payroll'],
];

/**
 * The payroll overview: the month at a glance, the step it stopped at, cost over six months,
 * what needs attention, and — once generated — its reports.
 */
export function PayrollOverview({ ym, period, periods, meta, company, onOpen, onMonth }) {
  const [moreReports, setMoreReports] = useState(true);
  const { can } = useSession();
  const { data: lk } = useLookups();
  const today = lk?.today ?? new Date().toISOString().slice(0, 10);
  const byYm = Object.fromEntries(periods.map((p) => [p.period_ym, p]));
  const generated = period.state !== 'DRAFT';
  const summary = useSummary(ym);
  const prevYm = addMonths(ym, -1);
  const prevRun = !!byYm[prevYm] && byYm[prevYm].state !== 'DRAFT';
  const prev = useSummary(prevYm, prevRun);
  const key = company ?? 'all';
  const s = summary.data?.[key];
  const ps = prev.data?.[key];

  // Six calendar months of generated payrolls; drafts show history through the preceding month.
  const chartMonths = [...Array(6)].map((_, i) => addMonths(ym, i - (generated ? 5 : 6)));
  const chartQs = useQueries({
    queries: chartMonths.map((m) => ({
      queryKey: ['payroll-summary', m],
      queryFn: () => api.get(`/payroll/periods/${m}/summary`).then((r) => r.data),
      enabled: m !== ym && !!byYm[m] && byYm[m].state !== 'DRAFT',
      staleTime: 60_000,
    })),
  });
  const bars = chartMonths.map((m, i) => {
    const d = m === ym ? summary.data : byYm[m] && byYm[m].state !== 'DRAFT' ? chartQs[i].data : null;
    const t = d?.[key];
    return { m, t, loading: m === ym ? summary.isLoading : chartQs[i].isLoading, error: m === ym ? summary.isError : chartQs[i].isError };
  });
  const max = Math.max(1, ...bars.map((b) => (b.t ? b.t.net + b.t.deductions + b.t.employer : 0)));

  const cur = currentStep(period);
  const change = s && ps && ps.gross ? ((s.gross - ps.gross) / ps.gross) * 100 : null;

  // What needs attention: the next step, then the money that cannot go, then statutory dues.
  const attention = [];
  if (summary.data?.errors) attention.push({ title: `${summary.data.errors} payslip${summary.data.errors > 1 ? 's' : ''} cannot be worked out`, note: 'Open Employee checks to resolve them', chip: 'Blocking', tone: 'destructive', step: STEP.ISSUES });
  if (s?.on_hold) attention.push({ title: `${s.on_hold} salar${s.on_hold > 1 ? 'ies' : 'y'} on hold`, note: `${inr(s.on_hold_net)} kept out of the bank file`, chip: 'Held', tone: 'info', step: STEP.HELD });
  // Statutory dues on this month's pay: TDS by the 7th of the next month, PF and ESI by the 15th.
  if (ym < meta.current) {
    const next = addMonths(ym, 1);
    for (const [title, day] of [[`TDS for ${monthLabel(ym)}`, '07'], [`PF and ESI for ${monthLabel(ym)}`, '15']]) {
      const left = daysBetween(today, `${next}-${day}`);
      if (left < 0 && period.state === 'PAID') continue;
      attention.push({
        title,
        note: `Pay by ${Number(day)} ${monthLabel(next).split(' ')[0]}${generated ? '' : ', after generating'}`,
        chip: left < 0 ? 'Overdue' : left === 0 ? 'Due today' : `Due in ${left} day${left > 1 ? 's' : ''}`,
        tone: left < 0 ? 'destructive' : left <= 3 ? 'warning' : 'muted',
      });
    }
  }

  const [exporting, setExporting] = useState(null);
  const exp = async (rep, format) => {
    setExporting(`${rep}${format}`);
    try {
      await download(`/payroll/periods/${ym}/report/${rep}?format=${format}${company ? `&company=${company}` : ''}`, `payroll-${rep}-${ym}${company ? `-${company.toLowerCase()}` : ''}.${format}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="payroll-month-summary overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b px-5 py-4">
          <div><p className="payroll-eyebrow">Monthly payroll</p><h2 className="mt-1 text-xl font-semibold">{monthLabel(ym)}</h2><div className="mt-2"><Chip tone={generated ? 'success' : 'muted'}>{({ RUN: 'Generated', LOCKED: 'Locked', PAID: 'Paid' })[period.state] ?? 'In review'}</Chip></div><p className="mt-1 text-xs text-muted-foreground">{company ? company === 'TP' ? 'Techpi' : 'AJ Power' : 'Both companies'} · {generated ? 'Generated figures' : 'Finish the six reviews to enable Generate payroll'}</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="icon" variant="outline" aria-label="Earlier months" onClick={() => onMonth(addMonths(ym, -1))}><ChevronLeft /></Button>
            <Select aria-label="Payroll month" value={ym} onChange={(e) => onMonth(e.target.value)} className="w-44">
              {[...new Set([...periods.map((p) => p.period_ym), ...chartMonths, ym, meta.current])].sort().reverse().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </Select>
            <Button size="icon" variant="outline" aria-label="Later months" disabled={addMonths(ym, 1) > meta.current} onClick={() => onMonth(addMonths(ym, 1))}><ChevronRight /></Button>
            {!generated && ym <= meta.suggested && <Button disabled={cur !== GENERATE_STEP || !can('payroll.run') || !!period.running || summary.isFetching || summary.isError || !!summary.data?.errors} onClick={() => onOpen(GENERATE_STEP)}>Generate payroll</Button>}
            {period.state === 'RUN' && can('payroll.run') && <Button disabled={!!period.running} onClick={() => onOpen(GENERATE_STEP, null, 'lock')}>Lock payroll</Button>}
            {period.state === 'LOCKED' && <>
              {can('payroll.run') && <Button variant="outline" onClick={() => onOpen(GENERATE_STEP, null, 'unlock')}>Unlock</Button>}
              {can('payroll.pay') && <Button onClick={() => onOpen(GENERATE_STEP, null, 'mark-paid')}>Mark paid</Button>}
            </>}
          </div>
        </div>
        {generated ? <dl className="grid divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {[
            ['People in this payroll', s?.headcount ?? '—', s ? s.on_hold ? `${s.on_hold} salaries on hold` : 'No salaries on hold' : 'Loading figures…'],
            ['Gross pay', s ? inr(s.gross) : '—', change === null ? 'Before employee deductions' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}% vs ${monthLabel(prevYm)}`],
            ['Net pay', s ? inr(s.net) : '—', 'After employee deductions'],
          ].map(([label, value, detail]) => <div key={label} className="px-5 py-4"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-[26px] font-semibold tracking-tight num">{value}</dd><p className="mt-1 text-xs text-muted-foreground">{detail}</p></div>)}
        </dl> : <StepTracker period={period} onOpen={onOpen} detailed embedded />}
      </Card>
      {summary.isError && <ErrorState error={summary.error} onRetry={() => summary.refetch()} compact />}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card className="min-w-0 overflow-hidden">
          <CardHeader title="Payroll cost · last six months" />
          <p className="px-5 pt-4 text-xs leading-relaxed text-muted-foreground">{monthLabel(chartMonths[0])}–{monthLabel(chartMonths[5])} · Generated payrolls</p>
          <div className="px-5 pt-2 pb-4">
            {summary.isLoading ? (
              <SkeletonBlock className="h-56" />
            ) : (
              <>
                <div className="flex h-56 items-end gap-4 border-b px-2">
                  {bars.map((b) => {
                    const h = (v) => `${Math.round((v / max) * 180)}px`;
                    return (
                      <div key={b.m} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                        <span className="text-[12px] font-semibold num">{b.t ? lakh(b.t.net + b.t.deductions + b.t.employer) : ''}</span>
                        {b.t ? (
                          <div
                            className="flex w-full max-w-14 flex-col overflow-hidden rounded-t-md"
                            title={`${monthLabel(b.m)}: net ${inr(b.t.net)}, deducted ${inr(b.t.deductions)}, employer ${inr(b.t.employer)}`}
                          >
                            <span style={{ height: h(b.t.employer) }} className="bg-chart-3/60" />
                            <span style={{ height: h(b.t.deductions) }} className="bg-chart-3" />
                            <span style={{ height: h(b.t.net) }} className="bg-primary" />
                          </div>
                        ) : (
                          <div className="h-1 w-full max-w-14 rounded bg-muted" />
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-4 px-2 pt-1.5">
                  {bars.map((b) => (
                    <div key={b.m} className="flex-1 text-center">
                      <div className="text-[13px] font-medium">{monthLabel(b.m).slice(0, 3)}</div>
                      <div className="text-[12px] text-muted-foreground">{b.t ? `${b.t.headcount} people` : b.loading ? 'Loading…' : b.error ? 'Unavailable' : 'not run'}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-4 text-[12px] text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm bg-primary" /> Net pay
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm bg-chart-3" /> Deducted (PF, ESI, PT, TDS, recoveries)
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="size-2.5 rounded-sm bg-chart-3/60" /> Employer PF and ESI
                  </span>
                </div>
              </>
            )}
          </div>
        </Card>
        <Card className="min-w-0">
          <CardHeader title="Needs attention" description={generated ? "Follow up on this month’s payroll." : "Resolve blocking items before generating."} />
          {!attention.length && <p className="px-5 py-4 text-sm text-muted-foreground">No additional follow-up for this month.</p>}
          <ul className="divide-y">
            {attention.map((a) => (
              <li key={a.title} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span
                  className={cn(
                    'flex size-8 items-center justify-center rounded-lg',
                    a.tone === 'destructive' ? 'bg-destructive/10 text-destructive' : a.tone === 'warning' ? 'bg-warning/15 text-warning-foreground dark:text-warning' : a.tone === 'success' ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground',
                  )}
                >
                  <AlertTriangle className="size-4" />
                </span>
                <div className="min-w-44 flex-1">
                  <div className="font-medium">{a.title}</div>
                  <div className="text-[12px] text-muted-foreground">{a.note}</div>
                </div>
                <Chip tone={a.tone}>{a.chip}</Chip>
                {a.step && (
                  <Button size="sm" variant="outline" onClick={() => onOpen(a.step)}>
                    Open
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
      {generated && (
        <Card>
          <CardHeader
            title={`Reports and files · ${monthLabel(ym)}`}
            description={company ? `${company === 'TP' ? 'Techpi' : 'AJ Power'} only. Switch to both companies at the top for everyone.` : 'Made from the generated payroll. Pick a company at the top to download only its people.'}
            actions={
              <Button size="sm" variant="outline" onClick={() => onOpen(GENERATE_STEP)}>
                Open all reports
              </Button>
            }
          />
          <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {REPORT_TILES.filter(([key]) => moreReports || ['payslips', 'register', 'bank'].includes(key)).map(([k, name, note]) => (
              <div key={k} className="flex flex-col gap-2 rounded-lg border bg-muted/30 px-4 py-3">
                <div className="font-semibold">{name}</div>
                <div className="flex-1 text-[13px] text-muted-foreground">{note}</div>
                <div className="flex gap-2">
                  {k === 'payslips' ? <PayslipZipDownload ym={ym} company={company} /> : <Button size="sm" variant="outline" loading={exporting === `${k}xlsx`} onClick={() => exp(k, 'xlsx')}>
                    <FileSpreadsheet /> Excel
                  </Button>}
                  <Button size="sm" variant="ghost" onClick={() => onOpen(GENERATE_STEP, k)}>
                    View {k === 'payslips' ? 'payslips' : 'report'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <div className="border-t px-4 py-3"><Button size="sm" variant="ghost" aria-expanded={moreReports} onClick={() => setMoreReports((show) => !show)}>{moreReports ? 'Fewer reports' : 'Statutory and other reports'}</Button></div>
        </Card>
      )}

    </div>
  );
}
