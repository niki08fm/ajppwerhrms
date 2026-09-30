import type {
  AttendanceRules,
  DayStatus,
  HolidayWorkRules,
  ISODate,
  LatePenaltyRules,
  OffDayPayRules,
  OvertimeRules,
  PolicyKind,
  PolicyRulesByKind,
  PunchDirection,
  PunchMethod,
} from '@ajpwer/shared';

export interface EnginePunch {
  id: string;
  /** Epoch milliseconds (server time) */
  at: number;
  work_date: ISODate;
  direction: PunchDirection;
  site_id: string;
  method: PunchMethod;
}

export interface PunchPair {
  in: EnginePunch;
  out: EnginePunch | null;
  minutes: number;
  /** Site of the IN punch — the one the interval is attributed to */
  site_id: string;
}

export interface AttachedPolicy<K extends PolicyKind = PolicyKind> {
  id: string;
  policy_key: string;
  kind: K;
  name: string;
  version: number;
  valid_from: ISODate;
  valid_to: ISODate | null;
  rules: PolicyRulesByKind[K];
}

export interface ResolvedPolicies {
  attendance: AttendanceRules;
  attendance_defaulted: boolean;
  overtime: OvertimeRules | null;
  weekoff_pay: OffDayPayRules | null;
  holiday_pay: OffDayPayRules | null;
  holiday_work: HolidayWorkRules | null;
  late_penalty: LatePenaltyRules | null;
  /** policy ids used on this date, by kind — for audit on the payslip */
  used: Partial<Record<PolicyKind, { id: string; version: number }>>;
}

export interface DayLeave {
  leave_type: string;
  paid: boolean;
}

export type DayFlag =
  | 'ORPHAN_OUT'
  | 'UNMATCHED_IN'
  | 'CROSS_SITE'
  | 'LATE'
  | 'NO_ATTENDANCE_POLICY'
  | 'SANDWICHED'
  | 'OVERRIDDEN';

export interface DayInput {
  date: ISODate;
  joined_on: ISODate;
  last_day: ISODate | null;
  is_holiday: boolean;
  is_weekly_off: boolean;
  leave: DayLeave | null;
  punches: EnginePunch[];
  policies: ResolvedPolicies;
  shift_start_min: number;
}

export interface DayRecord {
  date: ISODate;
  status: DayStatus;
  day_value: number;
  provisional: boolean;
  worked_min: number;
  break_min: number;
  late_min: number;
  ot_min: number;
  first_punch_min: number | null;
  last_punch_min: number | null;
  pairs: PunchPair[];
  orphan_outs: EnginePunch[];
  sites: string[];
  cross_site: boolean;
  leave_type: string | null;
  flags: DayFlag[];
}

export interface DayOverride {
  status: DayStatus;
  day_value: number;
  worked_min: number;
  ot_min: number;
  late_min: number;
}

export interface OffDayWorkEntry {
  date: ISODate;
  kind: 'HOLIDAY' | 'WEEKLY_OFF';
  worked_min: number;
  rate_pct: number;
  base: 'BASIC' | 'BASIC_HRA' | 'GROSS';
  /** Whether the off day itself carried a day's pay — decides multiplier − 1 vs the full multiplier */
  day_paid: boolean;
}

export interface EffectiveDay extends DayRecord {
  /** What the punches said, when an override replaced it */
  computed: Pick<DayRecord, 'status' | 'day_value' | 'worked_min' | 'ot_min' | 'late_min'> | null;
  overridden: boolean;
  late_penalty_days: number;
}

export interface MonthTotals {
  days_in_month: number;
  days_in_employment: number;
  present: number;
  half_day: number;
  absent: number;
  short: number;
  missing_punch: number;
  leave_paid: number;
  leave_unpaid: number;
  weekly_off: number;
  holidays: number;
  off_days_worked: number;
  late_days: number;
  late_penalty_days: number;
  ot_min: number;
  worked_min: number;
  day_value_sum: number;
  paid_days: number;
  lop_days: number;
  lop_in_window: number;
  partial: boolean;
  sandwiched: ISODate[];
  overridden_days: number;
}

export interface MonthResult {
  ym: string;
  days: EffectiveDay[];
  totals: MonthTotals;
  offday_work: OffDayWorkEntry[];
}
