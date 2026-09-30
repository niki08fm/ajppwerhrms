import { clampMin0, isPercentCalc, pct, pctOfTwelfth } from '@ajpwer/shared';

export function isBasic(c) {
  return c.name.trim().toLowerCase() === 'basic';
}

export function isHra(c) {
  const n = c.name.trim().toLowerCase();
  return n === 'hra' || n.includes('house rent') || /\bhra\b/.test(n);
}

/** The basic component — the one named Basic, or the first if none is named so. */
export function findBasic(components) {
  const monthly = components.filter((c) => c.frequency === 'MONTHLY').sort((a, b) => a.seq - b.seq);
  return monthly.find(isBasic) ?? monthly[0];
}

/** True when some component is a percentage of CTC, so expanding needs the annual CTC. */
export function usesCtc(components) {
  return components.some((c) => c.calc_type === 'PCT_CTC');
}

/** One component's full monthly (or yearly-payout) amount, after its maximum. */
function componentAmount(c, gross, basic, annualCtc) {
  let amount;
  switch (c.calc_type) {
    case 'PCT_GROSS':
      amount = pct(gross, c.calc_value);
      break;
    case 'PCT_CTC':
      amount = pctOfTwelfth(annualCtc, c.calc_value);
      break;
    case 'PCT_BASIC':
      amount = pct(basic, c.calc_value);
      break;
    case 'FIXED':
      return Math.round(c.calc_value);
    case 'BALANCE':
      return 0;
  }
  return c.max_amount != null && isPercentCalc(c.calc_type) ? Math.min(amount, c.max_amount) : amount;
}

/**
 * Expand a salary structure at a monthly gross, in the order the spec sets:
 * basic first, then every other component, then the Special Allowance takes
 * gross − Σ(monthly others), floored at zero. Never a negative component.
 *
 * Percentages are of the monthly gross, the monthly basic, or a twelfth of the
 * annual CTC; a maximum caps a percentage and the excess falls to the Special
 * Allowance. `annualCtc` is required when any component is a percentage of CTC.
 */
export function expandStructure(components, gross, annualCtc) {
  if (annualCtc === undefined && usesCtc(components)) {
    throw new Error('expandStructure: a component is a percentage of CTC, so the annual CTC is needed.');
  }
  const ctc = annualCtc ?? 0;
  const sorted = [...components].sort((a, b) => a.seq - b.seq);
  const basicDef = findBasic(sorted);

  // Basic cannot be a percentage of itself (validation blocks it); it counts as zero if it is.
  let basic = basicDef && basicDef.calc_type !== 'PCT_BASIC' ? componentAmount(basicDef, gross, 0, ctc) : 0;

  const monthly = [];
  const yearly = [];
  let nonBalance = 0;
  let balanceDef;

  for (const c of sorted) {
    if (c.frequency === 'YEARLY') {
      yearly.push({ ...c, amount: componentAmount(c, gross, basic, ctc) });
      continue;
    }
    if (c.calc_type === 'BALANCE') {
      if (!balanceDef) balanceDef = c;
      monthly.push({ ...c, amount: 0 });
      continue;
    }
    const amount = c === basicDef ? basic : componentAmount(c, gross, basic, ctc);
    nonBalance += amount;
    monthly.push({ ...c, amount });
  }

  const remainder = gross - nonBalance;
  const over_budget = remainder < 0;
  if (balanceDef) {
    const bal = clampMin0(remainder);
    const line = monthly.find((m) => m.seq === balanceDef.seq && m.name === balanceDef.name);
    if (line) line.amount = bal;
    if (basicDef === balanceDef) basic = bal;
  }

  const monthlyGross = monthly.reduce((s, m) => s + m.amount, 0);
  const hra = monthly.filter(isHra).reduce((s, m) => s + m.amount, 0);
  const pf_base = monthly.filter((m) => m.counts_as_wages).reduce((s, m) => s + m.amount, 0);

  return {
    monthly,
    yearly,
    gross: monthlyGross,
    basic,
    hra,
    pf_base,
    yearly_total: yearly.reduce((s, y) => s + y.amount, 0),
    over_budget,
    over_budget_by: over_budget ? -remainder : 0,
  };
}

/** The builder's inline validation rules. `sampleCtc` is the annual CTC at the sample gross. */
export function validateStructure(components, sampleGross, sampleCtc) {
  const errors = [];
  const warnings = [];
  const monthly = components.filter((c) => c.frequency === 'MONTHLY');
  if (!components.some(isBasic)) errors.push('No component is named Basic. PF and HRA both need one.');
  const balances = monthly.filter((c) => c.calc_type === 'BALANCE');
  if (balances.length > 1) errors.push('More than one Special Allowance. Only one can take what is left of gross.');
  if (balances.length === 0) warnings.push('No Special Allowance. Gross will not add up exactly at every salary.');
  if (components.some((c) => c.frequency === 'YEARLY' && !c.pay_month)) errors.push('Every yearly component needs a payout month.');
  if (components.some((c) => c.frequency === 'YEARLY' && c.calc_type === 'BALANCE')) errors.push('The Special Allowance is monthly; it cannot be yearly.');
  const basic = findBasic(components);
  if (basic && basic.calc_type === 'PCT_BASIC') errors.push('Basic cannot be a percentage of itself. Make it a percentage of gross or CTC, or a fixed amount.');
  if (components.some((c) => c.max_amount != null && !isPercentCalc(c.calc_type))) errors.push('A maximum only applies to a percentage component.');
  if (components.some((c) => isPercentCalc(c.calc_type) && c.calc_value > 100)) errors.push('A percentage cannot be more than 100.');
  const names = components.map((c) => c.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) errors.push('Two components share a name.');
  if (errors.length) return { errors, warnings };
  if (usesCtc(components) && sampleCtc === undefined) return { errors, warnings };
  const e = expandStructure(components, sampleGross, sampleCtc);
  if (e.over_budget) {
    warnings.push(`The components add up to more than the sample gross by ₹${Math.round(e.over_budget_by / 100).toLocaleString('en-IN')}, so the Special Allowance is zero.`);
  }
  return { errors, warnings };
}
