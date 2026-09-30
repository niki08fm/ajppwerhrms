export const EMPLOYEE_STATUSES = ['OFFER', 'ACCEPTED', 'ONBOARDING', 'ACTIVE', 'NOTICE', 'EXITED'];

export const GENDERS = ['MALE', 'FEMALE', 'OTHER'];

export const POLICY_KINDS = ['ATTENDANCE', 'OVERTIME', 'WEEKOFF_PAY', 'HOLIDAY_PAY', 'HOLIDAY_WORK', 'LATE_PENALTY', 'LEAVE'];

export const POLICY_KIND_LABELS = {
  ATTENDANCE: 'Attendance',
  OVERTIME: 'Overtime',
  WEEKOFF_PAY: 'Weekly off pay',
  HOLIDAY_PAY: 'Holiday pay',
  HOLIDAY_WORK: 'Off-day work',
  LATE_PENALTY: 'Late penalty',
  LEAVE: 'Leave',
};

/** What it means in practice when a pay group has no policy of this kind. */
export const POLICY_KIND_MISSING_WARNING = {
  ATTENDANCE: 'Days are judged on the built-in default of an 8-hour day, 4-hour half day and no grace period.',
  OVERTIME: 'Nobody in this group earns overtime.',
  WEEKOFF_PAY: 'Weekly offs are unpaid for everyone in this group.',
  HOLIDAY_PAY: 'Holidays are unpaid for everyone in this group.',
  HOLIDAY_WORK: 'Working a holiday or weekly off earns nothing extra.',
  LATE_PENALTY: 'Lateness is recorded but never charged.',
  LEAVE: 'No leave types exist, so approved leave cannot be paid.',
};

export const POLICY_STATUSES = ['ACTIVE', 'RETIRED'];

export const CALC_TYPES = ['PCT_GROSS', 'PCT_CTC', 'PCT_BASIC', 'FIXED', 'BALANCE'];

export const CALC_TYPE_LABELS = {
  PCT_GROSS: '% of gross',
  PCT_CTC: '% of CTC',
  PCT_BASIC: '% of basic',
  FIXED: 'Fixed',
  BALANCE: 'Special Allowance',
};

/** What a percentage component is a percentage of. */
export const PERCENT_OF = [
  { calc_type: 'PCT_GROSS', label: 'Gross', explain: 'of the monthly gross' },
  { calc_type: 'PCT_CTC', label: 'CTC', explain: 'of the annual CTC, spread over twelve months' },
  { calc_type: 'PCT_BASIC', label: 'Basic', explain: 'of the monthly basic' },
];

/** The name of the component that takes whatever is left of gross. Every structure has exactly one. */
export const SPECIAL_ALLOWANCE = 'Special Allowance';

export function isPercentCalc(t) {
  return t === 'PCT_GROSS' || t === 'PCT_CTC' || t === 'PCT_BASIC';
}

export const FREQUENCIES = ['MONTHLY', 'YEARLY'];

export const CALENDAR_METHODS = ['FIXED_26', 'FIXED_30', 'ACTUAL', 'WORKING'];

export const CALENDAR_METHOD_INFO = {
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

export const PAY_FREQUENCIES = ['MONTHLY'];

export const SALARY_MODES = ['CTC', 'GROSS'];

export const PUNCH_DIRECTIONS = ['IN', 'OUT'];

export const PUNCH_METHODS = ['FACE', 'MANUAL', 'EXCEPTION'];

export const DAY_STATUSES = ['NOT_JOINED', 'EXITED', 'HOLIDAY_WORKED', 'HOLIDAY', 'OFF_WORKED', 'WEEKLY_OFF', 'ON_LEAVE', 'ABSENT', 'MISSING_PUNCH', 'PRESENT', 'HALF_DAY', 'SHORT'];

export const DAY_STATUS_LABELS = {
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

export const DAY_STATUS_TONE = {
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

export const OVERRIDE_REASONS = ['FORGOT_TO_PUNCH', 'DEVICE_DOWN', 'NO_NETWORK', 'SITE_INSTRUCTION', 'LATE_APPROVED', 'DATA_ERROR', 'OTHER'];

export const OVERRIDE_REASON_LABELS = {
  FORGOT_TO_PUNCH: 'Forgot to punch',
  DEVICE_DOWN: 'Camera or tablet down',
  NO_NETWORK: 'No network',
  SITE_INSTRUCTION: 'Worked on site instruction',
  LATE_APPROVED: 'Late arrival approved',
  DATA_ERROR: 'Correcting a data error',
  OTHER: 'Other',
};

export const LEAVE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];

export const FACE_EXCEPTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];

export const PERIOD_STATES = ['DRAFT', 'RUN', 'LOCKED', 'PAID'];

export const PAYROLL_STEPS = [
  { n: 1, key: 'attendance', label: 'Attendance' },
  { n: 2, key: 'joiners', label: 'Joiners and exits' },
  { n: 3, key: 'issues', label: 'Issues' },
  { n: 4, key: 'adhoc', label: 'Adhoc' },
  { n: 5, key: 'run', label: 'Run' },
];

export const PAYSLIP_LINE_KINDS = ['COMPONENT', 'YEARLY', 'OT', 'OFFDAY', 'ADHOC', 'DEDUCTION', 'REIMBURSEMENT', 'EMPLOYER'];

export const ADHOC_KINDS = ['EARNING', 'REIMBURSEMENT', 'DEDUCTION'];

export const ADHOC_TARGETS = ['EMPLOYEE', 'PAY_GROUP', 'DEPARTMENT', 'ALL'];

export const SETTLEMENT_STATES = ['OPEN', 'INCLUDED', 'PAID'];

export const LOAN_STATUSES = ['ACTIVE', 'CLOSED'];

export const PT_GENDER_SCOPES = ['ALL', 'MALE', 'FEMALE'];

export const TAX_REGIMES = ['NEW', 'OLD'];

export const DOCUMENT_TYPES = ['PAN', 'AADHAAR', 'BANK_PROOF', 'PHOTO', 'EDUCATION', 'EXPERIENCE', 'MEDICAL', 'SAFETY_CERT', 'DRIVING_LICENCE', 'OTHER'];

export const LETTER_KINDS = ['OFFER', 'JOINING', 'REVISION', 'RELIEVING', 'EXPERIENCE', 'SETTLEMENT'];

export const EXIT_REASONS = ['RESIGNATION', 'TERMINATION', 'CONTRACT_END', 'RETIREMENT', 'ABSCONDING', 'DEATH', 'OTHER'];

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
];

export const PT_STATES = ['Andhra Pradesh', 'Telangana', 'Karnataka', 'Maharashtra', 'West Bengal', 'Gujarat', 'Delhi'];

export const INDIAN_STATES = [
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chhattisgarh',
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
];

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
];

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
];
