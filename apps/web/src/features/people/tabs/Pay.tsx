import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { toast } from 'sonner';
import { describeComponentRule, formatINR, pfMaxContribution, type CalcType } from '@ajpwer/shared';
import { api, errorMessage } from '@/lib/api';
import { useLookups } from '@/lib/lookups';
import { cn } from '@/lib/utils';
import { KV, Money, ProportionBar } from '@/components/bits';
import { CHART, tooltipStyle } from '@/components/charts';
import { Chip, ErrorState, Notice, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/form';
import { Dialog, Switch } from '@/components/ui/overlay';
import type { Preview } from '../SalaryPreview';
import { SalaryBreakup } from '../SalaryBreakup';
import type { Employee } from '../types';
import { PayslipPreview } from './PayslipPreview';

interface PayData {
  salary: { mode: 'CTC' | 'GROSS'; amount: number; monthly_gross: number; valid_from: string };
  preview: Preview & { structure: Preview['structure'] & { monthly: (Preview['structure']['monthly'][number] & { calc_type: CalcType })[] } };
  rates: { pf: { ceiling: number; employee_pct: number; employer_pct: number; eps_pct: number }; esi: { ceiling: number; employee_pct: number; employer_pct: number } };
}

function ruleText(c: { calc_type: CalcType; calc_value: number; max_amount?: number | null }) {
  return describeComponentRule(c);
}

export function PayTab({ e }: { e: Employee }) {
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const q = useQuery({ queryKey: ['employee-pay', e.id], queryFn: () => api.get<{ data: PayData | null }>(`/employees/${e.id}/pay`).then((r) => r.data) });
  const st = e.statutory!;
  const [ptReason, setPtReason] = useState('');
  const [askPtOff, setAskPtOff] = useState(false);
  const [restate, setRestate] = useState<null | 'CTC' | 'GROSS'>(null);
  const [vpf, setVpf] = useState(String(st.vpf_pct));

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/employees/${e.id}/statutory`, body),
    onSuccess: () => {
      toast.success('Saved. The change is in the audit log with old and new values.');
      qc.invalidateQueries({ queryKey: ['employee', e.id] });
      qc.invalidateQueries({ queryKey: ['employee-pay', e.id] });
      qc.invalidateQueries({ queryKey: ['employee-tax', e.id] });
      qc.invalidateQueries({ queryKey: ['payslip-preview', e.id] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const doRestate = useMutation({
    mutationFn: (mode: string) => api.post(`/employees/${e.id}/salary/restate`, { mode }),
    onSuccess: () => {
      toast.success('Restated. Actual pay is unchanged; the restatement is recorded.');
      setRestate(null);
      qc.invalidateQueries({ queryKey: ['employee', e.id] });
      qc.invalidateQueries({ queryKey: ['employee-pay', e.id] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (q.isLoading) return <SkeletonBlock className="h-[600px]" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Notice>No salary record yet. Start onboarding or add a salary under Salary history.</Notice>;
  const { salary, preview: p, rates } = q.data;
  const ro = e.read_only;

  const donut = [
    { name: 'Take-home', value: Math.max(0, p.take_home) },
    { name: 'Employee statutory', value: p.employee_statutory },
    { name: 'Employer statutory', value: p.employer_statutory },
  ];

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <div className="flex flex-col gap-4 xl:col-span-2">
        {p.solution?.ambiguous && (
          <Notice tone="warning">
            This salary was agreed as a CTC that lands in the ESI band: <Money value={p.solution.gross} /> without ESI and <Money value={p.solution.alternative!.gross} /> with ESI both reproduce it. Currently paid on <Money value={salary.monthly_gross} />. Move the CTC out of the band to remove the ambiguity.
          </Notice>
        )}
        <Card>
          <CardHeader title="How pay was agreed" description={`Effective from ${salary.valid_from}`} />
          <CardBody className="grid gap-3 sm:grid-cols-2">
            {(['GROSS', 'CTC'] as const).map((m) => (
              <button
                key={m}
                disabled={ro}
                onClick={() => salary.mode !== m && setRestate(m)}
                className={cn('rounded-md border p-3 text-left', salary.mode === m ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-accent')}
                aria-pressed={salary.mode === m}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{m === 'GROSS' ? 'Monthly gross' : 'Annual CTC'}</span>
                  {salary.mode === m && <Chip tone="info">Current</Chip>}
                </div>
                <div className="mt-1 font-display text-xl font-semibold">
                  <Money value={m === 'GROSS' ? p.gross : p.ctc.annual_ctc} />
                </div>
                <p className="mt-1 text-[12px] text-muted-foreground">
                  {m === 'GROSS'
                    ? 'The monthly gross is fixed. Employer PF and ESI are paid on top, so annual CTC is an output.'
                    : 'The annual cost is fixed. Employer contributions come out of it, so gross is solved backwards and can move if rates change.'}
                </p>
              </button>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Salary breakup" description="At full pay, before loss of pay: earnings to gross, company contributions to CTC, deductions to net pay." />
          <CardBody className="flex flex-col gap-3">
            <ProportionBar parts={p.structure.monthly.map((c) => ({ label: c.name, value: c.amount, colour: c.colour }))} />
            <SalaryBreakup
              p={p}
              rates={{ pf: rates.pf, esi: { employee_pct: rates.esi.employee_pct, employer_pct: rates.esi.employer_pct, ceiling: rates.esi.ceiling } }}
              rules={Object.fromEntries(p.structure.monthly.map((c) => [c.name, ruleText(c as { calc_type: CalcType; calc_value: number; max_amount?: number | null })]))}
            />
          </CardBody>
        </Card>
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader title="Provident fund" description={`PF wage ${formatINR(p.pf.pf_wage)} — the components ticked as the PF base, ${st.pf_restrict_to_ceiling ? `capped at ${formatINR(rates.pf.ceiling)}` : 'uncapped'}.`} />
            <CardBody className="flex flex-col gap-3 text-[13px]">
              <label className="flex items-center justify-between">
                PF on
                <Switch checked={st.pf_enabled} disabled={ro} onCheckedChange={(v) => patch.mutate({ pf_enabled: v })} label="PF on" />
              </label>
              <label className="flex items-center justify-between">
                Restrict to the wage ceiling
                <Switch checked={st.pf_restrict_to_ceiling} disabled={ro || !st.pf_enabled} onCheckedChange={(v) => patch.mutate({ pf_restrict_to_ceiling: v })} label="Restrict to ceiling" />
              </label>
              <label className="flex items-center justify-between gap-3">
                Voluntary PF (% of PF wage)
                <span className="flex items-center gap-1">
                  <Input className="h-7 w-16 text-right" value={vpf} disabled={ro || !st.pf_enabled} onChange={(ev) => setVpf(ev.target.value)} onBlur={() => Number(vpf) !== st.vpf_pct && patch.mutate({ vpf_pct: Number(vpf) || 0 })} aria-label="Voluntary PF percent" />%
                </span>
              </label>
              <KV
                cols={2}
                items={[
                  ['Employee', <Money value={p.pf.employee} />],
                  ['Voluntary PF', <Money value={p.pf.vpf} />],
                  ['Employer EPF', <Money value={p.pf.employer_epf} />],
                  ['Pension (EPS)', <Money value={p.pf.eps} />],
                  ['EDLI', <Money value={p.pf.edli} />],
                  ['Admin', <Money value={p.pf.admin} />],
                ]}
              />
              <p className="text-[12px] text-muted-foreground">
                PF is {rates.pf.employee_pct}% of the PF wage.{' '}
                {st.pf_restrict_to_ceiling
                  ? `Restricted to the ${formatINR(rates.pf.ceiling)} ceiling, so it is never more than ${formatINR(pfMaxContribution(rates.pf).employee)} a month.`
                  : 'Not restricted to the ceiling, so it follows the full PF wage.'}{' '}
                Overtime, off-day pay and adhoc bonuses never count. Which components form the base is set in the salary structure.
              </p>
            </CardBody>
          </Card>
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader title="ESI" description={st.esi_locked_until ? `Covered for the contribution period ending ${st.esi_locked_until}` : 'Decided at the start of each April–September and October–March period.'} />
              <CardBody className="flex flex-col gap-2 text-[13px]">
                <label className="flex items-center justify-between">
                  ESI on
                  <Switch checked={st.esi_enabled} disabled={ro || (!p.esi_within_ceiling && !st.esi_enabled)} onCheckedChange={(v) => patch.mutate({ esi_enabled: v })} label="ESI on" />
                </label>
                {!p.esi_within_ceiling && (
                  <p className="text-[12px] text-muted-foreground">
                    Not offered: monthly gross {formatINR(p.gross)} is above the {formatINR(rates.esi.ceiling)} ESI ceiling. {st.esi_locked_until ? 'Contributions continue until the current period ends.' : ''}
                  </p>
                )}
                {p.esi.applicable && (
                  <KV
                    items={[
                      ['Employee 0.75%', <Money value={p.esi.employee} />],
                      ['Employer 3.25%', <Money value={p.esi.employer} />],
                    ]}
                  />
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Professional tax" description="Charged by the state the person works in — not the company's, not the site's." />
              <CardBody className="flex flex-col gap-2 text-[13px]">
                <label className="flex items-center justify-between">
                  Applies
                  <Switch checked={st.pt_applicable} disabled={ro} onCheckedChange={(v) => (v ? patch.mutate({ pt_applicable: true }) : setAskPtOff(true))} label="Professional tax applies" />
                </label>
                {!st.pt_applicable && <p className="text-[12px]">Exempt: {st.pt_exempt_reason}</p>}
                <label className="flex items-center justify-between gap-3">
                  State
                  <Select className="h-7 w-44" value={st.pt_state} disabled={ro} onChange={(ev) => patch.mutate({ pt_state: ev.target.value })} aria-label="PT state">
                    {lk?.pt_states.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </Select>
                </label>
                <div className="flex items-center justify-between">
                  <span>Monthly</span>
                  <span>
                    <Money value={p.pt.amount} />
                    {p.pt_february.amount !== p.pt.amount && (
                      <span className="text-muted-foreground">
                        {' '}
                        · February <Money value={p.pt_february.amount} />
                      </span>
                    )}
                  </span>
                </div>
                {p.pt.basis === 'NIL_SLAB' && <p className="text-[12px] text-muted-foreground">Nil at this salary — that is the state's first slab working, not an exemption. Keep the toggle on.</p>}
                {p.pt.basis === 'NO_PT_STATE' && <p className="text-[12px] text-muted-foreground">{st.pt_state} levies no professional tax.</p>}
              </CardBody>
            </Card>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader title="What this comes to" description="A month at full pay." />
          <CardBody>
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie data={donut} dataKey="value" nameKey="name" innerRadius={50} outerRadius={75} paddingAngle={2}>
                  {donut.map((_, i) => (
                    <Cell key={i} fill={CHART[i]} />
                  ))}
                </Pie>
                <Tooltip {...tooltipStyle} formatter={(v: number) => formatINR(v)} />
              </PieChart>
            </ResponsiveContainer>
            <KV
              cols={1}
              items={[
                ['Take-home', <Money value={p.take_home} className="font-semibold text-success" />],
                ['Employee statutory (PF, ESI, PT, TDS)', <Money value={p.employee_statutory} />],
                ['Employer statutory (PF, EDLI, admin, ESI)', <Money value={p.employer_statutory} />],
                ['Cost to company per month', <Money value={p.ctc.monthly_cost} />],
                ['Annual CTC', <Money value={p.ctc.annual_ctc} />],
              ]}
            />
          </CardBody>
        </Card>
        <PayslipPreview e={e} />
      </div>
      <Dialog
        open={askPtOff}
        onOpenChange={setAskPtOff}
        title="Switch professional tax off"
        description="An exemption is a statutory category, not a preference. Record which one applies."
        footer={
          <>
            <Button variant="outline" onClick={() => setAskPtOff(false)}>
              Cancel
            </Button>
            <Button
              disabled={ptReason.trim().length < 3}
              loading={patch.isPending}
              onClick={() => {
                patch.mutate({ pt_applicable: false, pt_exempt_reason: ptReason });
                setAskPtOff(false);
              }}
            >
              Record exemption
            </Button>
          </>
        }
      >
        <Input autoFocus value={ptReason} onChange={(ev) => setPtReason(ev.target.value)} placeholder="e.g. Person with a disability (certificate on file)" aria-label="Exemption category" />
      </Dialog>
      <Dialog
        open={!!restate}
        onOpenChange={(o) => !o && setRestate(null)}
        title={`Restate as ${restate === 'CTC' ? 'annual CTC' : 'monthly gross'}`}
        description="Actual pay stays identical: the agreement is restated from today, and the audit log records the restatement."
        footer={
          <>
            <Button variant="outline" onClick={() => setRestate(null)}>
              Cancel
            </Button>
            <Button loading={doRestate.isPending} onClick={() => restate && doRestate.mutate(restate)}>
              Restate
            </Button>
          </>
        }
      >
        <p className="text-[13px]">
          {restate === 'CTC' ? (
            <>
              Annual CTC will be recorded as <Money value={p.ctc.annual_ctc} />. If statutory rates change later, gross will be re-solved from this figure.
            </>
          ) : (
            <>
              Monthly gross will be recorded as <Money value={p.gross} />. Employer contributions then sit on top of it.
            </>
          )}
        </p>
      </Dialog>
    </div>
  );
}
