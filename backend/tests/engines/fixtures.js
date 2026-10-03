import { AJPWER_LEAVE_TYPES, SEED_PT_SLABS, SEED_TAX_REGIMES, STATUTORY_GRATUITY_RULES, STATUTORY_MINIMUM_RATES, istMidnight } from '@ajpwer/shared';

export const R = (rupees) => Math.round(rupees * 100);

export const RATES = STATUTORY_MINIMUM_RATES;
export const PT_SLABS = SEED_PT_SLABS;
export const NEW_REGIME = SEED_TAX_REGIMES.find((r) => r.code === 'NEW');
export const OLD_REGIME = SEED_TAX_REGIMES.find((r) => r.code === 'OLD');
export const NO_DECL = { decl_80c: 0, decl_80d: 0, decl_rent_monthly: 0, decl_metro: false };

/** Basic 50% of gross (PF base), HRA 40% of basic, conveyance ₹1,600 fixed, the Special Allowance takes the balance. */
export const STANDARD_STRUCTURE = [
  { seq: 1, name: 'Basic', calc_type: 'PCT_GROSS', calc_value: 50, frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: true },
  { seq: 2, name: 'HRA', calc_type: 'PCT_BASIC', calc_value: 40, frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: false },
  { seq: 3, name: 'Conveyance', calc_type: 'FIXED', calc_value: R(1600), frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: false },
  { seq: 4, name: 'Special Allowance', calc_type: 'BALANCE', calc_value: 0, frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: false },
];

export const PF_ON = { pf_enabled: true, pf_restrict_to_ceiling: true, vpf_pct: 0 };

let seq = 0;
export function policy(kind, rules, valid_from = '2020-01-01', valid_to = null, version = 1) {
  seq++;
  return { id: `pol-${seq}`, policy_key: `${kind}-key`, kind, name: `${kind} v${version}`, version, valid_from, valid_to, rules };
}

export const ATTENDANCE = policy('ATTENDANCE', { standard_min: 480, half_day_min: 240, grace_min: 15 });
export const OVERTIME = policy('OVERTIME', {
  multiplier: 2,
  base: 'BASIC_HRA',
  divisor: null,
  hours_per_day: 8,
  after_min: 30,
  rounding_min: 30,
  monthly_cap_min: 50 * 60,
});
export const WEEKOFF_PAID = policy('WEEKOFF_PAY', { paid: true, sandwich: false });
export const WEEKOFF_SANDWICH = policy('WEEKOFF_PAY', { paid: true, sandwich: true });
export const HOLIDAY_PAID = policy('HOLIDAY_PAY', { paid: true, sandwich: false });
export const HOLIDAY_WORK = policy('HOLIDAY_WORK', {
  holiday: { mode: 'PAY', rate_pct: 200, base: 'GROSS', min_minutes: 240 },
  weekly_off: { mode: 'PAY', rate_pct: 200, base: 'GROSS', min_minutes: 240 },
});
export const LEAVE = policy('LEAVE', { types: AJPWER_LEAVE_TYPES });

/** AJPWER's own rules: a 9-hour day, 15 minutes' grace, up to 4 hours a half day, overtime from shift end. */
export const NINE_HOUR_DAY = policy('ATTENDANCE', { standard_min: 540, half_day_min: 0, half_day_upto_min: 240, grace_min: 15 });
export const OVERTIME_FROM_SHIFT_END = policy('OVERTIME', { ...OVERTIME.rules, after_min: 0, rounding_min: 1, counts_from: 'SHIFT_END' });
export const GRATUITY_RULES = STATUTORY_GRATUITY_RULES;

export const SHIFT_START = 9 * 60;
/** The general shift, 09:00–18:00 with an hour's break. */
export const SHIFT_END = 18 * 60;
export const SHIFT_BREAK = 60;

let pid = 0;
/** A punch at IST hh:mm on a date. */
export function punch(date, hhmm, direction, site = 'site-A', workDate = date) {
  const [h, m] = hhmm.split(':').map(Number);
  pid++;
  return {
    id: `p${String(pid).padStart(6, '0')}`,
    at: istMidnight(date).getTime() + (h * 60 + m) * 60_000,
    work_date: workDate,
    direction,
    site_id: site,
    method: 'FACE',
  };
}

/** A full-day punch pair 09:00–17:30 (510 min). */
export function fullDay(date, site = 'site-A') {
  return [punch(date, '09:00', 'IN', site), punch(date, '17:30', 'OUT', site)];
}

export function fullMonthTotals(ym, dim, overrides = {}) {
  return {
    days_in_month: dim,
    days_in_employment: dim,
    present: dim,
    half_day: 0,
    absent: 0,
    short: 0,
    missing_punch: 0,
    leave_paid: 0,
    leave_unpaid: 0,
    weekly_off: 0,
    holidays: 0,
    off_days_worked: 0,
    late_days: 0,
    early_out_days: 0,
    ot_min: 0,
    worked_min: 0,
    day_value_sum: dim,
    paid_days: dim,
    lop_days: 0,
    lop_in_window: 0,
    partial: false,
    sandwiched: [],
    overridden_days: 0,
    ...overrides,
  };
}

export function payslipInput(overrides = {}) {
  return {
    ym: '2026-09',
    employee: { id: 'e1', gender: 'MALE' },
    monthly_gross: R(24000),
    annual_ctc: 0,
    components: STANDARD_STRUCTURE,
    attendance: fullMonthTotals('2026-09', 30),
    offday_work: [],
    divisor: 26,
    overtime_rules: null,
    statutory: { ...PF_ON, esi_applicable: false, pt_applicable: true, pt_state: 'Andhra Pradesh' },
    rates: { pf: RATES.pf, esi: RATES.esi, recovery_cap_pct: 40 },
    pt_slabs: PT_SLABS,
    tax: { regime: NEW_REGIME, declarations: NO_DECL, months_in_fy: 12 },
    adhoc: [],
    recoveries: [],
    ...overrides,
  };
}
