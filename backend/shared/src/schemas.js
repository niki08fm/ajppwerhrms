import { z } from 'zod';
import {
  ADHOC_KINDS,
  ADHOC_TARGETS,
  CALC_TYPES,
  CALENDAR_METHODS,
  DOCUMENT_TYPES,
  EXIT_REASONS,
  FREQUENCIES,
  GENDERS,
  OVERRIDE_MARKS,
  POLICY_KINDS,
  PT_GENDER_SCOPES,
  SALARY_MODES,
  TAX_REGIMES,
  SPECIAL_ALLOWANCE,
  isPercentCalc,
} from './enums.js';
import { DAY_NAMES, isISODate, isYearMonth } from './dates.js';
import { esiRatesSchema, pfRatesSchema } from './statutory.js';

/** Shared request schemas. Every one is strict: unknown fields are rejected, not ignored. */

export const isoDate = z.string().refine(isISODate, 'Use a date in the form YYYY-MM-DD');
export const yearMonth = z.string().refine(isYearMonth, 'Use a month in the form YYYY-MM');
export const paise = z.number().int().min(0);
export const uuid = z.string().uuid();
const DAY_NAMES_SCHEMA = z.enum(DAY_NAMES);

// ─── Auth ────────────────────────────────────────────────────────────────────

export const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) }).strict();

export const siteLoginSchema = z
  .object({
    login: z.string().min(1),
    password: z.string().min(1),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracy_m: z.number().min(0),
  })
  .strict();

// ─── Lists ───────────────────────────────────────────────────────────────────

export const PAGE_SIZES = [20, 50, 100, 200];
export const listQuerySchema = z.object({
  q: z.string().max(100).optional(),
  sort: z.string().max(40).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce
    .number()
    .int()
    .refine((n) => PAGE_SIZES.includes(n), 'Page size is 20, 50, 100 or 200')
    .optional(),
  filter: z.record(z.union([z.string(), z.array(z.string())])).optional(),
});

// ─── Organisation ────────────────────────────────────────────────────────────

export const departmentSchema = z.object({ name: z.string().min(1).max(80), colour: z.string().max(40).default('chart-1') }).strict();

export const holidaySchema = z.object({ date: isoDate, name: z.string().min(1).max(100) }).strict();

export const shiftSchema = z
  .object({
    name: z.string().min(1).max(60),
    start_min: z.number().int().min(0).max(1439),
    end_min: z.number().int().min(0).max(1439),
    break_min: z.number().int().min(0).max(600),
    crosses_midnight: z.boolean(),
  })
  .strict();

export const projectSchema = z
  .object({
    code: z.string().min(1).max(20),
    name: z.string().min(1).max(120),
    client: z.string().max(120).nullable().optional(),
    contract_value: paise.default(0),
    budget_labour: paise.default(0),
    material_cost: paise.default(0),
    other_cost: paise.default(0),
    started_on: isoDate.nullable().optional(),
  })
  .strict();

// ─── Sites ───────────────────────────────────────────────────────────────────

export const SITE_RADIUS_MIN_M = 50;
export const SITE_RADIUS_MAX_M = 2000;
export const SITE_RADIUS_DEFAULT_M = 200;

/** Tablet login ID: 4–32 letters, digits or dashes, stored lower-case. */
export const siteLoginId = z
  .string()
  .trim()
  .min(4, 'The login ID needs at least 4 characters')
  .max(32, 'The login ID can be at most 32 characters')
  .regex(/^[A-Za-z0-9-]+$/, 'Use only letters, numbers and dashes in the login ID')
  .transform((v) => v.toLowerCase());

/** Tablet password: at least 8 characters, with a letter and a number. */
export const sitePassword = z
  .string()
  .min(8, 'The password needs at least 8 characters')
  .max(128, 'The password can be at most 128 characters')
  .refine((v) => /[A-Za-z]/.test(v) && /[0-9]/.test(v), 'The password must include a letter and a number');

const siteFields = {
  code: z
    .string()
    .min(1)
    .max(20)
    .regex(/^[A-Z0-9-]+$/, 'Upper-case letters, digits and dashes'),
  name: z.string().trim().min(1, 'Give the site a name').max(120),
  address: z.string().trim().max(300).nullable().optional(),
  state: z.string().min(1).max(60),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radius_m: z
    .number()
    .int()
    .min(SITE_RADIUS_MIN_M, `The boundary must be at least ${SITE_RADIUS_MIN_M} m`)
    .max(SITE_RADIUS_MAX_M, `The boundary can be at most ${SITE_RADIUS_MAX_M} m`),
  project_id: uuid.nullable().optional(),
  is_active: z.boolean().optional(),
  login: siteLoginId,
};

/** Create: the tablet login is set here. No password means the server generates one. */
export const siteSchema = z
  .object({ ...siteFields, radius_m: siteFields.radius_m.default(SITE_RADIUS_DEFAULT_M), password: sitePassword.optional() })
  .strict();

/** Edit: any field except the password, which has its own reset. */
export const siteUpdateSchema = z.object(siteFields).partial().strict();

/** Reset: type a password, or send none and the server generates one. */
export const sitePasswordSchema = z.object({ password: sitePassword.optional() }).strict();

export const siteLoginEnabledSchema = z.object({ enabled: z.boolean() }).strict();

export const geoSearchSchema = z.object({ q: z.string().trim().min(3, 'Type at least 3 characters to search').max(200) }).strict();

// ─── Policies, structures, pay groups ────────────────────────────────────────

export const policyCreateSchema = z
  .object({
    kind: z.enum(POLICY_KINDS),
    name: z.string().min(1).max(100),
    valid_from: isoDate,
    rules: z.unknown(),
  })
  .strict();

export const policyVersionSchema = z
  .object({
    valid_from: isoDate,
    name: z.string().min(1).max(100).optional(),
    rules: z.unknown(),
  })
  .strict();

export const salaryComponentSchema = z
  .object({
    seq: z.number().int().min(0),
    name: z.string().trim().min(1).max(60),
    calc_type: z.enum(CALC_TYPES),
    /** Percentage for PCT_*, paise for FIXED, ignored for BALANCE */
    calc_value: z.number().min(0),
    /** Optional cap in paise on a percentage component. There is deliberately no minimum. */
    max_amount: z.number().int().min(1).nullable().default(null),
    frequency: z.enum(FREQUENCIES),
    pay_month: z.number().int().min(1).max(12).nullable(),
    is_taxable: z.boolean(),
    counts_as_wages: z.boolean(),
    colour: z.string().max(40).default('chart-1'),
  })
  .strict()
  .refine((c) => c.max_amount === null || isPercentCalc(c.calc_type), { message: 'A maximum only applies to a percentage component.', path: ['max_amount'] })
  .refine((c) => !isPercentCalc(c.calc_type) || c.calc_value <= 100, { message: 'A percentage cannot be more than 100.', path: ['calc_value'] });

/**
 * Whatever is left of gross is the Special Allowance. A structure sent without
 * one gets one, last, so gross always adds up.
 */
export function withSpecialAllowance(components, make) {
  if (components.some((c) => c.calc_type === 'BALANCE' && c.frequency === 'MONTHLY')) return components;
  const seq = components.reduce((m, c) => Math.max(m, c.seq), 0) + 1;
  return [...components, make(seq)];
}

/**
 * A structure has no date of its own. It applies to the people of whichever pay
 * group it is attached to, from the month chosen when it is attached.
 */
export const structureCreateSchema = z
  .object({
    name: z.string().min(1).max(100),
    components: z
      .array(salaryComponentSchema)
      .min(1)
      .transform((cs) =>
        withSpecialAllowance(cs, (seq) => ({
          seq,
          name: SPECIAL_ALLOWANCE,
          calc_type: 'BALANCE',
          calc_value: 0,
          max_amount: null,
          frequency: 'MONTHLY',
          pay_month: null,
          is_taxable: true,
          counts_as_wages: false,
          colour: `chart-${((seq - 1) % 5) + 1}`,
        })),
      ),
    duplicated_from: uuid.optional(),
  })
  .strict();

export const payGroupSchema = z
  .object({
    name: z.string().min(1).max(100),
    frequency: z.literal('MONTHLY').default('MONTHLY'),
    pay_day: z.number().int().min(1).max(28),
    calendar_method: z.enum(CALENDAR_METHODS),
    weekly_off: z.array(DAY_NAMES_SCHEMA).max(6),
    shift_id: uuid,
    structure_id: uuid,
    policy_ids: z.array(uuid).default([]),
  })
  .strict();

export const payGroupPatchSchema = payGroupSchema
  .partial()
  .extend({
    /**
     * When the structure changes: the first month everyone in the group is paid
     * on it. Defaults to the earliest month not yet run.
     */
    structure_from: yearMonth.optional(),
  })
  .strict();

// ─── Statutory configuration ─────────────────────────────────────────────────

export const statutoryRatesCreateSchema = z
  .object({
    valid_from: isoDate,
    pf: pfRatesSchema,
    esi: esiRatesSchema,
    recovery_cap_pct: z.number().min(0).max(100),
  })
  .strict();

export const ptSlabRowSchema = z
  .object({
    state: z.string().min(1),
    gender_scope: z.enum(PT_GENDER_SCOPES),
    upto_amount: paise.nullable(),
    amount: paise,
    feb_amount: paise.nullable(),
  })
  .strict();

export const ptSlabsReplaceSchema = z.object({ state: z.string().min(1), slabs: z.array(ptSlabRowSchema) }).strict();

// ─── People ──────────────────────────────────────────────────────────────────

const phone = z.string().regex(/^[0-9+\- ]{7,15}$/, 'Enter a phone number');

export const employeeCoreSchema = z
  .object({
    name: z.string().min(1).max(120),
    dob: isoDate.nullable().optional(),
    gender: z.enum(GENDERS),
    phone: phone,
    email: z.string().email().nullable().optional(),
    address: z.string().max(500).nullable().optional(),
    blood_group: z.string().max(5).nullable().optional(),
    department_id: uuid,
    designation: z.string().min(1).max(80),
    pay_group_id: uuid,
  })
  .strict();

export const employeeIdentitySchema = z
  .object({
    pan: z
      .string()
      .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'PAN is 5 letters, 4 digits, 1 letter')
      .nullable()
      .optional(),
    aadhaar: z
      .string()
      .regex(/^[0-9]{12}$/, 'Aadhaar is 12 digits')
      .nullable()
      .optional(),
    uan: z
      .string()
      .regex(/^[0-9]{12}$/, 'UAN is 12 digits')
      .nullable()
      .optional(),
    esi_number: z.string().max(17).nullable().optional(),
    bank_account: z
      .string()
      .regex(/^[0-9]{6,18}$/, 'Account number is 6–18 digits')
      .nullable()
      .optional(),
    bank_ifsc: z
      .string()
      .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC is 11 characters, e.g. SBIN0001234')
      .nullable()
      .optional(),
    bank_name: z.string().max(80).nullable().optional(),
  })
  .strict();

export const employeeUpdateSchema = employeeCoreSchema
  .partial()
  .extend({
    identity: employeeIdentitySchema.optional(),
    /** The updated_at the client last saw — rejected with 409 if it has moved */
    updated_at: z.string().nullable(),
  })
  .strict();

export const statutoryUpdateSchema = z
  .object({
    pf_enabled: z.boolean().optional(),
    pf_restrict_to_ceiling: z.boolean().optional(),
    vpf_pct: z.number().min(0).max(100).optional(),
    esi_enabled: z.boolean().optional(),
    pt_applicable: z.boolean().optional(),
    pt_exempt_reason: z.string().max(200).nullable().optional(),
    pt_state: z.string().min(1).optional(),
    tax_regime_code: z.enum(TAX_REGIMES).optional(),
    decl_80c: paise.optional(),
    decl_80d: paise.optional(),
    decl_rent_monthly: paise.optional(),
    decl_metro: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.pt_applicable !== false || (v.pt_exempt_reason && v.pt_exempt_reason.trim().length >= 3), {
    message: 'Switching professional tax off needs the exemption category recorded',
    path: ['pt_exempt_reason'],
  });

export const salaryRevisionSchema = z
  .object({
    mode: z.enum(SALARY_MODES),
    amount: paise.min(1),
    valid_from: isoDate,
    structure_id: uuid.nullable().optional(),
    reason: z.string().min(3).max(300),
    /** When a CTC lands in the ESI band, the caller must pick one of the two grosses */
    chosen_gross: paise.optional(),
  })
  .strict();

export const offerCreateSchema = z
  .object({
    name: z.string().min(1).max(120),
    gender: z.enum(GENDERS),
    phone: phone,
    email: z.string().email().nullable().optional(),
    department_id: uuid,
    designation: z.string().min(1).max(80),
    pay_group_id: uuid,
    mode: z.enum(SALARY_MODES),
    amount: paise.min(1),
    join_by: isoDate,
    valid_till: isoDate,
    pt_state: z.string().min(1),
    chosen_gross: paise.optional(),
  })
  .strict();

export const resignSchema = z
  .object({
    resigned_on: isoDate,
    last_day: isoDate,
    exit_reason: z.enum(EXIT_REASONS),
    note: z.string().max(500).optional(),
  })
  .strict();

const why = z.string().trim().min(8, 'Say why in at least eight characters').max(300);

/** Taking back an exit: the person is active again. */
export const exitWithdrawSchema = z.object({ reason: why }).strict();

/** Ticking an exit checklist task, or un-ticking it. */
export const exitTaskTickSchema = z.object({ done: z.boolean(), note: z.string().max(300).optional() }).strict();

/** One change HR makes to a settlement. Every change gives a reason and is audited. */
export const settlementAdjustSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('EXCLUDE'), code: z.string().min(1).max(80), reason: why }).strict(),
  z.object({ action: z.literal('INCLUDE'), code: z.string().min(1).max(80) }).strict(),
  z.object({ action: z.literal('SET_DAYS'), code: z.string().min(1).max(80), days: z.number().min(0).max(366).multipleOf(0.25), reason: why }).strict(),
  z.object({ action: z.literal('CLEAR_DAYS'), code: z.string().min(1).max(80) }).strict(),
  z.object({ action: z.literal('ADD_LINE'), kind: z.enum(['EARNING', 'DEDUCTION']), name: z.string().trim().min(2).max(80), amount: paise.min(1), reason: why }).strict(),
  z.object({ action: z.literal('REMOVE_LINE'), id: z.string().min(1).max(40) }).strict(),
]);

/**
 * Processing a full and final settlement into a month's payroll: paid in that month's bank
 * file, or paid separately — recorded in that month's payroll but never in a bank file.
 */
export const settlementProcessSchema = z
  .object({
    period_ym: yearMonth,
    paid_separately: z
      .object({ paid_on: isoDate, payment_ref: z.string().trim().min(2, 'Enter the cheque or transfer reference').max(100) })
      .strict()
      .optional(),
  })
  .strict();

/** Holding someone's salary from a payroll month until HR releases it. */
export const salaryHoldSchema = z.object({ from_ym: yearMonth, reason: z.string().trim().min(3, 'Say why in a few words').max(300) }).strict();

/** Releasing a held salary: into a payroll month and its bank file, or paid separately. */
export const salaryReleaseSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('PAYROLL'), pay_ym: yearMonth, note: z.string().max(300).optional() }).strict(),
  z
    .object({ mode: z.literal('SEPARATE'), paid_on: isoDate, payment_ref: z.string().trim().min(2, 'Enter the cheque or transfer reference').max(100), note: z.string().max(300).optional() })
    .strict(),
]);

export const documentCreateSchema = z
  .object({
    doc_type: z.enum(DOCUMENT_TYPES),
    collected_on: isoDate,
    expires_on: isoDate.nullable().optional(),
  })
  .strict();

/** HR enrolment from the profile: multipart fields sent with one or more frames. */
export const faceEnrolSchema = z
  .object({
    consent: z.enum(['true'], { errorMap: () => ({ message: 'Written consent is required before enrolment' }) }),
    /** HR's decision is final: enrol even though the face resembles someone else's */
    confirm_duplicate: z.enum(['true', 'false']).optional(),
  })
  .strict();

// ─── Attendance ──────────────────────────────────────────────────────────────

/** Minutes from midnight of the work date. An out time may pass midnight. */
const minuteOfDay = z
  .number()
  .int()
  .min(0)
  .max(36 * 60);
const otMinutes = z
  .number()
  .int()
  .min(0)
  .max(16 * 60);
const correctionWhy = z.string().trim().min(3, 'Say why in a few words').max(500);

/**
 * HR's correction of one day. Either the times worked — late minutes, half or full day and
 * overtime then follow from the attendance rules — or a mark of the day, with any overtime
 * entered directly.
 */
export const overrideCreateSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('TIMES'), employee_id: uuid, work_date: isoDate, in_min: minuteOfDay, out_min: minuteOfDay, reason_text: correctionWhy }).strict(),
  z.object({ mode: z.literal('MARK'), employee_id: uuid, work_date: isoDate, status: z.enum(OVERRIDE_MARKS), ot_min: otMinutes.default(0), reason_text: correctionWhy }).strict(),
]);

/** Working a day out from times before saving it. Give the out time, or the overtime and the out time follows. */
export const overridePreviewSchema = z
  .object({ employee_id: uuid, work_date: isoDate, in_min: minuteOfDay, out_min: minuteOfDay.optional(), ot_min: otMinutes.optional() })
  .strict();

/** The same mark, with one reason, applied to many days. */
export const bulkOverrideSchema = z
  .object({
    items: z
      .array(z.object({ employee_id: uuid, work_date: isoDate }).strict())
      .min(1)
      .max(500),
    status: z.enum(OVERRIDE_MARKS),
    ot_min: otMinutes.default(0),
    reason_text: correctionWhy,
  })
  .strict();

// ─── Tablet punches (face v2) ────────────────────────────────────────────────

const position = {
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  accuracy_m: z.coerce.number().min(0),
};

/** Chosen by the tablet for each upload and sent again, unchanged, on a retry. */
export const faceRequestId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/, 'A request id is 8–80 letters, digits, dashes or underscores');

export const employeeCodeSchema = z.string().trim().min(1, 'Enter your employee ID').max(30);

export const punchSessionStartSchema = z
  .object({
    purpose: z.enum(['PUNCH', 'REGISTER']).default('PUNCH'),
    /** Register face only: who is registering */
    employee_code: employeeCodeSchema.optional(),
    name: z.string().trim().min(2, 'Enter your name').max(120).optional(),
    ...position,
  })
  .strict()
  .refine((v) => v.purpose === 'PUNCH' || (!!v.employee_code && !!v.name), { message: 'Enter your employee ID and name to register', path: ['employee_code'] });

/** Multipart fields sent with the two frames (front, turn). */
export const punchFramesSchema = z.object({ request_id: faceRequestId, ...position }).strict();

export const punchConfirmSchema = z.object({ confirm_token: z.string().min(16).max(200), device_id: z.string().max(100).optional(), ...position }).strict();

export const punchNotMeSchema = z.object({ confirm_token: z.string().min(16).max(200) }).strict();

export const punchChangeSiteSchema = z.object({ confirm_token: z.string().min(16).max(200), to_site_id: uuid, ...position }).strict();

/** The ID/name form after the try limit: becomes a manual request for HR, with the face crops. */
export const punchManualSchema = z.object({ employee_code: employeeCodeSchema, name: z.string().trim().min(2, 'Enter your name').max(120), ...position }).strict();

export const siteChangeReviewSchema = z
  .object({
    travel_min: z.number().int().min(0).max(1440),
    reason: z.string().trim().min(3, 'Say why, in a few words').max(300),
  })
  .strict();

export const faceExceptionDecideSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    employee_id: uuid.optional(),
    direction: z.enum(['IN', 'OUT']).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict()
  .refine((v) => v.decision !== 'APPROVE' || !!v.employee_id, { message: 'Pick who it actually was', path: ['employee_id'] })
  .refine((v) => v.decision !== 'REJECT' || (v.reason && v.reason.trim().length >= 8), {
    message: 'Rejecting needs a written reason of at least eight characters',
    path: ['reason'],
  });

export const leaveCreateSchema = z
  .object({
    employee_id: uuid,
    leave_type: z.string().min(1).max(10),
    from_date: isoDate,
    to_date: isoDate,
    days: z.number().min(0.5).max(366).multipleOf(0.5),
    reason: z.string().max(500).optional(),
  })
  .strict()
  .refine((v) => v.from_date <= v.to_date, { message: 'The leave ends before it starts', path: ['to_date'] });

export const leaveDecideSchema = z.object({ decision: z.enum(['APPROVE', 'REJECT', 'CANCEL']), note: z.string().max(500).optional() }).strict();

/** Days HR adds to a leave balance (positive) or takes from it (negative). */
export const leaveAdjustmentSchema = z
  .object({
    employee_id: uuid,
    leave_type: z.string().min(1).max(10),
    date: isoDate,
    days: z
      .number()
      .min(-366)
      .max(366)
      .multipleOf(0.25)
      .refine((d) => d !== 0, 'Add or take away at least a quarter of a day'),
    reason: z.string().trim().min(8, 'Say why in at least eight characters').max(300),
  })
  .strict();

// ─── Payroll ─────────────────────────────────────────────────────────────────

export const adhocCreateSchema = z
  .object({
    period_ym: yearMonth,
    kind: z.enum(ADHOC_KINDS),
    name: z.string().min(1).max(80),
    amount: paise.min(1),
    is_taxable: z.boolean(),
    target_type: z.enum(ADHOC_TARGETS),
    target_ids: z.array(z.string()).default([]),
    note: z.string().min(3, 'Say why and who approved it').max(500),
  })
  .strict()
  .refine((v) => v.target_type === 'ALL' || v.target_ids.length > 0, { message: 'Pick at least one target', path: ['target_ids'] })
  .refine((v) => v.kind !== 'REIMBURSEMENT' || !v.is_taxable, { message: 'Reimbursements are never taxable', path: ['is_taxable'] });

export const exclusionSchema = z.object({ employee_id: uuid, reason: z.string().min(3).max(300) }).strict();

export const markPaidSchema = z.object({ payment_ref: z.string().min(3).max(100) }).strict();

export const advanceCreateSchema = z
  .object({
    employee_id: uuid,
    amount: paise.min(1),
    reason: z.string().min(3).max(300),
    granted_on: isoDate,
    instalment: paise.min(1),
  })
  .strict();

export const loanCreateSchema = z
  .object({
    employee_id: uuid,
    loan_type: z.string().min(1).max(40),
    principal: paise.min(1),
    months: z.number().int().min(1).max(120),
    started_on: isoDate,
  })
  .strict();

export const savedViewSchema = z.object({ list: z.string().min(1).max(40), name: z.string().min(1).max(80), query: z.string().max(2000) }).strict();
