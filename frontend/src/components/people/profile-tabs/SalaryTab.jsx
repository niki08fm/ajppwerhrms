import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { describeComponentRule, formatINR } from '@ajpwer/shared';
import { api, errorMessage } from '@/services/api';
import { cn, monthLabel } from '@/utils';
import { ErrorState, Notice, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Switch } from '@/components/ui/overlay';
import { PayTab } from './Pay';
import { TaxTab } from './Tax';
import { ReviseDialog } from './SalaryHistory';
import { SalaryHoldCard } from './SalaryHold';

const rupees = (v, neg = false) => (v ? `${neg ? '−' : ''}${formatINR(v)}` : '₹0');

/**
 * Salary and statutory, as one page: the breakup line by line (monthly and yearly, from
 * gross to cost to company to take-home), the statutory switches beside it, and the
 * revisions. The full PF, ESI, PT and tax working opens below for when HR needs it.
 */
export function SalaryTab({ e }) {
  const qc = useQueryClient();
  const [revising, setRevising] = useState(false);
  const [more, setMore] = useState(false);
  const pay = useQuery({ queryKey: ['employee-pay', e.id], queryFn: () => api.get(`/employees/${e.id}/pay`).then((r) => r.data) });
  const history = useQuery({ queryKey: ['salary-history', e.id], queryFn: () => api.get(`/employees/${e.id}/salary`).then((r) => r.data) });
  const st = e.statutory;
  const patch = useMutation({
    mutationFn: (body) => api.patch(`/employees/${e.id}/statutory`, body),
    onSuccess: () => {
      toast.success('Saved. The change is in the audit log with old and new values.');
      for (const k of [['employee', e.id], ['employee-pay', e.id], ['employee-tax', e.id], ['payslip-preview', e.id]]) qc.invalidateQueries({ queryKey: k });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (pay.isLoading) return <SkeletonBlock className="h-[560px]" />;
  if (pay.isError) return <ErrorState error={pay.error} onRetry={() => pay.refetch()} />;
  if (!pay.data) return <Notice>No salary record yet. It is created when onboarding starts.</Notice>;
  const { salary, preview: p } = pay.data;
  const ro = e.read_only;
  const structureName = e.rules?.structure?.name ?? 'Salary structure';

  const rows = [
    ...p.structure.monthly.map((c) => ({ k: c.name, rule: describeComponentRule(c), m: c.amount })),
    { k: 'Gross', m: p.gross, total: true },
    { k: 'Employer PF', rule: p.pf.employer_total ? '12% of PF wage' : 'PF off', m: p.pf.employer_total ?? p.ctc.employer_pf },
    { k: 'Employer ESI', rule: p.esi.applicable ? '3.25% of gross' : 'Not covered', m: p.esi.applicable ? p.esi.employer : 0 },
    { k: 'Cost to company', m: p.ctc.monthly_cost, total: true },
    { k: 'Employee PF', rule: p.pf.employee ? '12% of PF wage' : 'PF off', m: p.pf.employee, neg: true },
    ...(p.pf.vpf ? [{ k: 'Voluntary PF', rule: `${st.vpf_pct}% of PF wage`, m: p.pf.vpf, neg: true }] : []),
    { k: 'Employee ESI', rule: p.esi.applicable ? '0.75% of gross' : 'Not covered', m: p.esi.applicable ? p.esi.employee : 0, neg: true },
    { k: 'Professional tax', rule: st.pt_applicable ? `${st.pt_state} slab` : 'Exempt', m: p.pt.amount, y: p.pt.amount * 11 + p.pt_february.amount, neg: true },
    { k: 'Income tax (TDS)', rule: `${st.tax_regime_code === 'OLD' ? 'Old' : 'New'} regime`, m: p.tds_monthly, y: p.annual_tax, neg: true },
    { k: 'Take-home', m: p.take_home, net: true },
  ];
  const revs = (history.data ?? []).slice().sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <CardHeader
            title={`Salary breakup · ${structureName}`}
            description={salary.mode === 'CTC' ? `Agreed as annual CTC ${formatINR(salary.amount)}. Gross is worked out from it.` : `Entered as gross ${formatINR(p.gross)} a month. PF and ESI are on top.`}
            actions={
              !ro && (
                <Button variant="outline" size="sm" onClick={() => setRevising(true)}>
                  Revise salary
                </Button>
              )
            }
          />
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Rule</th>
                  <th className="text-right">Monthly</th>
                  <th className="text-right">Yearly</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.k} className={cn(r.total && 'bg-muted/50 font-semibold', r.net && 'bg-success/10 font-semibold')}>
                    <td>{r.k}</td>
                    <td className="text-[13px] text-muted-foreground">{r.rule ?? ''}</td>
                    <td className={cn('text-right num', r.neg && r.m ? 'text-destructive' : '')}>{rupees(r.m, r.neg)}</td>
                    <td className={cn('text-right num', r.neg && r.m ? 'text-destructive' : '')}>{rupees(r.y ?? r.m * 12, r.neg)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="Statutory" />
            <div className="flex flex-col px-5 pb-4 text-[14px]">
              <div className="flex items-center justify-between gap-3 border-b border-dashed py-2.5">
                <div>
                  <div>Provident fund</div>
                  <div className="text-[12px] text-muted-foreground">On the PF wage{st.pf_restrict_to_ceiling ? ' · capped at the wage ceiling' : ' · not capped'}</div>
                </div>
                <Switch checked={st.pf_enabled} disabled={ro || patch.isPending} onCheckedChange={(v) => patch.mutate({ pf_enabled: v })} label="PF" />
              </div>
              {!st.pf_enabled && e.identity?.uan && <Notice tone="warning">PF is off although a UAN is on file. Keep a reason in the log.</Notice>}
              <div className="flex items-center justify-between gap-3 border-b border-dashed py-2.5">
                <div>
                  <div>ESI</div>
                  <div className="text-[12px] text-muted-foreground">
                    {p.esi_within_ceiling ? 'Eligible: gross within the ESI ceiling' : 'Gross is above the ESI ceiling'}
                    {st.esi_locked_until ? ` · covered till ${st.esi_locked_until}` : ''}
                  </div>
                </div>
                <Switch checked={st.esi_enabled} disabled={ro || patch.isPending || (!p.esi_within_ceiling && !st.esi_enabled)} onCheckedChange={(v) => patch.mutate({ esi_enabled: v })} label="ESI" />
              </div>
              {!st.esi_enabled && st.esi_locked_until && <Notice tone="info">ESI continues till the end of this contribution period ({st.esi_locked_until}), then stops.</Notice>}
              <div className="flex justify-between border-b border-dashed py-2.5">
                <span>PT state</span>
                <span>{st.pt_applicable ? st.pt_state : `Exempt — ${st.pt_exempt_reason}`}</span>
              </div>
              <div className="flex justify-between border-b border-dashed py-2.5">
                <span>Tax regime</span>
                <span>
                  {st.tax_regime_code === 'OLD' ? 'Old' : 'New (default)'}
                  {!ro && (
                    <>
                      {' · '}
                      <button type="button" className="text-primary hover:underline" disabled={patch.isPending} onClick={() => patch.mutate({ tax_regime_code: st.tax_regime_code === 'OLD' ? 'NEW' : 'OLD' })}>
                        switch to {st.tax_regime_code === 'OLD' ? 'new' : 'old'}
                      </button>
                    </>
                  )}
                </span>
              </div>
              <div className="flex justify-between py-2.5">
                <span>Monthly TDS</span>
                <span className="num">
                  {formatINR(p.tds_monthly)} · estimated {formatINR(p.annual_tax)} for the year
                </span>
              </div>
            </div>
          </Card>
          <Card>
            <CardHeader title="Revisions" />
            <div className="px-5 pb-4 text-[14px]">
              {history.isLoading && <SkeletonBlock className="h-16" />}
              {revs.map((r, i) => {
                const prev = revs[i + 1];
                return (
                  <div key={r.id} className="flex justify-between gap-3 border-b border-dashed py-2 last:border-0">
                    <span>{prev ? `From ${monthLabel(r.valid_from.slice(0, 7))}` : `Joined ${monthLabel(r.valid_from.slice(0, 7))}`}</span>
                    <b className="num">{prev ? `${formatINR(prev.monthly_gross)} → ${formatINR(r.monthly_gross)}` : formatINR(r.monthly_gross)}</b>
                  </div>
                );
              })}
              {history.data && !revs.length && <p className="py-2 text-muted-foreground">No salary on record.</p>}
            </div>
          </Card>
        </div>
      </div>

      <Card className="overflow-hidden">
        <button type="button" onClick={() => setMore(!more)} className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left hover:bg-accent/40" aria-expanded={more}>
          <span>
            <span className="font-semibold">Full working</span>
            <span className="ml-2 text-[13px] text-muted-foreground">How pay was agreed, PF wage and voluntary PF, PT exemption, salary hold, both tax regimes and declarations</span>
          </span>
          <ChevronDown className={cn('size-4 shrink-0 transition-transform', more && 'rotate-180')} />
        </button>
      </Card>
      {more && (
        <div className="flex flex-col gap-5">
          <SalaryHoldCard e={e} />
          <PayTab e={e} />
          <TaxTab e={e} />
        </div>
      )}
      {revising && <ReviseDialog e={e} onClose={() => setRevising(false)} />}
    </div>
  );
}
