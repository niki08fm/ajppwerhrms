import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { formatINR } from '@ajpwer/shared';
import { api, errorMessage } from '@/services/api';
import { cn, toPaise, toRupeesInput } from '@/utils';
import { Money } from '@/components/bits';
import { Chip, ErrorState, Notice, SkeletonBlock } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Field, MoneyInput, Select } from '@/components/ui/form';
import { Switch } from '@/components/ui/overlay';

function RegimeSelect({ value, disabled, onChange }) {
  return (
    <Select value={value} disabled={disabled} onChange={(ev) => onChange(ev.target.value)} aria-label="Tax regime" className="w-36">
      <option value="NEW">New regime</option>
      <option value="OLD">Old regime</option>
    </Select>
  );
}

function IncomeBreakdown({ w }) {
  const taxable = Math.max(0, Math.min(w.gross, w.taxable));
  const deductions = Math.max(0, w.gross - taxable);
  const taxablePct = w.gross > 0 ? (taxable / w.gross) * 100 : 0;
  const deductionsPct = w.gross > 0 ? (deductions / w.gross) * 100 : 0;
  return (
    <div className="mt-3">
      <div
        role="img"
        aria-label={`Annual income: taxable income ${formatINR(taxable)} and allowed deductions ${formatINR(deductions)}, from gross taxable salary ${formatINR(w.gross)}.`}
        className="flex h-4 overflow-hidden rounded-md bg-muted"
      >
        <div aria-hidden="true" className="bg-primary" style={{ width: `${taxablePct}%` }} />
        <div aria-hidden="true" className="bg-chart-3" style={{ width: `${deductionsPct}%` }} />
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-3 text-[13px]">
        {[
          ['Taxable income', taxable, 'bg-primary'],
          ['Allowed deductions', deductions, 'bg-chart-3'],
        ].map(([label, amount, colour]) => (
          <div key={label}>
            <dt className="flex items-center gap-1.5 text-muted-foreground"><span aria-hidden="true" className={cn('size-2 shrink-0 rounded-sm', colour)} />{label}</dt>
            <dd className="mt-1 font-medium num"><Money value={amount} /></dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function WorkingCard({ w, current, onPick, disabled, selectedOnly = false }) {
  if (!w) {
    return (
      <Card>
        <CardHeader title="Income tax" description="Add a salary agreement to calculate tax." />
        <CardBody>
          <dl className="grid grid-cols-2 gap-3">
            {['Annual tax', 'Monthly TDS'].map((label) => (
              <div key={label}>
                <dt className="text-[13px] text-muted-foreground">{label}</dt>
                <dd className="mt-1 text-xl font-semibold num">—</dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>
    );
  }
  const WorkingDetails = selectedOnly ? 'details' : 'div';
  const row = (label, v, neg = false, strong = false) => (
    <tr className={cn('border-b last:border-0', strong && 'font-semibold')}>
      <td className="py-1">{label}</td>
      <td className="py-1 text-right">
        <Money value={neg ? -v : v} />
      </td>
    </tr>
  );
  return (
    <Card className={cn(!selectedOnly && current && 'ring-2 ring-primary')}>
      <CardHeader
        title={selectedOnly ? 'Income tax' : w.regime === 'NEW' ? 'New regime' : 'Old regime'}
        description={selectedOnly ? 'Annual projection at the current salary.' : `Annual tax ${formatINR(w.total)} · ${formatINR(Math.round(w.total / 12))} a month`}
        actions={
          selectedOnly ? null : current ? (
            <Chip tone="info">Current</Chip>
          ) : (
            <Button size="sm" variant="outline" onClick={onPick} disabled={disabled}>
              Move to this regime
            </Button>
          )
        }
      />

      <CardBody>
        {selectedOnly && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-[13px] text-muted-foreground">Annual tax</div>
                <div className="mt-1 text-xl font-semibold num"><Money value={w.total} /></div>
              </div>
              <div>
                <div className="text-[13px] text-muted-foreground">Monthly TDS</div>
                <div className="mt-1 text-xl font-semibold num"><Money value={Math.round(w.total / 12)} /></div>
              </div>
            </div>
            <dl className="mt-4 text-[14px]">
              <div className="flex justify-between gap-3 border-t border-dashed pt-3">
                <dt className="text-muted-foreground">Gross taxable salary</dt>
                <dd className="num"><Money value={w.gross} /></dd>
              </div>
            </dl>
            <IncomeBreakdown w={w} />
          </>
        )}
        <WorkingDetails className={selectedOnly ? 'mt-3 border-t pt-3' : undefined}>
          {selectedOnly && <summary className="cursor-pointer text-[13px] font-medium text-primary">Tax breakdown</summary>}
        <table className="w-full text-[14px]">
          <tbody>
            {row('Gross taxable salary', w.gross)}
            {row('Standard deduction', w.std_deduction, true)}
            {w.regime === 'OLD' && row('HRA exemption', w.hra_exemption, true)}
            {w.regime === 'OLD' && row('80C', w.deduction_80c, true)}
            {w.regime === 'OLD' && row('80D', w.deduction_80d, true)}
            {row('Taxable income', w.taxable, false, true)}
          </tbody>
        </table>
        <table className="mt-3 w-full text-[13px]">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1">Band</th>
              <th className="text-right">Rate</th>
              <th className="text-right">In band</th>
              <th className="text-right">Tax</th>
            </tr>
          </thead>
          <tbody>
            {w.bands.map((b, i) => (
              <tr key={i} className={cn('border-t', b.taxable_in_band === 0 && 'text-muted-foreground')}>
                <td className="py-1 num">
                  {formatINR(b.from)} – {b.to === null ? 'above' : formatINR(b.to)}
                </td>
                <td className="text-right num">{b.rate}%</td>
                <td className="text-right">
                  <Money value={b.taxable_in_band} />
                </td>
                <td className="text-right">
                  <Money value={b.tax} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="mt-3 w-full text-[14px]">
          <tbody>
            {row('Slab tax', w.slab_tax)}
            {row('Rebate under 87A', w.rebate, true)}
            {w.regime === 'NEW' && row('Marginal relief', w.marginal_relief, true)}
            {row('Health and education cess 4%', w.cess)}
            {row('Annual tax', w.total, false, true)}
          </tbody>
        </table>
        </WorkingDetails>
      </CardBody>
    </Card>
  );
}

/** `selectedOnly` puts declarations above the chosen tax working; other layouts retain the comparison. */
export function TaxTab({ e, compact = false, selectedOnly = false }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['employee-tax', e.id], queryFn: () => api.get(`/employees/${e.id}/tax`).then((r) => r.data) });
  const st = e.statutory;
  const [d, setD] = useState({ c80: '', d80: '', rent: '', metro: false });
  useEffect(() => setD({ c80: toRupeesInput(st.decl_80c), d80: toRupeesInput(st.decl_80d), rent: toRupeesInput(st.decl_rent_monthly), metro: st.decl_metro }), [st]);
  const save = useMutation({
    mutationFn: (body) => api.patch(`/employees/${e.id}/statutory`, body),
    onSuccess: () => {
      toast.success('Saved');
      qc.invalidateQueries({ queryKey: ['employee', e.id] });
      qc.invalidateQueries({ queryKey: ['employee-tax', e.id] });
      qc.invalidateQueries({ queryKey: ['employee-pay', e.id] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (q.isLoading) return <SkeletonBlock className="h-96" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data && !selectedOnly) return <Notice>No salary on record yet.</Notice>;
  const c = q.data?.comparison;
  const regime = q.data?.current ?? st.tax_regime_code ?? 'NEW';
  const worse = c && c.cheaper !== 'EQUAL' && c.cheaper !== regime;
  const disabled = e.read_only || save.isPending || q.isFetching;
  const declarations = (
    <Card role="region" aria-label="Declarations">
      <CardHeader
        title="Declarations"
        description={regime === 'OLD' ? 'Annual figures except rent.' : undefined}
        actions={selectedOnly && <RegimeSelect value={regime} disabled={disabled} onChange={(next) => save.mutate({ tax_regime_code: next })} />}
      />
      <CardBody>
        {regime === 'OLD' ? (
          <>
            <div className={cn('grid gap-3', selectedOnly ? 'sm:grid-cols-2' : 'sm:grid-cols-4')}>
              <Field label="80C (annual)" hint="Capped at ₹1,50,000">
                {(id) => <MoneyInput id={id} value={d.c80} disabled={disabled} onChange={(ev) => setD({ ...d, c80: ev.target.value })} />}
              </Field>
              <Field label="80D (annual)" hint="Capped at ₹25,000">
                {(id) => <MoneyInput id={id} value={d.d80} disabled={disabled} onChange={(ev) => setD({ ...d, d80: ev.target.value })} />}
              </Field>
              <Field label="Rent paid (monthly)">{(id) => <MoneyInput id={id} value={d.rent} disabled={disabled} onChange={(ev) => setD({ ...d, rent: ev.target.value })} />}</Field>
              <Field label="Lives in a metro" hint="HRA limb is 50% of basic in a metro, 40% elsewhere">
                {(id) => (
                  <div className="flex h-8 items-center">
                    <Switch id={id} checked={d.metro} disabled={disabled} onCheckedChange={(v) => setD({ ...d, metro: v })} label="Metro" />
                  </div>
                )}
              </Field>
            </div>
            <div className="mt-3 flex justify-end">
              <Button
                loading={save.isPending}
                disabled={disabled}
                onClick={() => save.mutate({ decl_80c: toPaise(d.c80), decl_80d: toPaise(d.d80), decl_rent_monthly: toPaise(d.rent), decl_metro: d.metro })}
              >
                Save declarations
              </Button>
            </div>
          </>
        ) : (
          <p className="text-[13px] leading-relaxed text-muted-foreground">80C, 80D and rent declarations apply only to the Old regime. Standard deduction is automatic.</p>
        )}
        {!selectedOnly && (
          <p className="mt-2 text-[13px] text-muted-foreground">
            TDS is a projection: it assumes salary continues unchanged and spreads the year's tax evenly. Surcharge above ₹50 lakh and quarterly true-up are not built.
          </p>
        )}
      </CardBody>
    </Card>
  );
  return (
    <div className="flex flex-col gap-4">
      {selectedOnly ? <>
        {declarations}
        <WorkingCard w={regime === 'OLD' ? c?.old : c?.new} selectedOnly />
      </> : <>
        <Notice tone={worse ? 'warning' : 'success'}>
          <strong>{c.sentence}</strong> {worse && `${e.name.split(' ')[0]} is on the ${q.data.current === 'NEW' ? 'new' : 'old'} regime and is ${formatINR(c.difference)} a year worse off.`}
        </Notice>
        {!compact && (
          <div className="grid gap-4 lg:grid-cols-2">
            <WorkingCard w={c.new} current={q.data.current === 'NEW'} disabled={e.read_only} onPick={() => save.mutate({ tax_regime_code: 'NEW' })} />
            <WorkingCard w={c.old} current={q.data.current === 'OLD'} disabled={e.read_only} onPick={() => save.mutate({ tax_regime_code: 'OLD' })} />
          </div>
        )}
        {declarations}
      </>}
    </div>
  );
}
