export const EMPLOYEE_STATUSES = ['OFFER', 'ACCEPTED', 'ONBOARDING', 'ACTIVE', 'NOTICE', 'EXITED'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const GENDERS = ['MALE', 'FEMALE', 'OTHER'] as const;
export type Gender = (typeof GENDERS)[number];

export const POLICY_KINDS = [
  'ATTENDANCE',
  'OVERTIME',
  'WEEKOFF_PAY',
  'HOLIDAY_PAY',
  'HOLIDAY_WORK',
  'LATE_PENALTY',
  'LEAVE',
] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

export const POLICY_KIND_LABELS: Record<PolicyKind, string> = {
  ATTENDANCE: 'Attendance',
  OVERTIME: 'Overtime',
  WEEKOFF_PAY: 'Weekly off pay',
  HOLIDAY_PAY: 'Holiday pay',
  HOLIDAY_WORK: 'Off-day work',
  LATE_PENALTY: 'Late penalty',
  LEAVE: 'Leave',
};

/** What it means in practice when a pay group has no policy of this kind. */
export const POLICY_KIND_MISSING_WARNING: Record<PolicyKind, string> = {
  ATTENDANCE: 'Days are judged on the built-in default of an 8-hour day, 4-hour half day and no grace period.',
  OVERTIME: 'Nobody in this group earns overtime.',
  WEEKOFF_PAY: 'Weekly offs are unpaid for everyone in this group.',
  HOLIDAY_PAY: 'Holidays are unpaid for everyone in this group.',
  HOLIDAY_WORK: 'Working a holiday or weekly off earns nothing extra.',
  LATE_PENALTY: 'Lateness is recorded but never charged.',
  LEAVE: 'No leave types exist, so approved leave cannot be paid.',
};

export const POLICY_STATUSES = ['ACTIVE', 'RETIRED'] as const;

export const CALC_TYPES = ['PCT_GROSS', 'PCT_BASIC', 'FIXED', 'BALANCE'] as const;
export type CalcType = (typeof CALC_TYPES)[number];

export const CALC_TYPE_LABELS: Record<CalcType, string> = {
  PCT_GROSS: '% of gross',
  PCT_BASIC: '% of basic',
  FIXED: 'Fixed',
  BALANCE: 'Balance',
};

export const FREQUENCIES = ['MONTHLY', 'YEARLY'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const CALENDAR_METHODS = ['FIXED_26', 'FIXED_30', 'ACTUAL', 'WORKING'] as const;
export type CalendarMethod = (typeof CALENDAR_METHODS)[number];

export const CALENDAR_METHOD_INFO: Record<CalendarMethod, { label: string; explain: string }> = {
  FIXED_26: {
    label: '26 days',
    explain: "A day's pay is a 26th of the month, whatever the month. The common choice for site workforces.",
  },
  FIXED_30: {
    label: '30 days',
    explain: "A day's pay is a 30th of the month, whatever the month.",
  },
  ACTUAL: {
    label: 'Calendar days',
    explain: "A day's pay is the month divided by the days in that month — 28 to 31.",
  },
  WORKING: {
    label: 'Working days',
    explain: "A day's pay is the month divided by the days that are neither weekly off nor holiday. Varies month to month.",
  },
};

export const PAY_FREQUENCIES = ['MONTHLY'] as const;

export const SALARY_MODES = ['CTC', 'GROSS'] as const;
export type SalaryMode = (typeof SALARY_MODES)[number];

export const PUNCH_DIRECTIONS = ['IN', 'OUT'] as const;
export type PunchDirection = (typeof PUNCH_DIRECTIONS)[number];

export const PUNCH_METHODS = ['FACE', 'MANUAL', 'EXCEPTION'] as const;
export type PunchMethod = (typeof PUNCH_METHODS)[number];

export const DAY_STATUSES = [
  'NOT_JOINED',
  'EXITED',
  'HOLIDAY_WORKED',
  'HOLIDAY',
  'OFF_WORKED',
  'WEEKLY_OFF',
  'ON_LEAVE',
  'ABSENT',
  'MISSING_PUNCH',
  'PRESENT',
  'HALF_DAY',
  'SHORT',
] as const;
export type DayStatus = (typeof DAY_STATUSES)[number];

export const DAY_STATUS_LABELS: Record<DayStatus, string> = {
  NOT_JOINED: 'Not joined',
  EXITED: 'Exited',
  HOLIDAY_WORKED: 'Holiday worked',
  HOLIDAY: 'Holiday',
  OFF_WORKED: 'Off day worked',
  WEEKLY_OFF: 'Weekly off',
  ON_LEAVE: 'On leave',
  ABSENT: 'Absent',
  MISSING_PUNCH: 'Missing punch',
  PRESENT: 'Present',
  HALF_DAY: 'Half day',
  SHORT: 'Short',
};

export type StatusTone = 'success' | 'warning' | 'destructive' | 'muted' | 'info';
export const DAY_STATUS_TONE: Record<DayStatus, StatusTone> = {
  NOT_JOINED: 'muted',
  EXITED: 'muted',
  HOLIDAY_WORKED: 'info',
  HOLIDAY: 'muted',
  OFF_WORKED: 'info',
  WEEKLY_OFF: 'muted',
  ON_LEAVE: 'info',
  ABSENT: 'destructive',
  MISSING_PUNCH: 'warning',
  PRESENT: 'success',
  HALF_DAY: 'warning',
  SHORT: 'destructive',
};

export const OVERRIDE_REASONS = [
  'FORGOT_TO_PUNCH',
  'DEVICE_DOWN',
  'NO_NETWORK',
  'SITE_INSTRUCTION',
  'LATE_APPROVED',
  'DATA_ERROR',
  'OTHER',
] as const;
export type OverrideReason = (typeof OVERRIDE_REASONS)[number];

export const OVERRIDE_REASON_LABELS: Record<OverrideReason, string> = {
  FORGOT_TO_PUNCH: 'Forgot to punch',
  DEVICE_DOWN: 'Camera or tablet down',
  NO_NETWORK: 'No network',
  SITE_INSTRUCTION: 'Worked on site instruction',
  LATE_APPROVED: 'Late arrival approved',
  DATA_ERROR: 'Correcting a data error',
  OTHER: 'Other',
};

export const LEAVE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export const FACE_EXCEPTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;

export const PERIOD_STATES = ['DRAFT', 'RUN', 'LOCKED', 'PAID'] as const;
export type PeriodState = (typeof PERIOD_STATES)[number];

export const PAYROLL_STEPS = [
  { n: 1, key: 'attendance', label: 'Attendance' },
  { n: 2, key: 'joiners', label: 'Joiners and exits' },
  { n: 3, key: 'issues', label: 'Issues' },
  { n: 4, key: 'adhoc', label: 'Adhoc' },
  { n: 5, key: 'run', label: 'Run' },
] as const;

export const PAYSLIP_LINE_KINDS = [
  'COMPONENT',
  'YEARLY',
  'OT',
  'OFFDAY',
  'ADHOC',
  'DEDUCTION',
  'REIMBURSEMENT',
  'EMPLOYER',
] as const;
export type PayslipLineKind = (typeof PAYSLIP_LINE_KINDS)[number];

export const ADHOC_KINDS = ['EARNING', 'REIMBURSEMENT', 'DEDUCTION'] as const;
export type AdhocKind = (typeof ADHOC_KINDS)[number];

export const ADHOC_TARGETS = ['EMPLOYEE', 'PAY_GROUP', 'DEPARTMENT', 'ALL'] as const;
export type AdhocTarget = (typeof ADHOC_TARGETS)[number];

export const SETTLEMENT_STATES = ['OPEN', 'INCLUDED', 'PAID'] as const;

export const LOAN_STATUSES = ['ACTIVE', 'CLOSED'] as const;

export const PT_GENDER_SCOPES = ['ALL', 'MALE', 'FEMALE'] as const;

export const TAX_REGIMES = ['NEW', 'OLD'] as const;
export type TaxRegimeCode = (typeof TAX_REGIMES)[number];

export const DOCUMENT_TYPES = [
  'PAN',
  'AADHAAR',
  'BANK_PROOF',
  'PHOTO',
  'EDUCATION',
  'EXPERIENCE',
  'MEDICAL',
  'SAFETY_CERT',
  'DRIVING_LICENCE',
  'OTHER',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const LETTER_KINDS = ['OFFER', 'JOINING', 'REVISION', 'RELIEVING', 'EXPERIENCE', 'SETTLEMENT'] as const;
export type LetterKind = (typeof LETTER_KINDS)[number];

export const EXIT_REASONS = ['RESIGNATION', 'TERMINATION', 'CONTRACT_END', 'RETIREMENT', 'ABSCONDING', 'DEATH', 'OTHER'] as const;

/** The onboarding checklist is a constant, not a table. */
export const ONBOARDING_TASKS = [
  { code: 'PERSONAL', label: 'Personal details', required: true, opens: 'edit' },
  { code: 'IDENTITY', label: 'Identity documents — PAN and Aadhaar', required: true, opens: 'edit' },
  { code: 'BANK', label: 'Bank account', required: true, opens: 'edit' },
  { code: 'PAY', label: 'Pay group and salary', required: true, opens: 'pay' },
  { code: 'JOINING_LETTER', label: 'Joining letter issued', required: true, opens: 'letters' },
  { code: 'FACE', label: 'Face enrolment', required: true, opens: 'face' },
  { code: 'STATUTORY', label: 'Statutory setup — PF, ESI, PT state, tax regime', required: false, opens: 'pay' },
  { code: 'SAFETY', label: 'Safety induction', required: false, opens: null },
  { code: 'MEDICAL', label: 'Medical fitness', required: false, opens: null },
  { code: 'ORIENTATION', label: 'Site orientation', required: false, opens: null },
] as const;
export type OnboardingTaskCode = (typeof ONBOARDING_TASKS)[number]['code'];

export const PT_STATES = [
  'Andhra Pradesh',
  'Telangana',
  'Karnataka',
  'Maharashtra',
  'West Bengal',
  'Gujarat',
  'Delhi',
] as const;

export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Delhi', 'Goa', 'Gujarat',
  'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra',
  'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim',
  'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
] as const;

export const ERROR_CODES = [
  'VALIDATION',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'STALE_UPDATE',
  'RATE_LIMITED',
  'PERIOD_LOCKED',
  'STEP_NOT_SUBMITTED',
  'BLOCKING_ISSUES',
  'SALARY_OVERLAP',
  'CTC_AMBIGUOUS',
  'GEOFENCE_REJECTED',
  'DUPLICATE_PUNCH',
  'NO_POLICY_ATTACHED',
  'RUN_IN_PROGRESS',
  'INVALID_TRANSITION',
  'ATTENDANCE_FROZEN',
  'NO_CHANGE',
  'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Permissions. The admin role holds all of them; the check is a lookup, never `isAdmin`. */
export const PERMISSIONS = [
  'people.read',
  'people.write',
  'pii.read',
  'salary.read',
  'salary.write',
  'attendance.read',
  'attendance.write',
  'leave.write',
  'payroll.read',
  'payroll.run',
  'payroll.pay',
  'setup.read',
  'setup.write',
  'sites.write',
  'audit.read',
  'reports.export',
] as const;
export type Permission = (typeof PERMISSIONS)[number];
