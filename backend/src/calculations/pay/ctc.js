import { computePf, pfEmployerCost } from '../statutory/pf.js';
import { computeEsi } from '../statutory/esi.js';
import { expandStructure, usesCtc } from './structure.js';

function costAt(gross, ctx, esiApplies, ctcBasis) {
  const s = expandStructure(ctx.components, gross, ctcBasis);
  const pf = computePf(s.pf_base, ctx.pf, ctx.rates.pf);
  const eligible = s.esi_base <= ctx.rates.esi.ceiling;
  const applicable = esiApplies ?? (ctx.esi_enabled && eligible);
  const esi = computeEsi(applicable, s.esi_base, ctx.rates.esi);
  const employer_pf = pfEmployerCost(pf);
  const monthly_cost = s.gross + employer_pf + esi.employer;
  return {
    gross: s.gross,
    employer_pf,
    employer_esi: esi.employer,
    esi_applies: applicable,
    esi_wage: s.esi_base,
    yearly_total: s.yearly_total,
    monthly_cost,
    annual_ctc: monthly_cost * 12 + s.yearly_total,
    ctc_basis: ctcBasis,
  };
}

/**
 * Annual CTC for a monthly gross: 12 × (gross + employer PF 12% + employer ESI) + yearly components.
 * ESI eligibility and contributions use the selected monthly ESI wage.
 * EDLI and PF admin charges are not part of CTC.
 * `forceEsi` lets the solver evaluate one side of the ceiling explicitly.
 *
 * `agreedCtc` is the CTC in the salary agreement, when there is one: "% of CTC"
 * components are worked out on it. Without one (a salary agreed as gross), those
 * components depend on the CTC they help produce, so the CTC is found by iterating
 * to its fixed point. Each round moves by a fraction of the last (only employer PF
 * and yearly items feed back), so it settles in a handful of rounds.
 */
export function ctcForGross(gross, ctx, forceEsi, agreedCtc, { round_annual_up = false } = {}) {
  const at = (basis) => {
    const cost = costAt(gross, ctx, forceEsi, basis);
    return round_annual_up ? { ...cost, raw_annual_ctc: cost.annual_ctc, annual_ctc: Math.ceil(cost.annual_ctc / 100) * 100 } : cost;
  };
  if (agreedCtc !== undefined || !usesCtc(ctx.components)) return at(agreedCtc ?? 0);

  const tried = [];
  let basis = at(0).annual_ctc;
  for (let round = 0; round < 60; round++) {
    const next = at(basis);
    if (next.annual_ctc === basis) return next;
    const seen = tried.indexOf(next.annual_ctc);
    if (seen !== -1) {
      // Rupee rounding can leave two neighbouring figures pointing at each other; take the higher, every time.
      return at(Math.max(...tried.slice(seen), basis));
    }
    tried.push(basis);
    basis = next.annual_ctc;
  }
  return at(basis);
}

const RUPEE = 100;

/**
 * Smallest whole-rupee gross g in [lo, hi] with ctc(g) ≥ target.
 * Bisection locates the bracket on one side of the ESI ceiling; a subsequent
 * local scan accounts for component rounding and unstable fixed points.
 */
function bisect(target, minGross, maxGross, ctc) {
  if (maxGross < minGross) return null;
  let lo = minGross;
  let hi = maxGross;
  if (ctc(hi * RUPEE).annual_ctc < target) {
    return { gross: hi * RUPEE, breakdown: ctc(hi * RUPEE) };
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ctc(mid * RUPEE).annual_ctc >= target) hi = mid;
    else lo = mid + 1;
  }
  return { gross: lo * RUPEE, breakdown: ctc(lo * RUPEE) };
}

/**
 * A PF-counted remainder includes independently rounded components. Inspect
 * neighboring whole-rupee candidates around the bisection bracket as well.
 */
function solveSide(target, minGross, maxGross, ctc, rangeCtc, componentCount, needsStableBasis, eligible = () => true) {
  const minRupees = Math.ceil(minGross / RUPEE);
  const maxRupees = Math.floor(maxGross / RUPEE);
  if (maxRupees < minRupees) return null;
  const cache = new Map();
  const at = (gross) => {
    if (!cache.has(gross)) cache.set(gross, ctc(gross));
    return cache.get(gross);
  };
  const candidate = bisect(target, minRupees, maxRupees, at);
  const validGross = (s) => s.gross === s.breakdown.gross && (!needsStableBasis || s.breakdown.ctc_basis === s.breakdown.annual_ctc);
  const qualifies = (s) => validGross(s) && eligible(s) && s.breakdown.annual_ctc >= target;
  // Annual/salary rounding cannot make a target beyond this branch eligible.
  const inRange = target >= rangeCtc(minGross).annual_ctc && target <= rangeCtc(maxGross).annual_ctc;

  const radius = 2 + Math.ceil(componentCount / 50);
  let best = candidate;
  // A fixed structure can make cost flat over a range. Its actual expanded
  // gross is the only acceptable candidate, rather than the end of that range.
  const expandedGross = candidate.breakdown.gross;
  if (expandedGross % RUPEE === 0 && expandedGross >= minGross && expandedGross <= maxGross) {
    const expandedCandidate = { gross: expandedGross, breakdown: at(expandedGross) };
    if (qualifies(expandedCandidate) && (!qualifies(best) || expandedCandidate.gross < best.gross)) best = expandedCandidate;
  }
  for (let rupees = Math.max(minRupees, candidate.gross / RUPEE - radius); rupees <= Math.min(maxRupees, candidate.gross / RUPEE + radius); rupees++) {
    const gross = rupees * RUPEE;
    const s = { gross, breakdown: at(gross) };
    if (!qualifies(s)) continue;
    if (!qualifies(best) || s.gross < best.gross) best = s;
  }
  const previous = at(Math.max(0, best.gross - RUPEE));
  // The legitimate upward change is bounded by this salary's neighboring
  // whole-rupee cost step, including its normal statutory/yearly rounding.
  const annualCeil = Math.max(0, best.breakdown.annual_ctc - (best.breakdown.raw_annual_ctc ?? best.breakdown.annual_ctc));
  const roundingLimit = Math.max(0, best.breakdown.annual_ctc - previous.annual_ctc) + annualCeil;
  return { ...best, in_range: inRange, rounding_limit: roundingLimit };
}

/**
 * Solve monthly gross from annual CTC.
 *
 * CTC is NOT monotonic in gross: at the selected ESI wage ceiling employer ESI switches off, so
 * a paise more of gross gives a lower CTC. A CTC in that band can have two valid
 * grosses. A single bisection over the whole range silently returns a wrong answer
 * there, so each side of the ceiling is solved separately. Candidate salaries
 * use a self-consistent annual CTC basis for "% of CTC" components, while the
 * original target determines whether a branch is eligible before rounding.
 */
export function solveGrossFromCtc(annualCtc, ctx) {
  const ceiling = Math.floor(ctx.rates.esi.ceiling);
  const maxGross = Math.max(RUPEE, Math.ceil(annualCtc / 12 / RUPEE) * RUPEE);
  // Test the entered target against branch endpoints before salary rounding;
  // a small annual difference must never manufacture ESI eligibility.
  const needsStableBasis = usesCtc(ctx.components);
  const ok = (s) => !!s && s.in_range && s.gross === s.breakdown.gross
    && (!needsStableBasis || s.breakdown.ctc_basis === s.breakdown.annual_ctc)
    && s.breakdown.annual_ctc >= annualCtc && s.breakdown.annual_ctc - annualCtc <= s.rounding_limit;
  const side = (min, max, esi, eligible) => solveSide(annualCtc, min, max,
    (g) => ctcForGross(g, ctx, esi, undefined, { round_annual_up: true }),
    (g) => ctcForGross(g, ctx, esi, annualCtc), ctx.components.length, usesCtc(ctx.components), eligible);

  if (!ctx.esi_enabled) {
    const s = side(0, maxGross, false);
    return { gross: s.gross, breakdown: s.breakdown, rounding_limit: s.rounding_limit, ambiguous: false, alternative: null, approximate: !ok(s) };
  }

  // A selected ESI wage can be a percentage of gross, capped, based on CTC,
  // or the remainder. The discontinuity is where that wage crosses the
  // ceiling, which need not be at a ₹21,000 gross. Invert each forced cost
  // curve independently, then validate its wage instead of clipping gross.
  // Keep the existing endpoint checks when every monthly component counts,
  // including legacy structures: those endpoint checks prevent rounding from
  // granting coverage to a target beyond the eligible branch's raw cost.
  const allMonthlySelected = ctx.components.filter((c) => c.frequency === 'MONTHLY').every((c) => c.counts_as_esi_wages !== false);
  if (!allMonthlySelected) {
    const wageEligible = (s, applies) => {
      const within = s.breakdown.esi_wage <= ctx.rates.esi.ceiling;
      // Test the original CTC basis too. Normalizing an agreement upwards must
      // not turn an originally ineligible wage into an eligible one.
      const original = expandStructure(ctx.components, s.gross, annualCtc).esi_base <= ctx.rates.esi.ceiling;
      return applies ? within && original : !within;
    };
    const withEsi = side(0, maxGross, true, (s) => wageEligible(s, true));
    const withoutEsi = side(0, maxGross, false, (s) => wageEligible(s, false));
    const esiSide = withEsi && wageEligible(withEsi, true) && ok(withEsi) ? withEsi : null;
    const plainSide = withoutEsi && wageEligible(withoutEsi, false) && ok(withoutEsi) ? withoutEsi : null;
    if (esiSide && plainSide) {
      return { gross: esiSide.gross, breakdown: esiSide.breakdown, rounding_limit: esiSide.rounding_limit,
        ambiguous: true, alternative: { gross: plainSide.gross, breakdown: plainSide.breakdown, rounding_limit: plainSide.rounding_limit }, approximate: false };
    }
    const found = esiSide ?? plainSide;
    if (found) return { gross: found.gross, breakdown: found.breakdown, rounding_limit: found.rounding_limit, ambiguous: false, alternative: null, approximate: false };
    const candidates = [withEsi, withoutEsi].filter(Boolean);
    candidates.sort((a, b) => Math.abs(a.breakdown.annual_ctc - annualCtc) - Math.abs(b.breakdown.annual_ctc - annualCtc));
    const best = candidates[0] ?? { gross: 0, breakdown: ctcForGross(0, ctx, undefined, annualCtc) };
    return { gross: best.gross, breakdown: best.breakdown, rounding_limit: best.rounding_limit ?? 0, ambiguous: false, alternative: null, approximate: true };
  }

  // 1. [0, ceiling] with ESI applied
  const withEsi = side(0, Math.min(ceiling, maxGross), true);
  const esiSide = withEsi && withEsi.gross <= ctx.rates.esi.ceiling && ok(withEsi) ? { gross: withEsi.gross, breakdown: withEsi.breakdown, rounding_limit: withEsi.rounding_limit } : null;

  // 2. (ceiling, ctc/12] with ESI off
  const withoutEsi = maxGross > ceiling ? side(ceiling + 1, maxGross, false) : null;
  const plainSide = withoutEsi && withoutEsi.gross > ctx.rates.esi.ceiling && ok(withoutEsi) ? { gross: withoutEsi.gross, breakdown: withoutEsi.breakdown, rounding_limit: withoutEsi.rounding_limit } : null;

  if (esiSide && plainSide) {
    // Preview the eligible ESI option first. Both remain explicit choices when
    // saving the agreement; a preview default does not settle that decision.
    return { gross: esiSide.gross, breakdown: esiSide.breakdown, rounding_limit: esiSide.rounding_limit, ambiguous: true, alternative: plainSide, approximate: false };
  }
  const found = plainSide ?? esiSide;
  if (found) return { gross: found.gross, breakdown: found.breakdown, rounding_limit: found.rounding_limit, ambiguous: false, alternative: null, approximate: false };

  // No valid upward result in either branch: return an informational candidate
  // and flag it so saving cannot create an inconsistent agreement.
  const candidates = [withEsi, withoutEsi].filter(Boolean);
  candidates.sort((a, b) => Math.abs(a.breakdown.annual_ctc - annualCtc) - Math.abs(b.breakdown.annual_ctc - annualCtc));
  const best = candidates[0] ?? { gross: 0, breakdown: ctcForGross(0, ctx, undefined, annualCtc) };
  return { gross: best.gross, breakdown: best.breakdown, rounding_limit: best.rounding_limit ?? 0, ambiguous: false, alternative: null, approximate: true };
}
