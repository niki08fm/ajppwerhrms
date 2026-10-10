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

// Monthly salary is rounded to whole rupees. Component/statutory rounding can
// add neighboring steps. New agreements use the resulting calculated CTC.
export const CTC_ROUNDING_LIMIT = 24 * 100;
const RUPEE = 100;

/**
 * Largest whole-rupee gross g in [lo, hi] with ctc(g) ≤ target, then the closer of g and g+1.
 * CTC is monotonic on each side of the ESI ceiling, so bisection is valid within a side.
 */
function bisect(target, minGross, maxGross, ctc) {
  if (maxGross < minGross) return null;
  let lo = minGross;
  let hi = maxGross;
  if (ctc(lo * RUPEE).annual_ctc > target) {
    return { gross: lo * RUPEE, breakdown: ctc(lo * RUPEE) };
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (ctc(mid * RUPEE).annual_ctc <= target) lo = mid;
    else hi = mid - 1;
  }
  const a = ctc(lo * RUPEE);
  if (lo + 1 <= maxGross) {
    const b = ctc((lo + 1) * RUPEE);
    if (Math.abs(b.annual_ctc - target) <= Math.abs(a.annual_ctc - target)) return { gross: (lo + 1) * RUPEE, breakdown: b };
  }
  return { gross: lo * RUPEE, breakdown: a };
}

/**
 * A PF-counted remainder includes independently rounded components. Inspect
 * neighboring whole-rupee candidates around the bisection bracket as well.
 */
function solveSide(target, minGross, maxGross, ctc, componentCount) {
  const minRupees = Math.ceil(minGross / RUPEE);
  const maxRupees = Math.floor(maxGross / RUPEE);
  if (maxRupees < minRupees) return null;
  const cache = new Map();
  const at = (gross) => {
    if (!cache.has(gross)) cache.set(gross, ctc(gross));
    return cache.get(gross);
  };
  const candidate = bisect(target, minRupees, maxRupees, at);
  const difference = (s) => Math.abs(s.breakdown.annual_ctc - target);
  const validGross = (s) => s.gross === s.breakdown.gross;
  // A target beyond this branch's endpoints cannot acquire eligibility merely
  // because its nearest total differs by only a few paise.
  const inRange = target >= at(minGross).annual_ctc && target <= at(maxGross).annual_ctc;
  if (validGross(candidate) && difference(candidate) === 0) return { ...candidate, in_range: inRange };

  const radius = 2 + Math.ceil(componentCount / 50);
  let best = candidate;
  // A fixed structure can make cost flat over a range. Its actual expanded
  // gross is the only acceptable candidate, rather than the end of that range.
  const expandedGross = candidate.breakdown.gross;
  if (expandedGross % RUPEE === 0 && expandedGross >= minGross && expandedGross <= maxGross) {
    const expandedCandidate = { gross: expandedGross, breakdown: at(expandedGross) };
    if (validGross(expandedCandidate) && (!validGross(best) || difference(expandedCandidate) < difference(best))) best = expandedCandidate;
  }
  for (let rupees = Math.max(minRupees, candidate.gross / RUPEE - radius); rupees <= Math.min(maxRupees, candidate.gross / RUPEE + radius); rupees++) {
    const gross = rupees * RUPEE;
    const s = { gross, breakdown: at(gross) };
    if (!validGross(s)) continue;
    if (!validGross(best) || difference(s) < difference(best)) best = s;
    if (difference(s) === 0) break;
  }
  return { ...best, in_range: inRange };
}

/**
 * Solve monthly gross from annual CTC.
 *
 * CTC is NOT monotonic in gross: at the ESI ceiling employer ESI switches off, so
 * a paise more of gross gives a lower CTC. A CTC in that band can have two valid
 * grosses. A single bisection over the whole range silently returns a wrong answer
 * there, so each side of the ceiling is solved separately. "% of CTC" components
 * are worked out on the CTC being solved for, so they stay put while gross moves
 * and the Special Allowance absorbs the difference.
 */
export function solveGrossFromCtc(annualCtc, ctx) {
  const ceiling = Math.floor(ctx.rates.esi.ceiling);
  const maxGross = Math.max(RUPEE, Math.ceil(annualCtc / 12 / RUPEE) * RUPEE);
  // Test the entered target against branch endpoints before salary rounding;
  // a small annual difference must never manufacture ESI eligibility.
  const ok = (s) => !!s && s.in_range && s.gross === s.breakdown.gross && Math.abs(s.breakdown.annual_ctc - annualCtc) <= CTC_ROUNDING_LIMIT;
  const side = (min, max, esi) => solveSide(annualCtc, min, max, (g) => ctcForGross(g, ctx, esi, annualCtc), ctx.components.length);

  if (!ctx.esi_enabled) {
    const s = side(0, maxGross, false);
    return { gross: s.gross, breakdown: s.breakdown, ambiguous: false, alternative: null, approximate: !ok(s) };
  }

  // 1. [0, ceiling] with ESI applied
  const withEsi = side(0, Math.min(ceiling, maxGross), true);
  const esiSide = withEsi && withEsi.gross <= ctx.rates.esi.ceiling && ok(withEsi) ? { gross: withEsi.gross, breakdown: withEsi.breakdown } : null;

  // 2. (ceiling, ctc/12] with ESI off
  const withoutEsi = maxGross > ceiling ? side(ceiling + 1, maxGross, false) : null;
  const plainSide = withoutEsi && withoutEsi.gross > ctx.rates.esi.ceiling && ok(withoutEsi) ? { gross: withoutEsi.gross, breakdown: withoutEsi.breakdown } : null;

  if (esiSide && plainSide) {
    // Preview the eligible ESI option first. Both remain explicit choices when
    // saving the agreement; a preview default does not settle that decision.
    return { gross: esiSide.gross, breakdown: esiSide.breakdown, ambiguous: true, alternative: plainSide, approximate: false };
  }
  const found = plainSide ?? esiSide;
  if (found) return { gross: found.gross, breakdown: found.breakdown, ambiguous: false, alternative: null, approximate: false };

  // No genuine result within the annual rounding limit: return the nearest
  // candidate, flagged so saving can reject a material CTC difference.
  const candidates = [withEsi, withoutEsi].filter(Boolean);
  candidates.sort((a, b) => Math.abs(a.breakdown.annual_ctc - annualCtc) - Math.abs(b.breakdown.annual_ctc - annualCtc));
  const best = candidates[0] ?? { gross: 0, breakdown: ctcForGross(0, ctx, undefined, annualCtc) };
  return { gross: best.gross, breakdown: best.breakdown, ambiguous: false, alternative: null, approximate: true };
}
