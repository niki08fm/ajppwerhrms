import { addDays, formatINR } from '@ajpwer/shared';
import { ctcForGross, salaryPreview } from '../calculations/index.js';
import { AppError } from '../utils/errors.js';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { ptSlabs, ratesOn, regimesOn, structureComponents } from './rules.service.js';

export async function previewSalary(db, r) {
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
export async function resolveMonthlyGross(db, r) {
  const preview = await previewSalary(db, r);
  if (r.mode === 'CTC') {
    const sol = preview.solution;
    if (sol.ambiguous) {
      const options = [sol.gross, sol.alternative.gross];
      if (r.chosen_gross === undefined || !options.includes(r.chosen_gross)) {
        throw new AppError(
          'CTC_AMBIGUOUS',
          `This CTC has two valid monthly grosses: ${formatINR(sol.gross)} without ESI and ${formatINR(sol.alternative.gross)} with ESI. Pick one, or move the CTC out of the band.`,
          409,
          'amount',
          {
            options: [
              { gross: sol.gross, esi: false },
              { gross: sol.alternative.gross, esi: true },
            ],
          },
        );
      }
    }
    if (sol.approximate) {
      throw new AppError('VALIDATION', 'No monthly gross reproduces this CTC within ₹2 a month on this structure. Adjust the amount.', 422, 'amount');
    }
  }
  return { monthly_gross: preview.gross, preview };
}

/**
 * The annual CTC a salary's "% of CTC" components are worked out on. On a CTC
 * agreement it is the agreed figure; on a gross agreement it is the CTC that
 * gross works out to for this person (their PF and ESI choices), the same figure
 * the profile and offer screens show.
 */
export function ctcBasisOf(salary, components, st, rates) {
  if (salary.mode === 'CTC') return salary.amount;
  return ctcForGross(salary.monthly_gross, {
    components,
    pf: { pf_enabled: st.pf_enabled, pf_restrict_to_ceiling: st.pf_restrict_to_ceiling, vpf_pct: Number(st.vpf_pct) },
    esi_enabled: st.esi_enabled,
    rates,
  }).ctc_basis;
}

/**
 * A revision inserts, never updates: the current record is closed the day
 * before the new effective date and a new one is inserted.
 */
export async function insertSalary(tx, employeeId, validFrom, row, actor) {
  const current = await tx.employeeSalary.findFirst({
    where: { employee_id: employeeId, deleted_at: null, valid_from: { lte: toDbDate(validFrom) }, OR: [{ valid_to: null }, { valid_to: { gte: toDbDate(validFrom) } }] },
    orderBy: { valid_from: 'desc' },
  });
  const later = await tx.employeeSalary.findFirst({ where: { employee_id: employeeId, deleted_at: null, valid_from: { gt: toDbDate(validFrom) } } });
  if (later) throw new AppError('SALARY_OVERLAP', `A salary record already starts on ${fromDbDate(later.valid_from)}, after this date. Revise from a later date.`, 409, 'valid_from');
  if (current && fromDbDate(current.valid_from) === validFrom) {
    throw new AppError('SALARY_OVERLAP', `A salary record already starts on ${validFrom}. Dated records are never overwritten — pick another effective date.`, 409, 'valid_from');
  }
  if (current) await tx.employeeSalary.update({ where: { id: current.id }, data: { valid_to: toDbDate(addDays(validFrom, -1)) } });
  const created = await tx.employeeSalary.create({
    data: {
      employee_id: employeeId,
      valid_from: toDbDate(validFrom),
      mode: row.mode,
      amount: BigInt(row.amount),
      monthly_gross: BigInt(row.monthly_gross),
      structure_id: row.structure_id,
      reason: row.reason,
      created_by: actor,
    },
  });
  return { current, created };
}
