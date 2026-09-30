import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Lock, LockOpen, RotateCcw, Undo2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { addMonths, PAYROLL_STEPS } from '@ajpwer/shared';
import { api, errorMessage } from '@/services/api';
import { cn, monthLabel } from '@/utils';
import { PageHeader } from '@/components/bits';
import { ErrorState, Notice, PeriodChip, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form';
import { Dialog } from '@/components/ui/overlay';
import { StepAttendance, StepJoiners, StepIssues, StepAdhoc, StepRun } from '../../components/payroll/Steps';
import { Reports } from '../../components/payroll/Reports';

export function usePeriod(ym) {
  return useQuery({ queryKey: ['period', ym], queryFn: () => api.get(`/payroll/periods/${ym}`).then((r) => r.data) });
}

/** Watches a running job, then refreshes everything that read the old figures. */
function JobProgress({ jobId, ym }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.get(`/jobs/${jobId}`).then((r) => r.data),
    refetchInterval: (query) => (query.state.data && ['DONE', 'FAILED'].includes(query.state.data.status) ? false : 700),
  });
  const j = q.data;
  useEffect(() => {
    if (j?.status === 'DONE') {
      toast.success(`${monthLabel(ym)} has been run. Every report now reads from the snapshot.`);
      qc.invalidateQueries({ queryKey: ['period', ym] });
      qc.invalidateQueries({ queryKey: ['report'] });
      qc.invalidateQueries({ queryKey: ['periods'] });
    }
    if (j?.status === 'FAILED') {
      toast.error(j.error ?? 'The run failed. Nothing was written.');
      qc.invalidateQueries({ queryKey: ['period', ym] });
    }
  }, [j?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!j || j.status === 'DONE') return null;
  if (j.status === 'FAILED') return <Notice tone="destructive">The run failed and nothing was written: {j.error}</Notice>;
  const pct = j.total ? Math.round((j.progress / j.total) * 100) : 5;
  return (
    <div className="rounded-md border bg-card p-3" role="status" aria-live="polite">
      <div className="mb-1 flex justify-between text-[13px]">
        <span>Computing payslips…</span>
        <span className="num">{j.total ? `${j.progress} of ${j.total}` : 'starting'}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function RunPayroll() {
  const params = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const periods = useQuery({ queryKey: ['periods'], queryFn: () => api.get('/payroll/periods') });
  const ym = params.ym ?? periods.data?.meta.suggested;
  useEffect(() => {
    if (!params.ym && periods.data) nav(`/payroll/${periods.data.meta.suggested}`, { replace: true });
  }, [params.ym, periods.data, nav]);
  const period = usePeriod(ym ?? '');
  const p = period.data;
  const [jobId, setJobId] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [paymentRef, setPaymentRef] = useState('');
  const step = Number(sp.get('step') ?? 0) || (p ? Math.min(5, (Math.max(0, ...p.steps_submitted.filter((s) => s <= 4)) || 0) + 1) : 1);

  useEffect(() => {
    if (p?.running_job_id) setJobId(p.running_job_id);
  }, [p?.running_job_id]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['period', ym] });
    qc.invalidateQueries({ queryKey: ['periods'] });
    qc.invalidateQueries({ queryKey: ['report'] });
  };
  const transition = useMutation({
    mutationFn: (action) =>
      action === 'rerun'
        ? api.post(`/payroll/periods/${ym}/run`, {}, { 'Idempotency-Key': crypto.randomUUID() })
        : api.post(`/payroll/periods/${ym}/${action}`, action === 'mark-paid' ? { payment_ref: paymentRef } : {}, action === 'mark-paid' ? { 'Idempotency-Key': `pay-${ym}-${paymentRef}` } : {}),
    onSuccess: (r, action) => {
      setConfirm(null);
      if (action === 'rerun') setJobId(r.data.job_id);
      else toast.success('Done. The change is in the audit log.');
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const months = (() => {
    const cur = periods.data?.meta.current;
    if (!cur) return [];
    const set = new Set([...(periods.data?.data.map((x) => x.period_ym) ?? [])]);
    for (let i = 0; i < 12; i++) set.add(addMonths(cur, -i));
    return [...set].sort().reverse();
  })();

  if (!ym || period.isLoading) return <SkeletonBlock className="h-96" />;
  if (period.isError) return <ErrorState error={period.error} onRetry={() => period.refetch()} />;

  const run = p.state !== 'DRAFT';
  const goStep = (n) =>
    setSp((prev) => {
      const x = new URLSearchParams(prev);
      x.set('step', String(n));
      x.delete('tab');
      return x;
    });

  const confirmText = {
    lock: {
      title: `Lock ${monthLabel(ym)}`,
      body: 'Figures freeze and payslips become final. Changes to salaries or attendance afterwards will not move them unless the month is unlocked and rerun.',
      action: 'Lock',
    },
    unlock: { title: `Unlock ${monthLabel(ym)}`, body: 'Returns the month to RUN so it can be rerun. The current snapshot stays until you rerun.', action: 'Unlock' },
    'unmark-paid': {
      title: 'The transfer has already gone',
      body: `${monthLabel(ym)} was marked paid with reference ${p.payment_ref}. Unmarking returns it to LOCKED and reverses loan and advance recoveries and settlements. The bank transfer itself is not reversed. This is recorded in the audit log.`,
      action: 'Unmark paid anyway',
      destructive: true,
    },
    'back-to-steps': {
      title: 'Back to the steps',
      body: `Discards the snapshot for ${monthLabel(ym)} (${p.totals?.headcount ?? 0} payslips) and returns to DRAFT. Nothing leaves the building; you can run again.`,
      action: 'Discard and go back',
      destructive: true,
    },
    rerun: { title: `Rerun ${monthLabel(ym)}`, body: 'Recomputes every payslip from current data and replaces the snapshot.', action: 'Rerun' },
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Run payroll"
        description="Payroll covers the full calendar month. Five steps, each reviewed and submitted in order."
        meta={
          <>
            <Select className="h-8 w-48" value={ym} onChange={(e) => nav(`/payroll/${e.target.value}`)} aria-label="Payroll month">
              {months.map((m) => (
                <option key={m} value={m}>
                  {monthLabel(m)}
                </option>
              ))}
            </Select>
            <PeriodChip state={p.state} />
            {p.payment_ref && <span className="text-[12px] text-muted-foreground">Paid · ref {p.payment_ref}</span>}
          </>
        }
        actions={
          <>
            {p.state === 'RUN' && (
              <>
                <Button variant="outline" onClick={() => setConfirm('back-to-steps')}>
                  <Undo2 /> Back to steps
                </Button>
                <Button variant="outline" onClick={() => setConfirm('rerun')}>
                  <RotateCcw /> Rerun
                </Button>
                <Button onClick={() => setConfirm('lock')}>
                  <Lock /> Lock
                </Button>
              </>
            )}
            {p.state === 'LOCKED' && (
              <>
                <Button variant="outline" onClick={() => setConfirm('unlock')}>
                  <LockOpen /> Unlock
                </Button>
                <Button onClick={() => setConfirm('mark-paid')}>
                  <Wallet /> Mark paid
                </Button>
              </>
            )}
            {p.state === 'PAID' && (
              <Button variant="outline" onClick={() => setConfirm('unmark-paid')}>
                <Undo2 /> Unmark paid
              </Button>
            )}
          </>
        }
      />

      {jobId && <JobProgress jobId={jobId} ym={ym} />}
      {!run ? (
        <>
          <nav aria-label="Payroll steps" className="grid grid-cols-5 gap-1 rounded-lg border bg-card p-1">
            {PAYROLL_STEPS.map((s) => {
              const st = p.steps.find((x) => x.n === s.n);
              return (
                <button
                  key={s.n}
                  onClick={() => st.open && goStep(s.n)}
                  disabled={!st.open}
                  aria-current={step === s.n ? 'step' : undefined}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-3 py-2 text-left text-[13px]',
                    step === s.n ? 'bg-primary text-primary-foreground' : st.open ? 'hover:bg-accent' : 'cursor-not-allowed opacity-50',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold',
                      st.submitted && step !== s.n && 'border-success bg-success text-success-foreground',
                    )}
                  >
                    {st.submitted ? <Check className="size-3.5" /> : s.n}
                  </span>
                  <span className="hidden truncate sm:block">{s.label}</span>
                </button>
              );
            })}
          </nav>
          {step === 1 && <StepAttendance ym={ym} period={p} onDone={() => goStep(2)} />}
          {step === 2 && <StepJoiners ym={ym} period={p} onDone={() => goStep(3)} />}
          {step === 3 && <StepIssues ym={ym} period={p} onDone={() => goStep(4)} />}
          {step === 4 && <StepAdhoc ym={ym} period={p} onDone={() => goStep(5)} />}
          {step === 5 && <StepRun ym={ym} period={p} onStarted={setJobId} />}
        </>
      ) : (
        <Reports ym={ym} period={p} />
      )}
      {confirm && confirm !== 'mark-paid' && (
        <Dialog
          open
          onOpenChange={(o) => !o && setConfirm(null)}
          title={confirmText[confirm].title}
          description={confirmText[confirm].body}
          footer={
            <>
              <Button variant="outline" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button variant={confirmText[confirm].destructive ? 'destructive' : 'default'} loading={transition.isPending} onClick={() => transition.mutate(confirm)}>
                {confirmText[confirm].action}
              </Button>
            </>
          }
        />
      )}
      {confirm === 'mark-paid' && (
        <Dialog
          open
          onOpenChange={(o) => !o && setConfirm(null)}
          title={`Mark ${monthLabel(ym)} paid`}
          description="Applies loan and advance recoveries, carries the capped excess into next month, freezes ticked settlements and exits their employees. A double submit cannot create two payment records."
          footer={
            <>
              <Button variant="outline" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button disabled={paymentRef.trim().length < 3} loading={transition.isPending} onClick={() => transition.mutate('mark-paid')}>
                Mark paid
              </Button>
            </>
          }
        >
          <Input autoFocus value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)} placeholder="Bank payment reference, e.g. NEFT batch number" aria-label="Payment reference" />
        </Dialog>
      )}
    </div>
  );
}
