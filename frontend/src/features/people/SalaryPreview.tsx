import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { Money, ProportionBar } from '@/components/bits';
import { ErrorState, Notice, SkeletonBlock } from '@/components/states';
import { SalaryBreakup } from './SalaryBreakup';

export interface Preview {
  gross: number;
  structure: { monthly: { name: string; amount: number; calc_type: string; calc_value: number; max_amount?: number | null; colour?: string }[]; yearly: { name: string; amount: number; pay_month: number | null }[]; basic: number; hra: number; pf_base: number; over_budget: boolean };
  ctc: { gross: number; employer_pf: number; employer_esi: number; esi_applies: boolean; yearly_total: number; monthly_cost: number; annual_ctc: number; ctc_basis: number };
  solution: { gross: number; ambiguous: boolean; alternative: { gross: number } | null; approximate: boolean } | null;
  pf: { pf_wage: number; employee: number; vpf: number; employer_total: number; employer_epf: number; eps: number; edli: number; admin: number };
  esi: { applicable: boolean; employee: number; employer: number };
  esi_within_ceiling: boolean;
  pt: { amount: number; state: string; basis: string };
  pt_february: { amount: number };
  tds_monthly: number;
  annual_tax: number;
  employee_statutory: number;
  employer_statutory: number;
  take_home: number;
}

export interface PreviewArgs {
  mode: 'GROSS' | 'CTC';
  amount: number;
  pay_group_id?: string;
  structure_id?: string;
  employee_id?: string;
  gender?: string;
  pt_state?: string;
  chosen_gross?: number;
  date?: string;
}

export function useSalaryPreview(args: PreviewArgs, enabled = true) {
  const d = useDebounced(args, 300);
  return useQuery({
    queryKey: ['salary-preview', d],
    queryFn: () => api.post<{ data: Preview }>('/employees/salary-preview', d).then((r) => r.data),
    enabled: enabled && d.amount > 0 && !!(d.pay_group_id || d.structure_id || d.employee_id),
    placeholderData: (prev) => prev,
  });
}

/** As the amount is typed: earnings to gross, company contributions to CTC, deductions to net pay. */
export function SalaryPreviewPanel({ args, chosen, onChoose, compact }: { args: PreviewArgs; chosen?: number; onChoose?: (g: number) => void; compact?: boolean }) {
  const q = useSalaryPreview({ ...args, chosen_gross: chosen });
  if (!args.amount) return <p className="text-[13px] text-muted-foreground">Type an amount to see the breakdown.</p>;
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
              { g: sol.alternative!.gross, label: 'with ESI' },
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
      <div className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
        <div>
          <div className="text-[12px] text-muted-foreground">Monthly gross</div>
          <div className="font-display text-lg font-semibold">
            <Money value={p.gross} />
          </div>
        </div>
        <div>
          <div className="text-[12px] text-muted-foreground">Cost to company / month</div>
          <div className="font-display text-lg font-semibold">
            <Money value={p.ctc.monthly_cost} />
          </div>
        </div>
        <div>
          <div className="text-[12px] text-muted-foreground">Annual CTC</div>
          <div className="font-display text-lg font-semibold">
            <Money value={p.ctc.annual_ctc} />
          </div>
        </div>
        <div>
          <div className="text-[12px] text-muted-foreground">Net pay / month</div>
          <div className="font-display text-lg font-semibold text-success">
            <Money value={p.take_home} />
          </div>
        </div>
      </div>
      {!compact && (
        <>
          <ProportionBar parts={p.structure.monthly.map((c) => ({ label: c.name, value: c.amount, colour: c.colour }))} />
          <SalaryBreakup p={p} />
        </>
      )}
    </div>
  );
}
