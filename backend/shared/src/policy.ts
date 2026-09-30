import { z } from 'zod';
import type { PolicyKind } from './enums';

/**
 * Policy rule shapes, one per kind. `policy.rules` (jsonb) is validated against
 * the schema for its kind before insert.
 */

export const OT_BASES = ['BASIC', 'BASIC_HRA', 'GROSS'] as const;
export type OtBase = (typeof OT_BASES)[number];
export const OT_BASE_LABELS: Record<OtBase, string> = {
  BASIC: 'Basic',
  BASIC_HRA: 'Basic + HRA',
  GROSS: 'Gross',
};

export const attendanceRulesSchema = z
  .object({
    standard_min: z.number().int().min(60).max(24 * 60),
    half_day_min: z.number().int().min(0).max(24 * 60),
    grace_min: z.number().int().min(0).max(240),
  })
  .strict()
  .refine((r) => r.half_day_min <= r.standard_min, {
    message: 'Half-day threshold cannot exceed the standard day',
    path: ['half_day_min'],
  });
export type AttendanceRules = z.infer<typeof attendanceRulesSchema>;

export const overtimeRulesSchema = z
  .object({
    multiplier: z.number().min(1).max(5),
    base: z.enum(OT_BASES),
    /** null = use the pay group's calendar divisor */
    divisor: z.number().int().min(1).max(31).nullable(),
    hours_per_day: z.number().min(1).max(24),
    after_min: z.number().int().min(0).max(24 * 60),
    rounding_min: z.number().int().min(1).max(240),
    /** null = no cap */
    monthly_cap_min: z.number().int().min(0).nullable(),
  })
  .strict();
export type OvertimeRules = z.infer<typeof overtimeRulesSchema>;

export const offDayPayRulesSchema = z
  .object({
    paid: z.boolean(),
    sandwich: z.boolean(),
  })
  .strict();
export type OffDayPayRules = z.infer<typeof offDayPayRulesSchema>;

export const offDayWorkRuleSchema = z
  .object({
    mode: z.enum(['PAY', 'NONE']),
    /** Total rate for the day: 200 means the normal day plus one extra day. */
    rate_pct: z.number().min(100).max(500),
    base: z.enum(OT_BASES),
    min_minutes: z.number().int().min(0).max(24 * 60),
  })
  .strict();
export type OffDayWorkRule = z.infer<typeof offDayWorkRuleSchema>;

export const holidayWorkRulesSchema = z
  .object({
    holiday: offDayWorkRuleSchema,
    weekly_off: offDayWorkRuleSchema,
  })
  .strict();
export type HolidayWorkRules = z.infer<typeof holidayWorkRulesSchema>;

export const lateSlabSchema = z
  .object({
    from_min: z.number().int().min(1),
    /** null = and above */
    to_min: z.number().int().min(1).nullable(),
    deduct_days: z.number().min(0).max(1),
  })
  .strict();

export const latePenaltyRulesSchema = z
  .object({
    free_per_month: z.number().int().min(0).max(31),
    slabs: z.array(lateSlabSchema).min(1),
  })
  .strict()
  .superRefine((r, ctx) => {
    const sorted = [...r.slabs].sort((a, b) => a.from_min - b.from_min);
    for (let i = 0; i < sorted.length; i++) {
      const s = sorted[i];
      if (s.to_min !== null && s.to_min < s.from_min) {
        ctx.addIssue({ code: 'custom', message: `Slab starting at ${s.from_min} min ends before it starts`, path: ['slabs', i] });
      }
      if (i > 0) {
        const prev = sorted[i - 1];
        if (prev.to_min === null || prev.to_min >= s.from_min) {
          ctx.addIssue({ code: 'custom', message: 'Late slabs overlap', path: ['slabs', i] });
        }
      }
    }
  });
export type LatePenaltyRules = z.infer<typeof latePenaltyRulesSchema>;

export const leaveTypeSchema = z
  .object({
    code: z.string().min(1).max(10).regex(/^[A-Z_]+$/),
    name: z.string().min(1).max(60),
    annual_days: z.number().min(0).max(365),
    paid: z.boolean(),
    encashable: z.boolean(),
    accrues: z.boolean(),
  })
  .strict();
export type LeaveType = z.infer<typeof leaveTypeSchema>;

export const leaveRulesSchema = z
  .object({
    types: z.array(leaveTypeSchema).min(1),
  })
  .strict()
  .refine((r) => new Set(r.types.map((t) => t.code)).size === r.types.length, {
    message: 'Leave type codes must be unique',
  });
export type LeaveRules = z.infer<typeof leaveRulesSchema>;

export const policyRuleSchemas = {
  ATTENDANCE: attendanceRulesSchema,
  OVERTIME: overtimeRulesSchema,
  WEEKOFF_PAY: offDayPayRulesSchema,
  HOLIDAY_PAY: offDayPayRulesSchema,
  HOLIDAY_WORK: holidayWorkRulesSchema,
  LATE_PENALTY: latePenaltyRulesSchema,
  LEAVE: leaveRulesSchema,
} as const;

export interface PolicyRulesByKind {
  ATTENDANCE: AttendanceRules;
  OVERTIME: OvertimeRules;
  WEEKOFF_PAY: OffDayPayRules;
  HOLIDAY_PAY: OffDayPayRules;
  HOLIDAY_WORK: HolidayWorkRules;
  LATE_PENALTY: LatePenaltyRules;
  LEAVE: LeaveRules;
}

export function parsePolicyRules<K extends PolicyKind>(kind: K, rules: unknown): PolicyRulesByKind[K] {
  return policyRuleSchemas[kind].parse(rules) as PolicyRulesByKind[K];
}

/** Documented fallbacks the engine uses when a pay group has no policy of a kind on a date. */
export const DEFAULT_ATTENDANCE_RULES: AttendanceRules = { standard_min: 480, half_day_min: 240, grace_min: 0 };
export const DEFAULT_OFFDAY_PAY_RULES: OffDayPayRules = { paid: false, sandwich: false };

/** AJPWER's leave types. Paid leave (PL) is the one that accrues and is encashable. */
export const AJPWER_LEAVE_TYPES: LeaveType[] = [
  { code: 'CL', name: 'Casual leave', annual_days: 7, paid: true, encashable: false, accrues: false },
  { code: 'SL', name: 'Sick leave', annual_days: 7, paid: true, encashable: false, accrues: false },
  { code: 'PL', name: 'Paid leave', annual_days: 15, paid: true, encashable: true, accrues: true },
  { code: 'LOP', name: 'Loss of pay', annual_days: 0, paid: false, encashable: false, accrues: false },
];
