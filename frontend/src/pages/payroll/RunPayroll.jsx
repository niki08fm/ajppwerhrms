import { useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Play } from 'lucide-react';
import { COMPANIES, GENERATE_STEP, LAST_REVIEW_STEP, STEP } from '@ajpwer/shared';
import { api } from '@/services/api';
import { monthLabel } from '@/utils';
import { PageHeader } from '@/components/bits';
import { ErrorState, PeriodChip, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/form';
import { PayrollOverview } from '../../components/payroll/Overview';
import { StepAdhoc, StepAttendance, StepFnf, StepGenerate, StepHeld, StepIssues, StepJoiners } from '../../components/payroll/Steps';
import { currentStep, StepTracker, stepLabel } from '../../components/payroll/Tracker';

export function usePeriod(ym) {
  return useQuery({ queryKey: ['period', ym], queryFn: () => api.get(`/payroll/periods/${ym}`).then((r) => r.data), enabled: !!ym });
}

const DESCRIBE = {
  [STEP.ATTENDANCE]: 'Check paid days, absences and overtime. Open an employee to correct a day.',
  [STEP.JOINERS]: 'Review joining and leaving dates, and the days each person is paid.',
  [STEP.ISSUES]: 'Check bank, tax and statutory details. Resolve anything that would stop payroll.',
  [STEP.HELD]: 'Hold salaries, leave someone out of this payroll, or release an earlier hold.',
  [STEP.FNF]: 'Review full and final settlements to pay now or keep for later.',
  [STEP.ADHOC]: 'Add this month’s bonuses, reimbursements and other one-time earnings or deductions.',
  [STEP.GENERATE]: 'Generate payroll, review payslips and reports, then lock and mark paid after the transfer.',
};

/**
 * Payroll. Opening it shows the month at a glance and where it stopped; each step opens full
 * screen with the steps along the top, is reviewed and submitted, and leads to the next.
 * Once every review is submitted, generate the payroll and its reports.
 */
export default function RunPayroll() {
  const params = useParams();
  const nav = useNavigate();
  const [sp, setSp] = useSearchParams();
  const periods = useQuery({ queryKey: ['periods'], queryFn: () => api.get('/payroll/periods') });
  const ym = params.ym ?? periods.data?.meta.suggested;
  useEffect(() => {
    if (!params.ym && periods.data) nav(`/payroll/${periods.data.meta.suggested}${window.location.search}`, { replace: true });
  }, [params.ym, periods.data, nav]);
  const period = usePeriod(ym);
  const p = period.data;
  const step = Number(sp.get('step')) || null;
  const company = sp.get('company') || undefined;

  const set = (patch) =>
    setSp((prev) => {
      const x = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(patch)) (v === null || v === undefined ? x.delete(k) : x.set(k, String(v)));
      return x;
    });
  const open = (n, tab = null) => set({ step: n, tab });
  const toOverview = () => set({ step: null, tab: null });
  const toMonth = (m) => nav(`/payroll/${m}${company ? `?company=${company}` : ''}`);

  if (periods.isError) return <ErrorState error={periods.error} onRetry={() => periods.refetch()} />;
  if (!ym || period.isLoading || periods.isLoading) return <SkeletonBlock className="h-96" />;
  if (period.isError) return <ErrorState error={period.error} onRetry={() => period.refetch()} />;

  const cur = currentStep(p);
  const generated = p.state !== 'DRAFT';
  // A waiting step cannot be opened by URL either: it shows where the month stopped instead.
  const shown = step && (step <= cur || generated || p.steps_submitted.includes(step)) ? step : step ? cur : null;
  const next = (n) => () => open(Math.min(n + 1, GENERATE_STEP));

  if (!shown) {
    const cta = generated
      ? { label: p.state === 'PAID' ? `View ${monthLabel(ym)} payroll` : 'Open the generated payroll', step: GENERATE_STEP }
      : cur === GENERATE_STEP
        ? { label: 'Generate payroll', step: GENERATE_STEP }
        : { label: `Continue · step ${cur}, ${stepLabel(cur)}`, step: cur };
    return (
      <div className="payroll-overview flex flex-col gap-4">
        <PageHeader
          title="Payroll"
          description={`Choose a month, review its ${LAST_REVIEW_STEP} steps, then generate payroll and download payslips.`}
          actions={
            <>
              <Segmented
                label="Company"
                value={company ?? 'all'}
                onChange={(v) => set({ company: v === 'all' ? null : v })}
                options={[{ value: 'all', label: 'Both companies' }, ...COMPANIES.map((c) => ({ value: c.key, label: c.name }))]}
              />
              {ym <= periods.data.meta.suggested && <Button onClick={() => open(cta.step)}><Play /> {cta.label}</Button>}
            </>
          }
        />
        <PayrollOverview ym={ym} period={p} periods={periods.data.data} meta={periods.data.meta} company={company} onOpen={open} onMonth={toMonth} />
      </div>
    );
  }

  return (
    <div className="payroll-workspace flex flex-col gap-4">
      <PageHeader
        crumbs={[{ label: 'Payroll', to: `/payroll/${ym}${company ? `?company=${company}` : ''}` }, { label: monthLabel(ym) }]}
        title={shown === GENERATE_STEP ? generated ? 'Payroll reports and payslips' : 'Generate payroll' : `Step ${shown} · ${stepLabel(shown)}`}
        description={shown === GENERATE_STEP && generated ? 'Review generated figures and downloads, then finalise payroll and record the payment.' : DESCRIBE[shown]}
        meta={<PeriodChip state={p.state} />}
        actions={
          <Button variant="outline" onClick={toOverview}>
            <ArrowLeft /> Back to overview
          </Button>
        }
      />
      {company && shown !== GENERATE_STEP && <p className="payroll-scope-note">Reviews cover both companies. The company view filters overview totals and report downloads.</p>}
      <StepTracker period={p} selected={shown} onOpen={open} />
      {shown === 1 && <StepAttendance ym={ym} period={p} onNext={next(1)} />}
      {shown === 2 && <StepJoiners ym={ym} period={p} onNext={next(2)} />}
      {shown === STEP.ISSUES && <StepIssues ym={ym} period={p} onNext={next(STEP.ISSUES)} />}
      {shown === STEP.HELD && <StepHeld ym={ym} period={p} onNext={next(STEP.HELD)} />}
      {shown === STEP.FNF && <StepFnf ym={ym} period={p} onNext={next(STEP.FNF)} />}
      {shown === STEP.ADHOC && <StepAdhoc ym={ym} period={p} onNext={next(STEP.ADHOC)} />}
      {shown === GENERATE_STEP && <StepGenerate key={ym} ym={ym} period={p} company={company} onBack={toOverview} />}
    </div>
  );
}
