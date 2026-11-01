import { useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, FileSpreadsheet, AlertTriangle, Users, Wallet, ListChecks, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { addMonths, GENERATE_STEP, LAST_REVIEW_STEP, STEP } from '@ajpwer/shared';
import { api, download, errorMessage } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { cn, inr, monthLabel } from '@/utils';
import { Chip, ErrorState, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { currentStep, stepLabel } from './Tracker';
import { PayrollCostChart } from './CostChart';
import { ReviewSummary } from './ReviewSummary';
import { PayslipZipDownload } from './PayslipZipDownload';

export const useSummary = (ym, enabled = true) =>
  useQuery({ queryKey: ['payroll-summary', ym], queryFn: () => api.get(`/payroll/periods/${ym}/summary`).then((r) => r.data), enabled: !!ym && enabled, staleTime: 60_000 });

const STATE_WORD = { RUN: 'Generated', LOCKED: 'Locked', PAID: 'Paid' };
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** A month card's state in words. */
function monthState(p, ym, meta) {
  if (ym > meta.current) return { text: 'Upcoming', tone: 'text-muted-foreground' };
  if (!p) return { text: ym === meta.current ? 'Month not over' : 'Not started', tone: 'text-muted-foreground' };
  if (p.state !== 'DRAFT') return { text: STATE_WORD[p.state], tone: p.state === 'PAID' ? 'text-success' : 'text-primary' };
  const n = p.steps_submitted.filter((s) => s <= LAST_REVIEW_STEP).length;
  return { text: n ? `In progress · ${n} of ${LAST_REVIEW_STEP}` : 'Not started', tone: n ? 'text-warning-foreground dark:text-warning' : 'text-muted-foreground' };
}

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
  const { data: lk } = useLookups();
  const today = lk?.today ?? new Date().toISOString().slice(0, 10);
  const byYm = Object.fromEntries(periods.map((p) => [p.period_ym, p]));
  const generated = period.state !== 'DRAFT';
  const summary = useSummary(ym);

  const key = company ?? 'all';
  const s = summary.data?.[key];

  // Six completed calendar months; a draft month does not contribute estimates to history.
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
    return { m, t, loading: m === ym ? summary.isLoading : chartQs[i].isLoading, failed: m === ym ? summary.isError : chartQs[i].isError };
  });
  const completeCount = period.steps_submitted.filter(n => n <= LAST_REVIEW_STEP).length;

  const cur = currentStep(period);

  // What needs attention: the next step, then the money that cannot go, then statutory dues.
  const attention = [];
  if (!generated) {
    attention.push(
      cur === GENERATE_STEP
        ? { title: 'Generate the payroll', note: 'All review steps are submitted', chip: 'Ready', tone: 'success', step: GENERATE_STEP }
        : { title: `Step ${cur} · ${stepLabel(cur)}`, note: 'Continue your review', chip: 'Next step', tone: 'warning', step: cur },
    );
  } else if (period.state === 'RUN') attention.push({ title: 'Review and lock payroll', note: 'Generated, not locked: payslips can still change', chip: 'Next', tone: 'warning', step: GENERATE_STEP });
  else if (period.state === 'LOCKED') attention.push({ title: 'Mark it paid', note: 'Once the bank transfer has gone', chip: 'Next', tone: 'warning', step: GENERATE_STEP });
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
      <div className="payroll-overview-top">
        <div className="payroll-periods">
          <Button size="icon" variant="outline" aria-label="Earlier months" onClick={() => onMonth(addMonths(ym, -1))}><ChevronLeft /></Button>
          {[-1, 0, 1].map(offset => { const m = addMonths(ym, offset); const st = monthState(byYm[m], m, meta); return <button className="payroll-period" key={m} aria-current={offset === 0 ? 'date' : undefined} disabled={m > meta.current} onClick={() => onMonth(m)}><small>{monthLabel(m)}</small><strong className={st.tone}>{st.text}</strong></button>; })}
          <Button size="icon" variant="outline" aria-label="Later months" disabled={addMonths(ym, 1) > meta.current} onClick={() => onMonth(addMonths(ym, 1))}><ChevronRight /></Button>
        </div>
        <div className="payroll-overview-metrics">
          {(generated ? [
            { label: 'People in this payroll', value: s?.headcount ?? '—', Icon: Users },
            { label: 'Net pay', value: s ? inr(s.net) : '—', Icon: Wallet },
          ] : [
            { label: 'Reviews completed', value: `${completeCount} / ${LAST_REVIEW_STEP}`, Icon: ListChecks },
            { label: 'Blocking checks', value: summary.isError ? 'Unavailable' : summary.isLoading ? '—' : summary.data?.errors ?? 0, Icon: ShieldAlert, warning: true },
          ]).map(({ label, value, Icon, warning }) => <Card className="payroll-overview-metric" key={label}><span className={cn('payroll-metric-icon', warning && 'warning')}><Icon className="size-6" strokeWidth={1.5} /></span><dl><dt>{label}</dt><dd>{value}</dd></dl></Card>)}
        </div>
      </div>
      {generated ? <Card><dl className="payroll-generated-totals">{[['Gross pay', s?.gross], ['Employee deductions', s?.deductions], ['Company contributions', s?.employer]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value === undefined ? '—' : inr(value)}</dd></div>)}</dl></Card> : <ReviewSummary period={period} blocking={summary.data?.errors ?? 0} onOpen={onOpen} />}
      {summary.isError && <ErrorState error={summary.error} onRetry={() => summary.refetch()} compact />}

      <div className="payroll-cost-attention">
        <Card className="min-w-0">
          <CardHeader
            title="Payroll cost · last six months"
            description={`${monthLabel(chartMonths[0])}–${monthLabel(chartMonths[5])} · Generated payrolls${company ? ` · ${company === 'TP' ? 'Techpi' : 'AJ Power'}` : ''}`}
          />
          {bars.some(b => b.loading) ? <div className="p-5"><SkeletonBlock className="h-72" /></div> : <PayrollCostChart bars={bars} />}
          {bars.filter(b => b.failed).map(b => <div key={b.m} className="px-5 pb-4"><ErrorState compact error={{ message: `${monthLabel(b.m)} payroll cost could not be loaded.` }} onRetry={() => b.m === ym ? summary.refetch() : chartQs[chartMonths.indexOf(b.m)].refetch()} /></div>)}

        </Card>
        <Card className="min-w-0">
          <CardHeader title="Needs attention" />
          <ul className="divide-y">
            {attention.map((a) => (
              <li key={a.title} className="payroll-attention-row flex-wrap">
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
