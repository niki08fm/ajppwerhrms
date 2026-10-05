import { useQuery } from '@tanstack/react-query';
import { api } from '@/services/api';
import { inr } from '@/utils';
import { useDebounced } from '@/hooks';
import { Money, ProportionBar } from '@/components/bits';
import { ErrorState, Notice, SkeletonBlock } from '@/components/states';
import { SalaryBreakup } from './SalaryBreakup';

export function useSalaryPreview(args, enabled = true) {
  const d = useDebounced(args, 300);
  return useQuery({
    queryKey: ['salary-preview', d],
    queryFn: () => api.post('/employees/salary-preview', d).then((r) => r.data),
    enabled: enabled && d.amount > 0 && !!(d.pay_group_id || d.structure_id || d.employee_id),
    placeholderData: (prev) => prev,
  });
}

/** As the amount is typed: earnings to gross, company contributions to CTC, deductions to net pay. */
export function SalaryPreviewPanel({ args, chosen, onChoose, compact }) {
  const q = useSalaryPreview({ ...args, chosen_gross: chosen });
  if (!args.amount) return <p className="text-[14px] text-muted-foreground">Type an amount to see the breakdown.</p>;
  if (q.isError) return <ErrorState error={q.error} compact />;
  // No data yet also covers the moment between typing and the debounced request starting.
  if (!q.data) return <SkeletonBlock className="h-48" />;
  const p = q.data;
  const sol = p.solution;
  return (
    <div className={`flex flex-col gap-3 ${q.isFetching ? 'opacity-70' : ''}`}>
      {sol?.ambiguous && (
        <Notice tone="warning">
          <p className="font-medium">This CTC has two valid monthly grosses.</p>
          <p className="mt-0.5">At the ESI ceiling employer ESI switches off, so a higher gross can produce the same CTC. Pick one, or move the CTC out of the band.</p>
          <div className="mt-2 flex flex-col gap-1">
            {[
              { g: sol.gross, label: 'without ESI' },
              { g: sol.alternative.gross, label: 'with ESI' },
            ].map((o) => (
              <label key={o.g} className="flex items-center gap-2">
                <input type="radio" name="gross-choice" checked={chosen === o.g} onChange={() => onChoose?.(o.g)} />
                <Money value={o.g} /> a month {o.label}
              </label>
            ))}
          </div>
        </Notice>
      )}
      {p.structure.over_budget && <Notice tone="warning">The components add up to more than this gross, so the Special Allowance is zero.</Notice>}
      <div className="grid grid-cols-2 gap-3 text-[14px] sm:grid-cols-4">
        <div>
          <div className="text-[13px] text-muted-foreground">Annual gross</div>
          <div className="text-lg font-semibold num">
            <Money value={p.gross * 12} />
          </div>
        </div>
        <div>
          <div className="text-[13px] text-muted-foreground">Monthly gross</div>
          <div className="text-lg font-semibold num">
            <Money value={p.gross} />
          </div>
        </div>
        <div>
          <div className="text-[13px] text-muted-foreground">Annual CTC</div>
          <div className="text-lg font-semibold num">
            <Money value={p.ctc.annual_ctc} />
          </div>
        </div>
        <div>
          <div className="text-[13px] text-muted-foreground">Net pay / month</div>
          <div className="text-lg font-semibold text-success num">
            <Money value={p.take_home} />
          </div>
        </div>
      </div>
      <p className="m-0 rounded-md bg-card px-3 py-2 text-[13px] text-muted-foreground">
        {args.mode === 'CTC'
          ? `A CTC of ${inr(p.ctc.annual_ctc)} a year is ${inr(p.ctc.monthly_cost)} a month. Less the employer's PF ${inr(p.ctc.employer_pf ?? 0)} and ESI ${inr(p.ctc.employer_esi ?? 0)}, the gross is ${inr(p.gross)} a month.`
          : `A gross of ${inr(p.gross * 12)} a year is ${inr(p.gross)} a month. With the employer's PF ${inr(p.ctc.employer_pf ?? 0)} and ESI ${inr(p.ctc.employer_esi ?? 0)} on top, the CTC is ${inr(p.ctc.annual_ctc)} a year.`}
        {p.esi_within_ceiling === false ? ' Not eligible for ESI: the gross is above the ceiling.' : ''}
      </p>
      {!compact && (
        <>
          <ProportionBar parts={p.structure.monthly.map((c) => ({ label: c.name, value: c.amount, colour: c.colour }))} />
          <SalaryBreakup p={p} />
        </>
      )}
    </div>
  );
}
