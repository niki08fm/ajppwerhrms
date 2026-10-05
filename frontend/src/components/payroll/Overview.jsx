import { useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, FileSpreadsheet, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { addMonths } from '@ajpwer/shared';
import { api, download, errorMessage } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { cn, inr, monthLabel } from '@/utils';
import { Chip, ErrorState, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { currentStep, StepTracker, stepLabel } from './Tracker';

export const useSummary = (ym, enabled = true) =>
  useQuery({ queryKey: ['payroll-summary', ym], queryFn: () => api.get(`/payroll/periods/${ym}/summary`).then((r) => r.data), enabled: !!ym && enabled, staleTime: 60_000 });

const STATE_WORD = { RUN: 'Generated', LOCKED: 'Locked', PAID: 'Paid' };
const lakh = (p) => `₹${(p / 100 / 1e5).toFixed(1)}L`;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** A month card's state in words. */
function monthState(p, ym, meta) {
  if (ym > meta.current) return { text: 'Upcoming', tone: 'text-muted-foreground' };
  if (!p) return { text: ym === meta.current ? 'Month not over' : 'Not started', tone: 'text-muted-foreground' };
  if (p.state !== 'DRAFT') return { text: STATE_WORD[p.state], tone: p.state === 'PAID' ? 'text-success' : 'text-primary' };
  const n = p.steps_submitted.filter((s) => s <= 5).length;
  return { text: n ? `In progress · ${n} of 5` : 'Not started', tone: n ? 'text-warning-foreground dark:text-warning' : 'text-muted-foreground' };
}

/** The reports offered once a month is generated, with the format each is downloaded in. */
const REPORT_TILES = [
  ['register', 'Salary register', 'Every person, every component'],
  ['bank', 'Bank transfer', 'Who is paid and how much; held salaries left out'],
  ['payslips', 'Payslips', 'One per person, printable'],
  ['pf', 'PF (ECR)', 'For the EPFO portal'],
  ['esi', 'ESI', 'For the ESIC portal'],
  ['pt', 'Professional tax', 'By state'],
  ['tds', 'Income tax', 'TDS deducted this month'],
  ['change', 'Change vs last month', 'Who changed and why'],
  ['settlements', 'Settlements', 'F&F paid in this payroll'],
];

/**
 * The payroll overview: the month at a glance, the step it stopped at, cost over six months,
 * what needs attention, and — once generated — its reports.
 */
export function PayrollOverview({ ym, period, periods, meta, company, onOpen, onMonth }) {
  const { data: lk } = useLookups();
  const today = lk?.today ?? new Date().toISOString().slice(0, 10);
  const byYm = Object.fromEntries(periods.map((p) => [p.period_ym, p]));
  const generated = period.state !== 'DRAFT';
  const summary = useSummary(ym);
  const prevYm = addMonths(ym, -1);
  const prevRun = byYm[prevYm] && byYm[prevYm].state !== 'DRAFT';
  const prev = useSummary(prevYm, prevRun);
  const key = company ?? 'all';
  const s = summary.data?.[key];
  const ps = prev.data?.[key];

  // Six months of cost, from generated payslips; this month as an estimate while it is not.
  const chartMonths = [...Array(6)].map((_, i) => addMonths(ym, i - 5));
  const chartQs = useQueries({
    queries: chartMonths.map((m) => ({
      queryKey: ['payroll-summary', m],
      queryFn: () => api.get(`/payroll/periods/${m}/summary`).then((r) => r.data),
      enabled: m !== ym && !!byYm[m] && byYm[m].state !== 'DRAFT',
      staleTime: 60_000,
    })),
  });
  const bars = chartMonths.map((m, i) => {
    const d = m === ym ? summary.data : chartQs[i].data;
    const t = d?.[key];
    return { m, t, estimate: m === ym && !generated };
  });
  const max = Math.max(1, ...bars.map((b) => (b.t ? b.t.net + b.t.deductions + b.t.employer : 0)));

  const cur = currentStep(period);
  const change = s && ps && ps.gross ? ((s.gross - ps.gross) / ps.gross) * 100 : null;

  // What needs attention: the next step, then the money that cannot go, then statutory dues.
  const attention = [];
  if (!generated) {
    attention.push(
      cur === 6
        ? { title: 'Generate the payroll', note: 'All five steps are submitted', chip: 'Ready', tone: 'success', step: 6 }
        : { title: `Step ${cur} · ${stepLabel(cur)}`, note: 'Where this month stopped', chip: 'Next step', tone: 'warning', step: cur },
    );
  } else if (period.state === 'RUN') attention.push({ title: 'Lock the payroll', note: 'Generated, not locked: payslips can still change', chip: 'Next', tone: 'warning', step: 6 });
  else if (period.state === 'LOCKED') attention.push({ title: 'Mark it paid', note: 'Once the bank transfer has gone', chip: 'Next', tone: 'warning', step: 6 });
  if (summary.data?.errors) attention.push({ title: `${summary.data.errors} payslip${summary.data.errors > 1 ? 's' : ''} cannot be worked out`, note: 'Fix them or hold them in step 3', chip: 'Blocking', tone: 'destructive', step: 3 });
  if (s?.on_hold) attention.push({ title: `${s.on_hold} salar${s.on_hold > 1 ? 'ies' : 'y'} on hold`, note: `${inr(s.on_hold_net)} kept out of the bank file`, chip: 'Held', tone: 'info', step: 3 });
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
      <div className="flex flex-wrap gap-3">
        <Card className="flex flex-[2_1_520px] items-center gap-2 p-2.5">
          <Button size="icon" variant="outline" aria-label="Earlier months" onClick={() => onMonth(addMonths(ym, -1))}>
            <ChevronLeft />
          </Button>
          {[-1, 0, 1].map((o) => {
            const m = addMonths(ym, o);
            const st = monthState(byYm[m], m, meta);
            const future = m > meta.current;
            return (
              <button
                key={m}
                type="button"
                disabled={future}
                onClick={() => onMonth(m)}
                className={cn('flex-1 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-default', o === 0 ? 'border-primary bg-primary/5' : 'hover:bg-accent/40')}
              >
                <div className="text-[13px] text-muted-foreground">{monthLabel(m)}</div>
                <div className={cn('font-semibold', st.tone)}>{st.text}</div>
              </button>
            );
          })}
          <Button size="icon" variant="outline" aria-label="Later months" disabled={addMonths(ym, 1) > meta.current} onClick={() => onMonth(addMonths(ym, 1))}>
            <ChevronRight />
          </Button>
        </Card>
        {[
          { label: 'People in this payroll', value: s ? s.headcount : '…', sub: s ? (s.on_hold ? `${s.on_hold} on hold` : 'nobody on hold') : '' },
          { label: 'Gross pay', value: s ? inr(s.gross) : '…', sub: change === null ? (generated ? 'as generated' : 'estimate until generated') : `${change >= 0 ? '+' : ''}${change.toFixed(1)}% on ${monthLabel(prevYm).split(' ')[0]}` },
          { label: 'Net to people', value: s ? inr(s.net) : '…', sub: generated ? 'as generated' : 'estimate until generated', tone: 'text-success' },
        ].map((k) => (
          <Card key={k.label} className="flex-[1_1_180px] px-4 py-3.5">
            <div className="text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">{k.label}</div>
            <div className={cn('mt-1 text-[24px] leading-tight font-semibold num', k.tone)}>{k.value}</div>
            <div className="text-[12px] text-muted-foreground">{k.sub}</div>
          </Card>
        ))}
      </div>
      {summary.isError && <ErrorState error={summary.error} onRetry={() => summary.refetch()} compact />}

      <StepTracker period={period} onOpen={onOpen} />

      {generated && (
        <Card>
          <CardHeader
            title={`Reports and files · ${monthLabel(ym)}`}
            description={company ? `${company === 'TP' ? 'Techpi' : 'AJ Power'} only. Switch to both companies at the top for everyone.` : 'Made from the generated payroll. Pick a company at the top to download only its people.'}
            actions={
              <Button size="sm" variant="outline" onClick={() => onOpen(6)}>
                Open all reports
              </Button>
            }
          />
          <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {REPORT_TILES.map(([k, name, note]) => (
              <div key={k} className="flex flex-col gap-2 rounded-lg border bg-muted/30 px-4 py-3">
                <div className="font-semibold">{name}</div>
                <div className="flex-1 text-[13px] text-muted-foreground">{note}</div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" loading={exporting === `${k}xlsx`} onClick={() => exp(k, 'xlsx')}>
                    <FileSpreadsheet /> Excel
                  </Button>
                  <Button size="sm" variant="ghost" loading={exporting === `${k}csv`} onClick={() => exp(k, 'csv')}>
                    <Download /> CSV
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="flex flex-wrap items-stretch gap-4">
        <Card className="min-w-0 flex-[3_1_520px]">
          <CardHeader
            title="Payroll cost · last six months"
            description={`What reached people, what was deducted from them, and what the company paid on top${company ? ` — ${company === 'TP' ? 'Techpi' : 'AJ Power'} only` : ''}.${!generated ? ` ${monthLabel(ym)} is an estimate until generated.` : ''}`}
          />
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
                            className={cn('flex w-full max-w-14 flex-col overflow-hidden rounded-t-md', b.estimate && 'opacity-50')}
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
                      <div className="text-[12px] text-muted-foreground">{b.t ? `${b.t.headcount} people` : 'not run'}</div>
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
        <Card className="min-w-0 flex-[2_1_340px]">
          <CardHeader title="Needs attention" />
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
    </div>
  );
}
