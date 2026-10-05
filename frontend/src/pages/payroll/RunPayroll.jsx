import { useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Play } from 'lucide-react';
import { COMPANIES, GENERATE_STEP } from '@ajpwer/shared';
import { api } from '@/services/api';
import { monthLabel } from '@/utils';
import { PageHeader } from '@/components/bits';
import { ErrorState, PeriodChip, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/form';
import { PayrollOverview } from '../../components/payroll/Overview';
import { StepAdhoc, StepAttendance, StepFnf, StepGenerate, StepHeld, StepJoiners } from '../../components/payroll/Steps';
import { currentStep, StepTracker, stepLabel } from '../../components/payroll/Tracker';

export function usePeriod(ym) {
  return useQuery({ queryKey: ['period', ym], queryFn: () => api.get(`/payroll/periods/${ym}`).then((r) => r.data), enabled: !!ym });
}

const DESCRIBE = {
  1: 'Every day for everyone in this payroll. Correct the days that need a look, then submit to freeze the month.',
  2: 'Who joined and who is leaving this month, and how many days each is paid.',
  3: "Settle what would stop pay going out, hold anyone's salary, and release earlier holds.",
  4: 'Full and final settlements this payroll can settle — paid in it, paid separately, or kept for later.',
  5: 'Bonuses, incentives, reimbursements and one-off deductions for this month.',
  6: 'Works out every payslip, the bank file and the statutory reports. Then lock, and mark paid after the transfer.',
};

/**
 * Payroll. Opening it shows the month at a glance and where it stopped; each step opens full
 * screen with the steps along the top, is reviewed and submitted, and leads to the next. After
 * the fifth, the payroll is generated with all its reports.
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
  const open = (n) => set({ step: n, tab: null });
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
      <div className="flex flex-col gap-4">
        <PageHeader
          title="Payroll"
          description="One payroll for both companies, for the calendar month. Five steps, then generate."
          actions={
            <>
              <Segmented
                label="Company"
                value={company ?? 'all'}
                onChange={(v) => set({ company: v === 'all' ? null : v })}
                options={[{ value: 'all', label: 'Both companies' }, ...COMPANIES.map((c) => ({ value: c.key, label: c.name }))]}
              />
              {ym <= periods.data.meta.suggested && (
                <Button onClick={() => open(cta.step)}>
                  <Play /> {cta.label}
                </Button>
              )}
            </>
          }
        />
        <PayrollOverview ym={ym} period={p} periods={periods.data.data} meta={periods.data.meta} company={company} onOpen={open} onMonth={toMonth} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        crumbs={[{ label: 'Payroll', to: `/payroll/${ym}${company ? `?company=${company}` : ''}` }, { label: monthLabel(ym) }]}
        title={shown === GENERATE_STEP ? 'Generate payroll' : `Step ${shown} · ${stepLabel(shown)}`}
        description={DESCRIBE[shown]}
        meta={<PeriodChip state={p.state} />}
        actions={
          <Button variant="outline" onClick={toOverview}>
            <ArrowLeft /> Back to overview
          </Button>
        }
      />
      <StepTracker period={p} selected={shown} onOpen={open} />
      {shown === 1 && <StepAttendance ym={ym} period={p} onNext={next(1)} />}
      {shown === 2 && <StepJoiners ym={ym} period={p} onNext={next(2)} />}
      {shown === 3 && <StepHeld ym={ym} period={p} onNext={next(3)} />}
      {shown === 4 && <StepFnf ym={ym} period={p} onNext={next(4)} />}
      {shown === 5 && <StepAdhoc ym={ym} period={p} onNext={next(5)} />}
      {shown === GENERATE_STEP && <StepGenerate ym={ym} period={p} company={company} onBack={toOverview} />}
    </div>
  );
}
