import { toMicroPct } from '@ajpwer/shared';

export function baseMonthly(base, s) {
  switch (base) {
    case 'BASIC':
      return s.basic;
    case 'BASIC_HRA':
      return s.basic + s.hra;
    case 'GROSS':
      return s.gross;
  }
}

/** round(base × Πnums ÷ Πdens) with every factor given in micro units (×1e6) where marked. */
function fraction(base, nums, dens) {
  let n = BigInt(base);
  for (const x of nums) n *= x;
  let d = 1n;
  for (const x of dens) d *= x;
  const q = n / d;
  const r = n % d;
  return Number(r * 2n >= d ? q + 1n : q);
}

/**
 * hourly = base_monthly ÷ (divisor × hours_per_day)
 * amount = ot_min ÷ 60 × hourly × multiplier
 * Minutes above the monthly cap are unpaid and reported, not hidden.
 */
export function overtimePay(otMin, rules, s, groupDivisor) {
  const divisor = rules.divisor ?? groupDivisor;
  const base_monthly = baseMonthly(rules.base, s);
  const paid_min = rules.monthly_cap_min !== null ? Math.min(otMin, rules.monthly_cap_min) : otMin;
  const excess_min = otMin - paid_min;
  const hpd = toMicroPct(rules.hours_per_day);
  const mult = toMicroPct(rules.multiplier);
  const hourly = fraction(base_monthly, [1_000_000n], [BigInt(divisor), hpd]);
  const amount = fraction(base_monthly, [BigInt(paid_min), mult, 1_000_000n], [BigInt(divisor), hpd, 60n, 1_000_000n]);
  return { hourly, paid_min, excess_min, amount, base_monthly, divisor, multiplier: rules.multiplier };
}

/**
 * Off-day work. A paid holiday or weekly off is already inside the monthly
 * salary, so the line pays the difference up to the rate: base ÷ divisor × (rate − 1).
 * If the off day carried no pay, the full rate is paid instead.
 */
export function offDayExtra(ratePct, dayPaid, baseMonthlyAmt, divisor) {
  const effectivePct = dayPaid ? ratePct - 100 : ratePct;
  if (effectivePct <= 0) return 0;
  return fraction(baseMonthlyAmt, [toMicroPct(effectivePct)], [BigInt(divisor), 100_000_000n]);
}

/** "200% — normal day plus one extra day". A bare 2× is what produces the Sunday overpayment. */
export function describeRate(ratePct) {
  const extra = (ratePct - 100) / 100;
  const extraText = extra === 1 ? 'one extra day' : extra === 2 ? 'two extra days' : `${extra} extra days`;
  return `${ratePct}% — normal day plus ${extraText}`;
}
