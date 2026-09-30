import { computePf, pfEmployerCost } from '../statutory/pf.js';
import { computeEsi } from '../statutory/esi.js';
import { expandStructure, usesCtc } from './structure.js';

function costAt(gross, ctx, esiApplies, ctcBasis) {
  const s = expandStructure(ctx.components, gross, ctcBasis);
  const pf = computePf(s.pf_base, ctx.pf, ctx.rates.pf);
  const esi = computeEsi(esiApplies, gross, ctx.rates.esi);
  const employer_pf = pfEmployerCost(pf);
  const monthly_cost = s.gross + employer_pf + esi.employer;
  return {
    gross: s.gross,
    employer_pf,
    employer_esi: esi.employer,
    esi_applies: esiApplies,
    yearly_total: s.yearly_total,
    monthly_cost,
    annual_ctc: monthly_cost * 12 + s.yearly_total,
    ctc_basis: ctcBasis,
  };
}

/**
 * Annual CTC for a monthly gross: 12 × (gross + employer PF 12% + employer ESI) + yearly components.
 * EDLI and PF admin charges are not part of CTC.
 * `forceEsi` lets the solver evaluate one side of the ceiling explicitly.
 *
 * `agreedCtc` is the CTC in the salary agreement, when there is one: "% of CTC"
 * components are worked out on it. Without one (a salary agreed as gross), those
 * components depend on the CTC they help produce, so the CTC is found by iterating
 * to its fixed point. Each round moves by a fraction of the last (only employer PF
 * and yearly items feed back), so it settles in a handful of rounds.
 */
export function ctcForGross(gross, ctx, forceEsi, agreedCtc) {
  const esiApplies = forceEsi ?? (ctx.esi_enabled && gross <= ctx.rates.esi.ceiling);
  if (agreedCtc !== undefined || !usesCtc(ctx.components)) return costAt(gross, ctx, esiApplies, agreedCtc ?? 0);

  const tried = [];
  let basis = costAt(gross, ctx, esiApplies, 0).annual_ctc;
  for (let round = 0; round < 60; round++) {
    const next = costAt(gross, ctx, esiApplies, basis);
    if (next.annual_ctc === basis) return next;
    const seen = tried.indexOf(next.annual_ctc);
    if (seen !== -1) {
      // Rupee rounding can leave two neighbouring figures pointing at each other; take the higher, every time.
      return costAt(gross, ctx, esiApplies, Math.max(...tried.slice(seen), basis));
    }
    tried.push(basis);
    basis = next.annual_ctc;
  }
  return costAt(gross, ctx, esiApplies, basis);
}

/** ₹2 a month, annualised */
const TOLERANCE = 2 * 100 * 12;
const RUPEE = 100;

/**
 * Largest whole-rupee gross g in [lo, hi] with ctc(g) ≤ target, then the closer of g and g+1.
 * CTC is monotonic on each side of the ESI ceiling, so bisection is valid within a side.
 */
function bisect(target, loR, hiR, ctc) {
  if (hiR < loR) return null;
  let lo = loR;
  let hi = hiR;
  if (ctc(lo * RUPEE).annual_ctc > target) {
    const b = ctc(lo * RUPEE);
    return { gross: lo * RUPEE, breakdown: b };
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (ctc(mid * RUPEE).annual_ctc <= target) lo = mid;
    else hi = mid - 1;
  }
  const a = ctc(lo * RUPEE);
  if (lo + 1 <= hiR) {
    const b = ctc((lo + 1) * RUPEE);
    if (Math.abs(b.annual_ctc - target) < Math.abs(a.annual_ctc - target)) return { gross: (lo + 1) * RUPEE, breakdown: b };
  }
  return { gross: lo * RUPEE, breakdown: a };
}

/**
 * Solve monthly gross from annual CTC.
 *
 * CTC is NOT monotonic in gross: at the ESI ceiling employer ESI switches off, so
 * a rupee more of gross gives a lower CTC. Every CTC in that band has two valid
 * grosses. A single bisection over the whole range silently returns a wrong answer
 * there, so each side of the ceiling is solved separately. "% of CTC" components
 * are worked out on the CTC being solved for, so they stay put while gross moves
 * and the Special Allowance absorbs the difference.
 */
export function solveGrossFromCtc(annualCtc, ctx) {
  const ceilingR = Math.floor(ctx.rates.esi.ceiling / RUPEE);
  const maxR = Math.max(1, Math.floor(annualCtc / 12 / RUPEE));
  const ok = (s) => !!s && Math.abs(s.breakdown.annual_ctc - annualCtc) <= TOLERANCE;

  if (!ctx.esi_enabled) {
    const s = bisect(annualCtc, 0, maxR, (g) => ctcForGross(g, ctx, false, annualCtc));
    return { gross: s.gross, breakdown: s.breakdown, ambiguous: false, alternative: null, approximate: !ok(s) };
  }

  // 1. [0, ceiling] with ESI applied
  const withEsi = bisect(annualCtc, 0, Math.min(ceilingR, maxR), (g) => ctcForGross(g, ctx, true, annualCtc));
  const esiSide = withEsi && withEsi.gross <= ctx.rates.esi.ceiling && ok(withEsi) ? withEsi : null;

  // 2. (ceiling, ctc/12] with ESI off
  const withoutEsi = maxR > ceilingR ? bisect(annualCtc, ceilingR + 1, maxR, (g) => ctcForGross(g, ctx, false, annualCtc)) : null;
  const plainSide = withoutEsi && withoutEsi.gross > ctx.rates.esi.ceiling && ok(withoutEsi) ? withoutEsi : null;

  if (esiSide && plainSide) {
    return { gross: plainSide.gross, breakdown: plainSide.breakdown, ambiguous: true, alternative: esiSide, approximate: false };
  }
  const found = plainSide ?? esiSide;
  if (found) return { gross: found.gross, breakdown: found.breakdown, ambiguous: false, alternative: null, approximate: false };

  // Nothing reproduced within tolerance: return the nearest candidate, flagged.
  const candidates = [withEsi, withoutEsi].filter(Boolean);
  candidates.sort((a, b) => Math.abs(a.breakdown.annual_ctc - annualCtc) - Math.abs(b.breakdown.annual_ctc - annualCtc));
  const best = candidates[0] ?? { gross: 0, breakdown: ctcForGross(0, ctx, undefined, annualCtc) };
  return { gross: best.gross, breakdown: best.breakdown, ambiguous: false, alternative: null, approximate: true };
}
