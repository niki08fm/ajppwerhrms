import { clampMin0, pct, type CalcType, type Frequency, type Paise } from '@ajpwer/shared';

export interface ComponentDef {
  id?: string;
  seq: number;
  name: string;
  calc_type: CalcType;
  /** Percentage for PCT_GROSS / PCT_BASIC, paise for FIXED, ignored for BALANCE */
  calc_value: number;
  frequency: Frequency;
  pay_month: number | null;
  is_taxable: boolean;
  counts_as_wages: boolean;
  colour?: string;
}

export interface ExpandedComponent extends ComponentDef {
  amount: Paise;
}

export interface ExpandedStructure {
  /** Monthly components in seq order, with amounts at the given gross */
  monthly: ExpandedComponent[];
  /** Yearly components — part of CTC, paid in their pay_month, not in monthly gross */
  yearly: ExpandedComponent[];
  gross: Paise;
  basic: Paise;
  hra: Paise;
  /** Sum of components ticked counts_as_wages (the PF base at full pay) */
  pf_base: Paise;
  yearly_total: Paise;
  over_budget: boolean;
  /** The shortfall when fixed and percentage components exceed gross */
  over_budget_by: Paise;
}

export function isBasic(c: { name: string }): boolean {
  return c.name.trim().toLowerCase() === 'basic';
}

export function isHra(c: { name: string }): boolean {
  const n = c.name.trim().toLowerCase();
  return n === 'hra' || n.includes('house rent') || /\bhra\b/.test(n);
}

/** The basic component — the one named Basic, or the first if none is named so. */
export function findBasic<T extends { name: string; seq: number; frequency: Frequency }>(components: T[]): T | undefined {
  const monthly = components.filter((c) => c.frequency === 'MONTHLY').sort((a, b) => a.seq - b.seq);
  return monthly.find(isBasic) ?? monthly[0];
}

function componentAmount(c: ComponentDef, gross: Paise, basic: Paise): Paise {
  switch (c.calc_type) {
    case 'PCT_GROSS':
      return pct(gross, c.calc_value);
    case 'PCT_BASIC':
      return pct(basic, c.calc_value);
    case 'FIXED':
      return Math.round(c.calc_value);
    case 'BALANCE':
      return 0;
  }
}

/**
 * Expand a salary structure at a monthly gross, in the order the spec sets:
 * basic first, then every other non-balance component, then the balance takes
 * gross − Σ(monthly non-balance), floored at zero. Never a negative component.
 */
export function expandStructure(components: ComponentDef[], gross: Paise): ExpandedStructure {
  const sorted = [...components].sort((a, b) => a.seq - b.seq);
  const basicDef = findBasic(sorted);

  let basic = 0;
  if (basicDef) {
    if (basicDef.calc_type === 'PCT_GROSS') basic = pct(gross, basicDef.calc_value);
    else if (basicDef.calc_type === 'FIXED') basic = Math.round(basicDef.calc_value);
    else if (basicDef.calc_type === 'PCT_BASIC') basic = 0; // meaningless; flagged by validation
  }

  const monthly: ExpandedComponent[] = [];
  const yearly: ExpandedComponent[] = [];
  let nonBalance = 0;
  let balanceDef: ComponentDef | undefined;

  for (const c of sorted) {
    if (c.frequency === 'YEARLY') {
      yearly.push({ ...c, amount: c.calc_type === 'BALANCE' ? 0 : componentAmount(c, gross, basic) });
      continue;
    }
    if (c.calc_type === 'BALANCE') {
      if (!balanceDef) balanceDef = c;
      monthly.push({ ...c, amount: 0 });
      continue;
    }
    const amount = c === basicDef && basicDef.calc_type !== 'BALANCE' ? basic : componentAmount(c, gross, basic);
    nonBalance += amount;
    monthly.push({ ...c, amount });
  }

  const remainder = gross - nonBalance;
  const over_budget = remainder < 0;
  if (balanceDef) {
    const bal = clampMin0(remainder);
    const line = monthly.find((m) => m === balanceDef || (m.seq === balanceDef!.seq && m.name === balanceDef!.name));
    if (line) line.amount = bal;
    if (basicDef && basicDef.calc_type === 'BALANCE') basic = bal;
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

export interface StructureValidation {
  errors: string[];
  warnings: string[];
}

/** The builder's inline validation rules. */
export function validateStructure(components: ComponentDef[], sampleGross: Paise): StructureValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const monthly = components.filter((c) => c.frequency === 'MONTHLY');
  if (!components.some(isBasic)) errors.push('No component is named Basic. PF and HRA both need one.');
  const balances = monthly.filter((c) => c.calc_type === 'BALANCE');
  if (balances.length > 1) errors.push('More than one balance component. Only one can take the remainder.');
  if (balances.length === 0) warnings.push('No balance component. Gross will not add up exactly at every salary.');
  if (components.some((c) => c.frequency === 'YEARLY' && !c.pay_month)) errors.push('Every yearly component needs a payout month.');
  if (components.some((c) => c.frequency === 'YEARLY' && c.calc_type === 'BALANCE')) errors.push('A yearly component cannot be the balance.');
  const basic = findBasic(components);
  if (basic && basic.calc_type === 'PCT_BASIC') errors.push('Basic cannot be a percentage of itself.');
  const names = components.map((c) => c.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) errors.push('Two components share a name.');
  const e = expandStructure(components, sampleGross);
  if (e.over_budget) {
    warnings.push(
      `Fixed and percentage components exceed the sample gross by ₹${Math.round(e.over_budget_by / 100).toLocaleString('en-IN')}. The balance is zero.`,
    );
  }
  return { errors, warnings };
}
