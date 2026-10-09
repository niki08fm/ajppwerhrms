import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { describeComponentRule, formatINR } from '@ajpwer/shared';
import { api, errorMessage } from '@/services/api';
import { useLookups } from '@/hooks/useLookups';
import { ErrorState, Notice, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Input, Select, Segmented } from '@/components/ui/form';
import { Dialog, Switch } from '@/components/ui/overlay';
import { TaxTab } from './Tax';
import { ReviseDialog, SalaryHistoryTab, refreshEmployeePay } from './SalaryHistory';
import { SalaryAssignment } from './SalaryAssignment';
import { SalaryOverview } from './SalaryOverview';
import { SalaryHoldCard } from './SalaryHold';
import { SalaryBreakup } from '../SalaryBreakup';

/**
 * Salary shows the monthly/yearly breakup with revisions beside it. Statutory
 * holds personal deductions, the selected tax regime and declarations.
 */
export function SalaryTab({ e }) {
  const qc = useQueryClient();
  const { data: lk } = useLookups();
  const [revising, setRevising] = useState(false);
  const [sp, setSp] = useSearchParams();
  const view = ['statutory', 'tax'].includes(sp.get('section')) || (!sp.get('section') && sp.get('tab') === 'tax') ? 'statutory' : 'salary';
  const setView = (next) => {
    const params = new URLSearchParams(sp);
    params.set('section', next);
    setSp(params, { replace: true });
  };
  const [ptOff, setPtOff] = useState(false);
  const [ptReason, setPtReason] = useState('');
  const [vpf, setVpf] = useState(null);
  const pay = useQuery({
    queryKey: ['employee-pay', e.id],
    queryFn: () => api.get(`/employees/${e.id}/pay`).then((r) => r.data),
  });
  const st = e.statutory;
  const patch = useMutation({
    mutationFn: (body) => api.patch(`/employees/${e.id}/statutory`, body),
    onSuccess: () => {
      toast.success('Saved. The change is in the audit log with old and new values.');
      refreshEmployeePay(qc, e.id);
      setVpf(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const salary = pay.data?.salary ?? e.salary;
  const p = pay.data?.preview;
  const ro = e.read_only;
  const structureName =
    lk?.structures?.find((structure) => structure.id === salary?.structure_id)?.name ?? salary?.structure?.name ?? 'Selected salary structure';

  const line = 'flex items-center justify-between gap-3 border-b border-dashed py-2.5';
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Segmented
          label="Salary and statutory section"
          value={view}
          onChange={setView}
          options={[
            { value: 'salary', label: 'Salary' },
            { value: 'statutory', label: 'Statutory' },
          ]}
        />
        {view === 'salary' && <SalaryHoldCard e={e} compact />}
      </div>
      {view === 'salary' && (
        <>
          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <div className="min-w-0 flex flex-col gap-4">
              {pay.isLoading ? (
                <SkeletonBlock className="h-96" />
              ) : pay.isError ? (
                <ErrorState error={pay.error} onRetry={() => pay.refetch()} />
              ) : !salary || !p ? (
                <Card>
                  <CardHeader
                    title={salary ? 'Salary calculation unavailable' : 'No salary yet'}
                    description={
                      salary
                        ? 'The salary agreement is on file. Deductions need the applicable statutory rates.'
                        : 'Add a salary agreement and choose its effective date and salary structure.'
                    }
                    actions={!ro && <Button onClick={() => setRevising(true)}>{salary ? 'Revise salary' : 'Add salary'}</Button>}
                  />
                </Card>
              ) : (
                <Card className="overflow-hidden">
                  <CardHeader
                    title={`Salary breakup · ${structureName}`}
                    actions={
                      !ro && (
                        <Button variant="outline" size="sm" onClick={() => setRevising(true)}>
                          Revise salary
                        </Button>
                      )
                    }
                  />
                  <div className="overflow-x-auto p-5">
                    <SalaryBreakup
                      p={p}
                      rates={pay.data.rates}
                      rules={Object.fromEntries(p.structure.monthly.map((component) => [component.name, describeComponentRule(component)]))}
                    />
                  </div>
                </Card>
              )}
            </div>

            <div className="min-w-0 flex flex-col gap-4">
              <SalaryAssignment e={e} salary={salary} />
              {!pay.isLoading && !pay.isError && salary && p && <SalaryOverview p={p} />}
              <SalaryHistoryTab e={e} compact />
            </div>
          </div>
        </>
      )}
      {view === 'statutory' && (
        <>
          <div id="section-statutory" className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-4">
              {!p && (
                <Notice>
                  Statutory settings can be changed here.{' '}
                  {salary ? 'Deduction amounts need the applicable statutory rates.' : 'Add a salary to calculate deduction amounts.'}
                </Notice>
              )}
              <Card>
                <CardHeader title="Statutory deductions" />
                <div className="flex flex-col px-5 pb-4 text-[14px]">
                  <div className={line}>
                    <div>
                      <div>Provident fund</div>
                      <div className="text-[12px] text-muted-foreground">
                        {p
                          ? `PF wage ${formatINR(p.pf.pf_wage)} · employee ${formatINR(p.pf.employee)} a month`
                          : 'Employee and employer contributions use the configured PF wage and rates'}
                      </div>
                    </div>
                    <Switch checked={st.pf_enabled} disabled={ro || patch.isPending} onCheckedChange={(v) => patch.mutate({ pf_enabled: v })} label="PF" />
                  </div>
                  {!st.pf_enabled && e.identity?.uan && <Notice tone="warning">PF is off although a UAN is on file. Keep a reason in the log.</Notice>}
                  {st.pf_enabled && (
                    <>
                      <div className={line}>
                        <span className="pl-3 text-[13px]">Restrict to the wage ceiling</span>
                        <Switch
                          checked={st.pf_restrict_to_ceiling}
                          disabled={ro || patch.isPending}
                          onCheckedChange={(v) => patch.mutate({ pf_restrict_to_ceiling: v })}
                          label="Restrict to ceiling"
                        />
                      </div>
                      <div className={line}>
                        <span className="pl-3 text-[13px]">Voluntary PF (% of PF wage)</span>
                        <span className="flex items-center gap-1">
                          <Input
                            className="h-7 w-16 text-right"
                            type="number"
                            min="0"
                            max="100"
                            step="0.01"
                            value={vpf ?? String(st.vpf_pct)}
                            disabled={ro || patch.isPending}
                            onChange={(ev) => setVpf(ev.target.value)}
                            onBlur={() => {
                              if (vpf === null) return;
                              const value = Number(vpf);
                              if (!Number.isFinite(value) || value < 0 || value > 100) {
                                toast.error('Voluntary PF must be between 0 and 100%.');
                                setVpf(null);
                              } else if (value !== st.vpf_pct) patch.mutate({ vpf_pct: value });
                              else setVpf(null);
                            }}
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
                        {!p
                          ? 'Salary required to check the ESI ceiling'
                          : p.esi_within_ceiling
                            ? `Eligible: gross within the ESI ceiling${p.esi.applicable ? ` · employee ${formatINR(p.esi.employee)} a month` : ''}`
                            : 'Gross is above the ESI ceiling'}
                        {st.esi_locked_until ? ` · covered till ${st.esi_locked_until}` : ''}
                      </div>
                    </div>
                    <Switch
                      checked={st.esi_enabled}
                      disabled={ro || patch.isPending || (p && !p.esi_within_ceiling && !st.esi_enabled)}
                      onCheckedChange={(v) => patch.mutate({ esi_enabled: v })}
                      label="ESI"
                    />
                  </div>
                  {!st.esi_enabled && st.esi_locked_until && (
                    <Notice tone="info">ESI continues till the end of this contribution period ({st.esi_locked_until}), then stops.</Notice>
                  )}
                  <div className={line}>
                    <div>
                      <div>Professional tax</div>
                      <div className="text-[12px] text-muted-foreground">
                        {st.pt_applicable
                          ? p
                            ? `${formatINR(p.pt.amount)} a month`
                            : `${st.pt_state} slab; amount calculated after salary is added`
                          : `Exempt — ${st.pt_exempt_reason}`}{' '}
                      </div>
                    </div>
                    <Switch
                      checked={st.pt_applicable}
                      disabled={ro || patch.isPending}
                      onCheckedChange={(v) => (v ? patch.mutate({ pt_applicable: true }) : setPtOff(true))}
                      label="Professional tax applies"
                    />
                  </div>
                  <div className={line}>
                    <span className="pl-3 text-[13px]">PT state (where they work)</span>
                    <Select
                      className="h-8 w-48"
                      value={st.pt_state}
                      disabled={ro || patch.isPending}
                      onChange={(ev) => patch.mutate({ pt_state: ev.target.value })}
                      aria-label="PT state"
                    >
                      {(lk?.pt_states ?? [st.pt_state]).map((x) => (
                        <option key={x}>{x}</option>
                      ))}
                    </Select>
                  </div>
                </div>
              </Card>
            </div>
            <div className="flex flex-col gap-4">
              <TaxTab e={e} selectedOnly />
            </div>
          </div>
        </>
      )}

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
                patch.mutate({
                  pt_applicable: false,
                  pt_exempt_reason: ptReason.trim(),
                });
                setPtOff(false);
              }}
            >
              Record exemption
            </Button>
          </>
        }
      >
        <Input
          autoFocus
          value={ptReason}
          onChange={(ev) => setPtReason(ev.target.value)}
          placeholder="e.g. Person with a disability (certificate on file)"
          aria-label="Exemption category"
        />
      </Dialog>
      {revising && <ReviseDialog e={e} onClose={() => setRevising(false)} />}
    </div>
  );
}
