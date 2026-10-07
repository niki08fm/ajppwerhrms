import { z } from 'zod';

/**
 * Policy rule shapes, one per kind. `policy.rules` (jsonb) is validated against
 * the schema for its kind before insert.
 */

export const OT_BASES = ['BASIC', 'BASIC_HRA', 'GROSS'];
export const OT_BASE_LABELS = {
  BASIC: 'Basic',
  BASIC_HRA: 'Basic + HRA',
  GROSS: 'Gross',
};

/** Overtime also supports any selected combination without changing other wage-base rules. */
export const OT_POLICY_BASES = [...OT_BASES, 'COMPONENTS'];
export const OT_COMPONENTS = ['basic', 'hra', 'da'];
export const OT_COMPONENT_LABELS = { basic: 'Basic', hra: 'HRA', da: 'DA' };

/** Existing policy versions keep their original meaning when opened in the component picker. */
export function overtimeComponentKeys(rules) {
  if (rules.base === 'BASIC') return ['basic'];
  if (rules.base === 'BASIC_HRA') return ['basic', 'hra'];
  return rules.base === 'COMPONENTS' ? rules.components ?? [] : [];
}

export function describeOvertimeBase(rules) {
  return rules.base === 'GROSS' ? 'Gross' : overtimeComponentKeys(rules).map((key) => OT_COMPONENT_LABELS[key]).join(' + ') || 'Select salary components';
}

/** Full monthly amounts in paise; a structure without DA contributes zero DA. */
export function overtimeBaseMonthly(rules, salary) {
  if (rules.base === 'GROSS') return salary.gross;
  return [...new Set(overtimeComponentKeys(rules))].reduce((sum, key) => sum + (salary[key] ?? 0), 0);
}

/** Where overtime starts counting. */
export const OT_COUNTS_FROM = ['STANDARD_DAY', 'SHIFT_END'];
export const OT_COUNTS_FROM_LABELS = {
  STANDARD_DAY: 'After the standard day is worked',
  SHIFT_END: 'From shift end (late arrivals: once the standard day is done)',
};

export const attendanceRulesSchema = z
  .object({
    standard_min: z
      .number()
      .int()
      .min(60)
      .max(24 * 60),
    half_day_min: z
      .number()
      .int()
      .min(0)
      .max(24 * 60),
    /**
     * Up to this many minutes worked is a half day; more is a full day. Null keeps the
     * earlier rule, where a full day needs 92% of the standard day.
     */
    half_day_upto_min: z
      .number()
      .int()
      .min(0)
      .max(24 * 60)
      .nullable()
      .default(null),
    grace_min: z.number().int().min(0).max(240),
  })
  .strict()
  .refine((r) => r.half_day_min <= r.standard_min, {
    message: 'Half-day threshold cannot exceed the standard day',
    path: ['half_day_min'],
  })
  .refine((r) => r.half_day_upto_min === null || (r.half_day_upto_min >= r.half_day_min && r.half_day_upto_min < r.standard_min), {
    message: 'A half day must end below the standard day, and not before it starts',
    path: ['half_day_upto_min'],
  });

export const overtimeRulesSchema = z
  .object({
    multiplier: z.number().min(1).max(5),
    base: z.enum(OT_POLICY_BASES),
    components: z.array(z.enum(OT_COMPONENTS)).max(OT_COMPONENTS.length).optional(),
    /** null = use the pay group's calendar divisor */
    divisor: z.number().int().min(1).max(31).nullable(),
    hours_per_day: z.number().min(1).max(24),
    after_min: z
      .number()
      .int()
      .min(0)
      .max(24 * 60),
    rounding_min: z.number().int().min(1).max(240),
    /** null = no cap */
    monthly_cap_min: z.number().int().min(0).nullable(),
    /**
     * STANDARD_DAY: minutes worked beyond the standard day. SHIFT_END: minutes worked after
     * the shift ends — after a late arrival, once the standard day is done from arrival.
     */
    counts_from: z.enum(OT_COUNTS_FROM).default('STANDARD_DAY'),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.base === 'COMPONENTS' && !r.components?.length) {
      ctx.addIssue({ code: 'custom', path: ['components'], message: 'Select at least one salary component for overtime' });
    }
    if (r.components && new Set(r.components).size !== r.components.length) {
      ctx.addIssue({ code: 'custom', path: ['components'], message: 'Select each salary component only once' });
    }
    if (r.base !== 'COMPONENTS' && r.components !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['components'], message: 'Salary components apply only to a component-based overtime rule' });
    }
  });

export const offDayPayRulesSchema = z
  .object({
    paid: z.boolean(),
    sandwich: z.boolean(),
  })
  .strict();

export const offDayWorkRuleSchema = z
  .object({
    mode: z.enum(['PAY', 'NONE']),
    /** Total rate for the day: 200 means the normal day plus one extra day. */
    rate_pct: z.number().min(100).max(500),
    base: z.enum(OT_BASES),
    min_minutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60),
  })
  .strict();

export const holidayWorkRulesSchema = z
  .object({
    holiday: offDayWorkRuleSchema,
    weekly_off: offDayWorkRuleSchema,
  })
  .strict();

/** How the part of a year beyond completed years counts. */
export const GRATUITY_PART_YEARS = ['OVER_SIX_MONTHS', 'COMPLETED_YEARS', 'PRO_RATA'];
export const GRATUITY_PART_YEAR_LABELS = {
  OVER_SIX_MONTHS: 'Over six months counts as a full year',
  COMPLETED_YEARS: 'Completed years only',
  PRO_RATA: 'Part years pro rata',
};

export const gratuityRulesSchema = z
  .object({
    /** Years of service needed to qualify */
    min_years: z.number().min(0).max(40),
    /** Service from this up to min_years raises a warning at settlement instead of silently paying nothing */
    flag_from_years: z.number().min(0).max(40),
    /** Days of wages for each year of service */
    days_per_year: z.number().min(0).max(365),
    /** A month's wages ÷ this is one day's wages */
    divisor: z.number().int().min(1).max(31),
    /** Which of the last month's wages it is worked out on */
    base: z.enum(OT_BASES),
    part_year: z.enum(GRATUITY_PART_YEARS),
    /** Paise; null = no ceiling */
    max_amount: z.number().int().min(0).nullable(),
  })
  .strict()
  .refine((r) => r.flag_from_years <= r.min_years, {
    message: 'The warning cannot start after the qualifying service',
    path: ['flag_from_years'],
  });

/** The Payment of Gratuity Act's figures: 15 days' basic per year over 26, from five years, up to ₹20 lakh. */
export const STATUTORY_GRATUITY_RULES = {
  min_years: 5,
  flag_from_years: 4.5,
  days_per_year: 15,
  divisor: 26,
  base: 'BASIC',
  part_year: 'OVER_SIX_MONTHS',
  max_amount: 20_00_000_00,
};

/** How a leave type's days come. */
export const LEAVE_ALLOWANCES = ['MONTHLY', 'YEARLY', 'PER_OCCASION', 'NONE'];
export const LEAVE_ALLOWANCE_LABELS = {
  MONTHLY: 'Earned every month',
  YEARLY: 'Given at the start of the leave year',
  PER_OCCASION: 'A set number each time',
  NONE: 'No balance',
};
/** What happens to days left at the end of the leave year. */
export const LEAVE_YEAR_END = ['LAPSE', 'CARRY_FORWARD', 'ENCASH'];
export const LEAVE_YEAR_END_LABELS = {
  LAPSE: 'Lapse',
  CARRY_FORWARD: 'Carry forward',
  ENCASH: "Paid out in the year's last payroll",
};
/** What happens to days left when someone leaves. */
export const LEAVE_ON_EXIT = ['ENCASH', 'LAPSE'];
export const LEAVE_ON_EXIT_LABELS = { ENCASH: 'Paid in the settlement', LAPSE: 'Lapse' };
export const LEAVE_GENDERS = ['ALL', 'FEMALE', 'MALE'];
export const LEAVE_GENDER_LABELS = { ALL: 'Everyone', FEMALE: 'Women', MALE: 'Men' };

const leaveDays = z.number().min(0).max(366);

/** Every setting of a leave type, with the values a new type starts from. */
export const LEAVE_TYPE_DEFAULTS = {
  active: true,
  paid: true,
  auto_apply: false,
  allowance: 'YEARLY',
  per_month: null,
  yearly_cap: null,
  per_year: null,
  per_occasion: null,
  monthly_max: null,
  min_service_months: 0,
  gender: 'ALL',
  year_end: 'LAPSE',
  carry_max: null,
  carry_excess: 'LAPSE',
  on_exit: 'LAPSE',
  encash_base: 'GROSS',
  encash_divisor: 26,
};

/** Leave types written before the full leave rules had annual_days, paid, encashable and accrues. */
function fromFirstLeaveRules(t) {
  if (!t || typeof t !== 'object' || 'allowance' in t || !('annual_days' in t)) return t;
  const { annual_days, encashable, accrues, ...rest } = t;
  const allowance = !t.paid ? 'NONE' : annual_days === 0 ? 'NONE' : accrues ? 'MONTHLY' : 'YEARLY';
  return {
    ...rest,
    allowance,
    per_month: allowance === 'MONTHLY' ? annual_days / 12 : null,
    yearly_cap: allowance === 'MONTHLY' ? annual_days : null,
    per_year: allowance === 'YEARLY' ? annual_days : null,
    on_exit: encashable ? 'ENCASH' : 'LAPSE',
  };
}

export const leaveTypeSchema = z.preprocess(
  fromFirstLeaveRules,
  z
    .object({
      code: z
        .string()
        .min(1)
        .max(10)
        .regex(/^[A-Z_]+$/),
      name: z.string().min(1).max(60),
      /** Inactive types cannot be recorded; leave already recorded still counts. */
      active: z.boolean().default(true),
      paid: z.boolean(),
      /** Absences nobody applied for, and the missing half of half days, are paid from this type. */
      auto_apply: z.boolean().default(false),
      allowance: z.enum(LEAVE_ALLOWANCES),
      /** MONTHLY: days earned each month (part of it in a part month) */
      per_month: leaveDays.nullable().default(null),
      /** MONTHLY: the most earned in one leave year; null = no cap */
      yearly_cap: leaveDays.nullable().default(null),
      /** YEARLY: days given when the leave year starts (part of them for someone who joins during it) */
      per_year: leaveDays.nullable().default(null),
      /** PER_OCCASION: working days paid each time it is taken */
      per_occasion: leaveDays.nullable().default(null),
      /** The most days of this type paid in one month; null = no limit */
      monthly_max: leaveDays.nullable().default(null),
      /** Usable once this many months of service are complete */
      min_service_months: z.number().int().min(0).max(120).default(0),
      gender: z.enum(LEAVE_GENDERS).default('ALL'),
      year_end: z.enum(LEAVE_YEAR_END).default('LAPSE'),
      /** CARRY_FORWARD: the most days carried; null = all of them */
      carry_max: leaveDays.nullable().default(null),
      /** CARRY_FORWARD: what happens to days above carry_max */
      carry_excess: z.enum(['LAPSE', 'ENCASH']).default('LAPSE'),
      on_exit: z.enum(LEAVE_ON_EXIT).default('LAPSE'),
      /** A day's pay when leave is paid out: this part of the monthly salary ÷ encash_divisor */
      encash_base: z.enum(OT_BASES).default('GROSS'),
      encash_divisor: z.number().int().min(1).max(31).default(26),
    })
    .strict()
    .superRefine((t, ctx) => {
      const need = { MONTHLY: 'per_month', YEARLY: 'per_year', PER_OCCASION: 'per_occasion' }[t.allowance];
      if (need && t[need] === null) ctx.addIssue({ code: 'custom', message: `${t.code}: set how many days it gives`, path: [need] });
      if (!t.paid && t.allowance !== 'NONE') ctx.addIssue({ code: 'custom', message: `${t.code}: unpaid leave has no balance`, path: ['allowance'] });
      if (t.auto_apply && (!t.paid || (t.allowance !== 'MONTHLY' && t.allowance !== 'YEARLY'))) {
        ctx.addIssue({ code: 'custom', message: `${t.code}: only paid leave with a balance can pay absences automatically`, path: ['auto_apply'] });
      }
    }),
);

/** Leave rules as stored (either shape) with every setting filled in, for a form to edit. */
export function upgradeLeaveRules(rules) {
  return {
    year_start_month: rules?.year_start_month ?? 1,
    types: (rules?.types ?? []).map((t) => ({ ...LEAVE_TYPE_DEFAULTS, ...fromFirstLeaveRules(t) })),
  };
}

export const leaveRulesSchema = z
  .object({
    /** The month the leave year starts: 4 runs April to March. */
    year_start_month: z.number().int().min(1).max(12).default(1),
    types: z.array(leaveTypeSchema).min(1),
  })
  .strict()
  .refine((r) => new Set(r.types.map((t) => t.code)).size === r.types.length, {
    message: 'Leave type codes must be unique',
  })
  .refine((r) => r.types.filter((t) => t.auto_apply).length <= 1, {
    message: 'Only one leave type can pay absences automatically',
  });

export const policyRuleSchemas = {
  ATTENDANCE: attendanceRulesSchema,
  OVERTIME: overtimeRulesSchema,
  WEEKOFF_PAY: offDayPayRulesSchema,
  HOLIDAY_PAY: offDayPayRulesSchema,
  HOLIDAY_WORK: holidayWorkRulesSchema,
  LEAVE: leaveRulesSchema,
  GRATUITY: gratuityRulesSchema,
};

export function parsePolicyRules(kind, rules) {
  return policyRuleSchemas[kind].parse(rules);
}

/** Documented fallbacks the engine uses when a pay group has no policy of a kind on a date. */
export const DEFAULT_ATTENDANCE_RULES = { standard_min: 480, half_day_min: 240, half_day_upto_min: null, grace_min: 0 };
export const DEFAULT_OFFDAY_PAY_RULES = { paid: false, sandwich: false };

const leaveType = (t) => ({ ...LEAVE_TYPE_DEFAULTS, ...t });

/**
 * Starting points for a new leave type. Paid leave pays absences automatically; the
 * others are recorded by HR on the person's behalf.
 */
export const LEAVE_TEMPLATES = [
  leaveType({
    code: 'PL',
    name: 'Paid leave',
    auto_apply: true,
    allowance: 'MONTHLY',
    per_month: 1.25,
    yearly_cap: 15,
    year_end: 'CARRY_FORWARD',
    carry_max: 30,
    carry_excess: 'ENCASH',
    on_exit: 'ENCASH',
  }),
  leaveType({ code: 'CL', name: 'Casual leave', allowance: 'YEARLY', per_year: 7 }),
  leaveType({ code: 'SL', name: 'Sick leave', allowance: 'YEARLY', per_year: 7 }),
  leaveType({ code: 'ML', name: 'Maternity leave', allowance: 'PER_OCCASION', per_occasion: 156, gender: 'FEMALE' }),
  leaveType({ code: 'PAT', name: 'Paternity leave', allowance: 'PER_OCCASION', per_occasion: 5, gender: 'MALE' }),
  leaveType({ code: 'BRV', name: 'Bereavement leave', allowance: 'PER_OCCASION', per_occasion: 3 }),
  leaveType({ code: 'MAR', name: 'Marriage leave', allowance: 'PER_OCCASION', per_occasion: 3 }),
  leaveType({ code: 'LOP', name: 'Unpaid leave', paid: false, allowance: 'NONE' }),
];

const template = (code) => LEAVE_TEMPLATES.find((t) => t.code === code);

/** AJPWER's leave types: paid leave for every absence (at most three days a month), and the kinds HR records. */
export const AJPWER_LEAVE_TYPES = [{ ...template('PL'), monthly_max: 3 }, template('SL'), template('ML'), template('PAT'), template('BRV'), template('LOP')];

/** AJPWER's leave year runs April to March. */
export const AJPWER_LEAVE_RULES = { year_start_month: 4, types: AJPWER_LEAVE_TYPES };
