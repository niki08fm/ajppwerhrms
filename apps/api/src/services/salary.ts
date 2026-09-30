import { formatINR, type Gender, type ISODate, type SalaryMode } from '@ajpwer/shared';
import { salaryPreview, type SalaryPreview } from '../engines';
import { AppError } from '../lib/errors';
import type { Db } from '../lib/prisma';
import { ptSlabs, ratesOn, regimesOn, structureComponents } from './rules';

export interface PreviewRequest {
  mode: SalaryMode;
  amount: number;
  structure_id: string;
  date: ISODate;
  gender: Gender;
  pt_state: string;
  pt_applicable?: boolean;
  pf_enabled?: boolean;
  pf_restrict_to_ceiling?: boolean;
  vpf_pct?: number;
  esi_enabled?: boolean;
  tax_regime_code?: string;
  declarations?: { decl_80c: number; decl_80d: number; decl_rent_monthly: number; decl_metro: boolean };
  chosen_gross?: number;
}

export async function previewSalary(db: Db, r: PreviewRequest): Promise<SalaryPreview> {
  const [components, rates, slabs, regimes] = await Promise.all([structureComponents(db, r.structure_id), ratesOn(db, r.date), ptSlabs(db), regimesOn(db, r.date)]);
  if (components.length === 0) throw new AppError('VALIDATION', 'That salary structure has no components.', 422);
  return salaryPreview({
    mode: r.mode,
    amount: r.amount,
    components,
    pf: { pf_enabled: r.pf_enabled ?? true, pf_restrict_to_ceiling: r.pf_restrict_to_ceiling ?? true, vpf_pct: r.vpf_pct ?? 0 },
    esi_enabled: r.esi_enabled ?? true,
    pt: { pt_applicable: r.pt_applicable ?? true, pt_state: r.pt_state, gender: r.gender },
    rates: { pf: rates.pf, esi: rates.esi },
    pt_slabs: slabs,
    regime: r.tax_regime_code === 'OLD' ? regimes.OLD : regimes.NEW,
    declarations: r.declarations ?? { decl_80c: 0, decl_80d: 0, decl_rent_monthly: 0, decl_metro: false },
    chosen_gross: r.chosen_gross,
    month: Number(r.date.slice(5, 7)),
  });
}

/**
 * The monthly gross a salary agreement resolves to. A CTC inside the ESI band
 * has two valid grosses; the caller must choose one (CTC_AMBIGUOUS otherwise).
 */
export async function resolveMonthlyGross(db: Db, r: PreviewRequest): Promise<{ monthly_gross: number; preview: SalaryPreview }> {
  const preview = await previewSalary(db, r);
  if (r.mode === 'CTC') {
    const sol = preview.solution!;
    if (sol.ambiguous) {
      const options = [sol.gross, sol.alternative!.gross];
      if (r.chosen_gross === undefined || !options.includes(r.chosen_gross)) {
        throw new AppError(
          'CTC_AMBIGUOUS',
          `This CTC has two valid monthly grosses: ${formatINR(sol.gross)} without ESI and ${formatINR(sol.alternative!.gross)} with ESI. Pick one, or move the CTC out of the band.`,
          409,
          'amount',
          { options: [{ gross: sol.gross, esi: false }, { gross: sol.alternative!.gross, esi: true }] },
        );
      }
    }
    if (sol.approximate) {
      throw new AppError('VALIDATION', 'No monthly gross reproduces this CTC within ₹2 a month on this structure. Adjust the amount.', 422, 'amount');
    }
  }
  return { monthly_gross: preview.gross, preview };
}
