import { ONBOARDING_TASKS, POLICY_KINDS, POLICY_KIND_LABELS, POLICY_KIND_MISSING_WARNING } from '@ajpwer/shared';
import { pickPolicy } from '../calculations/index.js';
import { decryptPII, maskAccount, maskPan } from '../utils/crypto.js';
import { fromDbDate, n } from '../utils/dbDates.js';
import { payGroupRules, salaryOn } from './rules.service.js';

/** Next employee code: AJ0001, AJ0002, … */
export async function nextEmployeeCode(db) {
  const rows = await db.$queryRaw`
    SELECT MAX(NULLIF(regexp_replace(code, '\\D', '', 'g'), '')::int) AS max FROM employee WHERE code ~ '^AJ[0-9]+$'`;
  const next = (rows[0]?.max ?? 0) + 1;
  return `AJ${String(next).padStart(4, '0')}`;
}

export function loadEmployee(db, id) {
  return db.employee.findFirst({
    where: { id, deleted_at: null },
    include: {
      statutory: true,
      identity: true,
      department: { select: { id: true, name: true, colour: true } },
      pay_group: { select: { id: true, name: true, calendar_method: true, weekly_off: true, structure_id: true } },
      faces: { where: { deleted_at: null }, select: { enrolled_at: true, consent_at: true, model_version: true } },
      onboarding_tasks: true,
    },
  });
}

export function identityView(idn, full) {
  if (!idn) return { has_pan: false, has_aadhaar: false, has_bank: false, pan: null, aadhaar_masked: null, uan: null, esi_number: null, bank_account: null, bank_ifsc: null, bank_name: null };
  const pan = idn.pan_enc ? decryptPII(idn.pan_enc) : null;
  return {
    has_pan: !!idn.pan_enc,
    has_aadhaar: !!idn.aadhaar_enc,
    has_bank: !!(idn.bank_account_enc && idn.bank_ifsc),
    pan: full ? pan : maskPan(pan),
    aadhaar_masked: idn.aadhaar_masked,
    uan: idn.uan,
    esi_number: idn.esi_number,
    bank_account: full ? decryptPII(idn.bank_account_enc) : maskAccount(idn.bank_last4),
    bank_ifsc: idn.bank_ifsc,
    bank_name: idn.bank_name,
  };
}

export function onboardingView(tasks) {
  const items = ONBOARDING_TASKS.map((t) => {
    const row = tasks.find((x) => x.task_code === t.code);
    return { ...t, done_at: row?.done_at ?? null, done_by: row?.done_by ?? null };
  });
  const requiredLeft = items.filter((i) => i.required && !i.done_at).length;
  return { items, required_left: requiredLeft, done: items.filter((i) => i.done_at).length, total: items.length };
}

/**
 * "Rules that apply" — calendar, weekly off, shift, structure and every policy,
 * all read from the pay group. None of it is set on the person.
 */
export async function rulesThatApply(db, payGroupId, date) {
  const rules = await payGroupRules(db, payGroupId);
  const structure = await db.salaryStructure.findUnique({ where: { id: rules.structure_id }, select: { id: true, name: true } });
  const policies = POLICY_KINDS.map((kind) => {
    const p = pickPolicy(rules.policies, kind, date);
    return p
      ? { kind, label: POLICY_KIND_LABELS[kind], id: p.id, name: p.name, version: p.version, valid_from: p.valid_from, valid_to: p.valid_to, rules: p.rules, missing: null }
      : { kind, label: POLICY_KIND_LABELS[kind], id: null, name: null, version: null, valid_from: null, valid_to: null, rules: null, missing: POLICY_KIND_MISSING_WARNING[kind] };
  });
  return {
    pay_group: { id: rules.id, name: rules.name },
    calendar_method: rules.calendar_method,
    weekly_off: rules.weekly_off,
    shift: rules.shift,
    structure: structure ? { id: structure.id, name: structure.name } : null,
    policies,
  };
}

export async function employeeView(db, e, today, fullPii) {
  const salary = await salaryOn(db, e.id, today > fromDbDate(e.joined_on) ? today : fromDbDate(e.joined_on));
  return {
    id: e.id,
    code: e.code,
    name: e.name,
    dob: fromDbDate(e.dob),
    gender: e.gender,
    phone: e.phone,
    email: e.email,
    address: e.address,
    blood_group: e.blood_group,
    department: e.department,
    designation: e.designation,
    pay_group: e.pay_group,
    status: e.status,
    joined_on: fromDbDate(e.joined_on),
    resigned_on: fromDbDate(e.resigned_on),
    last_day: fromDbDate(e.last_day),
    notice_days: e.notice_days,
    notice_served_days: e.notice_served_days,
    exit_reason: e.exit_reason,
    activated_at: e.activated_at,
    updated_at: e.updated_at?.toISOString() ?? e.created_at.toISOString(),
    read_only: e.status === 'EXITED',
    identity: identityView(e.identity, fullPii),
    statutory: e.statutory
      ? {
          ...e.statutory,
          vpf_pct: Number(e.statutory.vpf_pct),
          esi_locked_until: fromDbDate(e.statutory.esi_locked_until),
          decl_80c: n(e.statutory.decl_80c),
          decl_80d: n(e.statutory.decl_80d),
          decl_rent_monthly: n(e.statutory.decl_rent_monthly),
        }
      : null,
    salary,
    face: e.faces[0] ? { enrolled: true, enrolled_at: e.faces[0].enrolled_at, consent_at: e.faces[0].consent_at, model_version: e.faces[0].model_version } : { enrolled: false },
    onboarding: onboardingView(e.onboarding_tasks),
  };
}

export async function markTask(db, employeeId, code, by) {
  await db.onboardingTask.upsert({
    where: { employee_id_task_code: { employee_id: employeeId, task_code: code } },
    update: { done_at: new Date(), done_by: by },
    create: { employee_id: employeeId, task_code: code, done_at: new Date(), done_by: by },
  });
}
