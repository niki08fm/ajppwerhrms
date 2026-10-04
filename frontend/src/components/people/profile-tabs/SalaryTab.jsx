import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { describeComponentRule, formatINR } from '@ajpwer/shared';
import { api, errorMessage } from '@/services/api';
import { cn, monthLabel } from '@/utils';
import { useLookups } from '@/hooks/useLookups';
import { ErrorState, Notice, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/form';
import { Dialog, Switch } from '@/components/ui/overlay';
import { TaxTab } from './Tax';
import { ReviseDialog } from './SalaryHistory';
import { SalaryHoldCard } from './SalaryHold';

const rupees = (v, neg = false) => (v ? `${neg ? '−' : ''}${formatINR(v)}` : '₹0');

/**
 * Salary and statutory, as one page: hold salary at the top; the breakup line by line
 * (monthly and yearly, from gross to cost to company to take-home); every statutory
 * setting beside it, changed in place; the revisions; and the tax declarations below.
 */
export function SalaryTab({ e }) {
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const [revising, setRevising] = useState(false);
  const [ptOff, setPtOff] = useState(false);
  const [ptReason, setPtReason] = useState('');
  const [vpf, setVpf] = useState(null);
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

  const line = 'flex items-center justify-between gap-3 border-b border-dashed py-2.5';
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-end gap-2 empty:hidden">
        <SalaryHoldCard e={e} compact />
      </div>
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
            <CardHeader title="Statutory" description="Changed here, for this person. Every change is in the audit log." />
            <div className="flex flex-col px-5 pb-4 text-[14px]">
              <div className={line}>
                <div>
                  <div>Provident fund</div>
                  <div className="text-[12px] text-muted-foreground">PF wage {formatINR(p.pf.pf_wage)} · employee {formatINR(p.pf.employee)} a month</div>
                </div>
                <Switch checked={st.pf_enabled} disabled={ro || patch.isPending} onCheckedChange={(v) => patch.mutate({ pf_enabled: v })} label="PF" />
              </div>
              {!st.pf_enabled && e.identity?.uan && <Notice tone="warning">PF is off although a UAN is on file. Keep a reason in the log.</Notice>}
              {st.pf_enabled && (
                <>
                  <div className={line}>
                    <span className="pl-3 text-[13px]">Restrict to the wage ceiling</span>
                    <Switch checked={st.pf_restrict_to_ceiling} disabled={ro || patch.isPending} onCheckedChange={(v) => patch.mutate({ pf_restrict_to_ceiling: v })} label="Restrict to ceiling" />
                  </div>
                  <div className={line}>
                    <span className="pl-3 text-[13px]">Voluntary PF (% of PF wage)</span>
                    <span className="flex items-center gap-1">
                      <Input
                        className="h-7 w-16 text-right"
                        value={vpf ?? String(st.vpf_pct)}
                        disabled={ro}
                        onChange={(ev) => setVpf(ev.target.value)}
                        onBlur={() => vpf !== null && Number(vpf) !== st.vpf_pct && patch.mutate({ vpf_pct: Number(vpf) || 0 })}
                        aria-label="Voluntary PF percent"
                      />
                      %
                    </span>
                  </div>
                </>
              )}
              <div className={line}>
                <div>
                  <div>ESI</div>
                  <div className="text-[12px] text-muted-foreground">
                    {p.esi_within_ceiling ? `Eligible: gross within the ESI ceiling${p.esi.applicable ? ` · employee ${formatINR(p.esi.employee)} a month` : ''}` : 'Gross is above the ESI ceiling'}
                    {st.esi_locked_until ? ` · covered till ${st.esi_locked_until}` : ''}
                  </div>
                </div>
                <Switch checked={st.esi_enabled} disabled={ro || patch.isPending || (!p.esi_within_ceiling && !st.esi_enabled)} onCheckedChange={(v) => patch.mutate({ esi_enabled: v })} label="ESI" />
              </div>
              {!st.esi_enabled && st.esi_locked_until && <Notice tone="info">ESI continues till the end of this contribution period ({st.esi_locked_until}), then stops.</Notice>}
              <div className={line}>
                <div>
                  <div>Professional tax</div>
                  <div className="text-[12px] text-muted-foreground">{st.pt_applicable ? `${formatINR(p.pt.amount)} a month` : `Exempt — ${st.pt_exempt_reason}`}</div>
                </div>
                <Switch checked={st.pt_applicable} disabled={ro || patch.isPending} onCheckedChange={(v) => (v ? patch.mutate({ pt_applicable: true }) : setPtOff(true))} label="Professional tax applies" />
              </div>
              <div className={line}>
                <span className="pl-3 text-[13px]">PT state (where they work)</span>
                <Select className="h-8 w-48" value={st.pt_state} disabled={ro || patch.isPending} onChange={(ev) => patch.mutate({ pt_state: ev.target.value })} aria-label="PT state">
                  {(lk?.pt_states ?? [st.pt_state]).map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </Select>
              </div>
              <div className={line}>
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

      <TaxTab e={e} compact />

      <Dialog
        open={ptOff}
        onOpenChange={setPtOff}
        title="Switch professional tax off"
        description="An exemption is a statutory category, not a preference. Record which one applies."
        footer={
          <>
            <Button variant="outline" onClick={() => setPtOff(false)}>
              Cancel
            </Button>
            <Button
              disabled={ptReason.trim().length < 3}
              loading={patch.isPending}
              onClick={() => {
                patch.mutate({ pt_applicable: false, pt_exempt_reason: ptReason.trim() });
                setPtOff(false);
              }}
            >
              Record exemption
            </Button>
          </>
        }
      >
        <Input autoFocus value={ptReason} onChange={(ev) => setPtReason(ev.target.value)} placeholder="e.g. Person with a disability (certificate on file)" aria-label="Exemption category" />
      </Dialog>
      {revising && <ReviseDialog e={e} onClose={() => setRevising(false)} />}
    </div>
  );
}
