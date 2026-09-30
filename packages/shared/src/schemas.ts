import { z } from 'zod';
import {
  ADHOC_KINDS,
  ADHOC_TARGETS,
  CALC_TYPES,
  CALENDAR_METHODS,
  DAY_STATUSES,
  DOCUMENT_TYPES,
  EXIT_REASONS,
  FREQUENCIES,
  GENDERS,
  OVERRIDE_REASONS,
  POLICY_KINDS,
  PT_GENDER_SCOPES,
  SALARY_MODES,
  TAX_REGIMES,
  SPECIAL_ALLOWANCE,
  isPercentCalc,
  type CalcType,
  type Frequency,
} from './enums';
import { DAY_NAMES, isISODate, isYearMonth } from './dates';
import { esiRatesSchema, gratuityRatesSchema, pfRatesSchema } from './statutory';

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

export const PAGE_SIZES = [50, 100, 200] as const;
export const listQuerySchema = z.object({
  q: z.string().max(100).optional(),
  sort: z.string().max(40).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().refine((n) => (PAGE_SIZES as readonly number[]).includes(n), 'Page size is 50, 100 or 200').optional(),
  filter: z.record(z.union([z.string(), z.array(z.string())])).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export interface ListMeta {
  total: number;
  nextCursor: string | null;
}
export interface ListResponse<T> {
  data: T[];
  meta: ListMeta;
}

// ─── Organisation ────────────────────────────────────────────────────────────

export const departmentSchema = z
  .object({ name: z.string().min(1).max(80), colour: z.string().max(40).default('chart-1') })
  .strict();

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

export const siteSchema = z
  .object({
    code: z.string().min(1).max(20).regex(/^[A-Z0-9-]+$/, 'Upper-case letters, digits and dashes'),
    name: z.string().min(1).max(120),
    state: z.string().min(1).max(60),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    radius_m: z.number().int().min(20).max(5000),
    project_id: uuid.nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .strict();

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
export type SalaryComponentInput = z.infer<typeof salaryComponentSchema>;

/**
 * Whatever is left of gross is the Special Allowance. A structure sent without
 * one gets one, last, so gross always adds up.
 */
export function withSpecialAllowance<T extends { seq: number; calc_type: CalcType; frequency: Frequency }>(components: T[], make: (seq: number) => T): T[] {
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
        withSpecialAllowance(cs, (seq) => ({ seq, name: SPECIAL_ALLOWANCE, calc_type: 'BALANCE', calc_value: 0, max_amount: null, frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: false, colour: `chart-${((seq - 1) % 5) + 1}` })),
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
    gratuity: gratuityRatesSchema,
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
    notice_days: z.number().int().min(0).max(180).default(30),
  })
  .strict();

export const employeeIdentitySchema = z
  .object({
    pan: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'PAN is 5 letters, 4 digits, 1 letter').nullable().optional(),
    aadhaar: z.string().regex(/^[0-9]{12}$/, 'Aadhaar is 12 digits').nullable().optional(),
    uan: z.string().regex(/^[0-9]{12}$/, 'UAN is 12 digits').nullable().optional(),
    esi_number: z.string().max(17).nullable().optional(),
    bank_account: z.string().regex(/^[0-9]{6,18}$/, 'Account number is 6–18 digits').nullable().optional(),
    bank_ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC is 11 characters, e.g. SBIN0001234').nullable().optional(),
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
    notice_served_days: z.number().int().min(0).max(365).optional(),
    exit_reason: z.enum(EXIT_REASONS),
    note: z.string().max(500).optional(),
  })
  .strict();

export const documentCreateSchema = z
  .object({
    doc_type: z.enum(DOCUMENT_TYPES),
    collected_on: isoDate,
    expires_on: isoDate.nullable().optional(),
  })
  .strict();

export const faceEnrolSchema = z
  .object({
    embedding: z.array(z.number()).min(64).max(1024),
    model_version: z.string().min(1).max(60),
    consent: z.literal(true, { errorMap: () => ({ message: 'Written consent is required before enrolment' }) }),
  })
  .strict();

// ─── Attendance ──────────────────────────────────────────────────────────────

export const overrideCreateSchema = z
  .object({
    employee_id: uuid,
    work_date: isoDate,
    status: z.enum(DAY_STATUSES),
    day_value: z.number().min(0).max(1).multipleOf(0.25),
    worked_min: z.number().int().min(0).max(24 * 60),
    ot_min: z.number().int().min(0).max(24 * 60),
    late_min: z.number().int().min(0).max(24 * 60),
    reason_code: z.enum(OVERRIDE_REASONS),
    reason_text: z.string().trim().min(8, 'Write at least eight characters explaining the correction').max(500),
  })
  .strict();

export const bulkOverrideSchema = z
  .object({
    items: z.array(z.object({ employee_id: uuid, work_date: isoDate }).strict()).min(1).max(500),
    status: z.enum(DAY_STATUSES),
    day_value: z.number().min(0).max(1).multipleOf(0.25),
    worked_min: z.number().int().min(0).max(24 * 60).optional(),
    ot_min: z.number().int().min(0).max(24 * 60).optional(),
    late_min: z.number().int().min(0).max(24 * 60).optional(),
    reason_code: z.enum(OVERRIDE_REASONS),
    reason_text: z.string().trim().min(8).max(500),
  })
  .strict();

export const punchIdentifySchema = z
  .object({
    embedding: z.array(z.number()).min(64).max(1024),
    lat: z.number(),
    lng: z.number(),
    accuracy_m: z.number().min(0),
  })
  .strict();

export const punchCreateSchema = z
  .object({
    employee_id: uuid.optional(),
    direction: z.enum(['IN', 'OUT']),
    client_punched_at: z.string().datetime({ offset: true }),
    lat: z.number(),
    lng: z.number(),
    accuracy_m: z.number().min(0),
    /** Signed token from /punches/identify proving the match happened server-side (live punches) */
    match_token: z.string().min(1).optional(),
    /** Offline-queued punches carry the embedding; the server matches it on sync */
    embedding: z.array(z.number()).min(64).max(1024).optional(),
    device_id: z.string().max(100),
    queued: z.boolean().default(false),
    snapshot: z.string().max(400_000).optional(),
  })
  .strict()
  .refine((v) => !!v.match_token || !!v.embedding, { message: 'A punch needs a match token or, when queued offline, the face embedding' });

export const faceExceptionCreateSchema = z
  .object({
    occurred_at: z.string().datetime({ offset: true }),
    claimed_employee_id: uuid.nullable().optional(),
    best_match_id: uuid.nullable().optional(),
    score: z.number().min(0).max(1).nullable().optional(),
    reason: z.string().min(1).max(200),
    lat: z.number(),
    lng: z.number(),
    accuracy_m: z.number().min(0),
    snapshot: z.string().max(400_000).optional(),
    direction: z.enum(['IN', 'OUT']).optional(),
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

export const leaveDecideSchema = z
  .object({ decision: z.enum(['APPROVE', 'REJECT', 'CANCEL']), note: z.string().max(500).optional() })
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

export const savedViewSchema = z
  .object({ list: z.string().min(1).max(40), name: z.string().min(1).max(80), query: z.string().max(2000) })
  .strict();
