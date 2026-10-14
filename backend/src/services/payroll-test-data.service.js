import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { Prisma } from '@prisma/client';
import { departmentSchema, employeeCoreSchema, employeeIdentitySchema, isoDate, overtimeRulesSchema } from '@ajpwer/shared';
import { toDbDate } from '../utils/dbDates.js';

// Explicit employee/test-history allowlist. Organisation, credentials, rules and models are not reset.
export const PAYROLL_TEST_HISTORY_MODELS = Object.freeze([
  'payslipLine', 'payslip', 'payrollExclusion', 'heldPay', 'settlement', 'salaryHold',
  'payrollPeriod', 'adhocItem', 'recoveryCarry', 'loan', 'advance',
  'leaveRequest', 'leaveAdjustment', 'leaveBalance', 'attendanceOverride',
  'punchAttempt', 'punchSession', 'faceRegistrationAuthorization', 'faceException',
  'siteChange', 'siteTransferRequest', 'employeeFace', 'punch', 'dailyAggregate',
  'offer', 'letter', 'document', 'onboardingTask', 'exitTask', 'employeeSalary',
  'employeeIdentity', 'employeeStatutory', 'employee', 'idempotencyKey', 'job',
]);
const PROTECTED_SETTINGS_MODELS = Object.freeze([
  'company', 'role', 'appUser', 'savedView', 'site', 'project', 'shift', 'holiday',
  'statutoryRates', 'ptSlab', 'taxRegime', 'taxSlab', 'policy', 'department',
]);
const EMPLOYEE_AUDIT_TYPES = Object.freeze([
  'employee', 'employee_identity', 'employee_salary', 'attendance_override', 'punch',
  'punch_session', 'punch_attempt', 'face_exception', 'site_change', 'site_transfer_request',
  'leave', 'leave_request', 'leave_adjustment', 'payroll', 'payroll_period', 'payslip',
  'settlement', 'loan', 'advance', 'adhoc_item', 'salary_hold', 'held_pay',
]);
// Fixed table names only; no uploaded value or CLI argument enters this SQL.
const RESET_TABLE_LOCK_SQL = `LOCK TABLE
  employee, employee_identity, employee_statutory, employee_salary, employee_face,
  face_registration_authorization, punch, punch_session, punch_attempt, face_exception,
  attendance_override, site_change, site_transfer_request, daily_aggregate,
  leave_request, leave_adjustment, leave_balance, offer, letter, document, onboarding_task,
  exit_task, payslip_line, payslip, payroll_exclusion, payroll_period, settlement,
  held_pay, salary_hold, advance, loan, recovery_carry, adhoc_item, job, idempotency_key,
  salary_component, salary_structure, pay_group_policy, pay_group, policy, department
  IN ACCESS EXCLUSIVE MODE`;

const json = (value) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
// Normalise before stringify: the API installs BigInt/Decimal.toJSON hooks lazily,
// and stringify calls those hooks before its replacer. Their presence is not a data change.
function canonicalValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Prisma.Decimal.isDecimal(value)) return value.toString();
  if (Buffer.isBuffer(value)) return { bytes: value.toString('base64') };
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}
const canonicalJson = (value) => JSON.stringify(canonicalValue(value));
const digest = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const rowDigest = (rows) => digest([...rows].sort((a, b) => String(a.id).localeCompare(String(b.id))));

/** Replacement is intentionally limited to an explicitly named local development database. */
export function developmentReplacementTarget({ databaseUrl, nodeEnv = 'development', confirmedDatabase, replaceDevelopmentData = false }) {
  if (nodeEnv !== 'development') throw new Error('Employee replacement is allowed only in development.');
  let url;
  try { url = new URL(databaseUrl); } catch { throw new Error('A valid PostgreSQL DATABASE_URL is required.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('The replacement target must be PostgreSQL.');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Employee replacement is limited to a local development database.');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database || database.includes('/')) throw new Error('The development database name is invalid.');
  if (!replaceDevelopmentData || confirmedDatabase !== database) {
    throw new Error('Apply requires --replace-development-data and --database matching the configured database exactly.');
  }
  return { database, host: url.hostname === '[::1]' ? '::1' : url.hostname, port: url.port || '5432',
    user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) };
}

/** Reject invalid input before opening any replacement transaction. Source employee codes are ignored. */
export function validatePayrollReplacementReport(report) {
  if (!report || !Array.isArray(report.records) || !Array.isArray(report.errors) || report.errors.length) {
    throw new Error('The employee workbook must pass validation before replacement.');
  }
  if (!report.records.length) throw new Error('No active employees were found. Existing data was not changed.');
  for (const person of report.records) {
    const valid = person.status === 'ACTIVE'
      && isoDate.safeParse(person.joined_on).success
      && employeeCoreSchema.shape.name.safeParse(person.name).success
      && employeeCoreSchema.shape.designation.safeParse(person.designation).success
      && employeeCoreSchema.shape.gender.safeParse(person.gender).success
      && (person.phone === '' || employeeCoreSchema.shape.phone.safeParse(person.phone).success)
      && employeeCoreSchema.shape.email.safeParse(person.email).success
      && employeeCoreSchema.shape.address.safeParse(person.address).success
      && employeeCoreSchema.shape.dob.safeParse(person.dob).success
      && departmentSchema.shape.name.safeParse(person.department).success
      && employeeIdentitySchema.safeParse(person.identity).success
      && typeof person.statutory?.pf_enabled === 'boolean'
      && typeof person.statutory?.esi_enabled === 'boolean'
      && typeof person.statutory?.pt_state === 'string' && person.statutory.pt_state.trim().length > 0;
    if (!valid) throw new Error(`Employee workbook row ${person.source_row ?? '?'} requires valid profile and statutory data.`);
    if (person.salary || person.attendance) throw new Error('Use the salary/attendance import workflow for supplied salary or attendance records.');
  }
  return { employee_rows: report.records.length, salary_rows: 0, attendance_rows: 0,
    missing_salary_rows: report.records.length, missing_attendance_rows: report.records.length };
}

/** Keep daily hours, timing, rounding and cap; use 2× Basic with the calendar-month divisor. */
export function payrollTestOvertimeRules(sourceRules) {
  const { components: _components, ...rules } = sourceRules ?? {};
  return overtimeRulesSchema.parse({ ...rules, base: 'BASIC', multiplier: 2, divisor: null });
}

async function protectedSettings(db, previous) {
  const snapshot = {};
  for (const model of PROTECTED_SETTINGS_MODELS) {
    const rows = await db[model].findMany(previous ? { where: { id: { in: previous[model].ids } } } : {});
    snapshot[model] = { count: rows.length, ids: rows.map((row) => row.id).sort(), hash: rowDigest(rows) };
  }
  return snapshot;
}

function onlyMatch(rows, description) {
  if (rows.length !== 1) throw new Error(`Choose exactly one available ${description}; existing data was not changed.`);
  return rows[0];
}

/** Read-only manifest. It contains counts and setup identifiers, never employee values. */
export async function planPayrollEmployeeReplacement(db, {
  report, payGroupName = 'Head office', structureName = 'Employee', fallbackStructureName = 'Site staff',
} = {}) {
  const imported = validatePayrollReplacementReport(report);
  if (await db.job.count({ where: { status: { in: ['QUEUED', 'RUNNING'] } } })) {
    throw new Error('Finish or cancel queued/running jobs and stop the backend/worker before replacing employee data.');
  }
  const group = onlyMatch(await db.payGroup.findMany({
    where: { name: { equals: payGroupName, mode: 'insensitive' }, deleted_at: null },
    include: { policies: { orderBy: { id: 'asc' }, include: { policy: true } } },
  }), 'pay group');
  let structures = await db.salaryStructure.findMany({
    where: { name: { equals: structureName, mode: 'insensitive' }, deleted_at: null },
    include: { components: { orderBy: { seq: 'asc' } } },
  });
  if (!structures.length && structureName.toLowerCase() === 'employee' && fallbackStructureName) {
    structures = await db.salaryStructure.findMany({
      where: { name: { equals: fallbackStructureName, mode: 'insensitive' }, deleted_at: null },
      include: { components: { orderBy: { seq: 'asc' } } },
    });
  }
  const structure = onlyMatch(structures, 'employee salary structure');
  if (!structure.components.some((component) => !component.deleted_at)) throw new Error('The retained salary structure has no active components.');
  const attachedOvertime = group.policies.filter((link) => !link.deleted_at && !link.policy.deleted_at
    && link.policy.kind === 'OVERTIME' && link.policy.status === 'ACTIVE')
    .map((link) => link.policy).sort((a, b) => b.valid_from - a.valid_from || b.version - a.version)[0];
  const overtime = attachedOvertime ?? await db.policy.findFirst({
    where: { kind: 'OVERTIME', status: 'ACTIVE', deleted_at: null },
    orderBy: [{ valid_from: 'desc' }, { version: 'desc' }],
  });
  if (!overtime) throw new Error('Configure an overtime timing policy before creating the payroll test group.');
  const overtime_rules = payrollTestOvertimeRules(overtime.rules);
  const existing_counts = {};
  for (const model of PAYROLL_TEST_HISTORY_MODELS) existing_counts[model] = await db[model].count();
  existing_counts.salaryStructure = await db.salaryStructure.count({ where: { id: { not: structure.id } } });
  existing_counts.salaryComponent = await db.salaryComponent.count({ where: { structure_id: { not: structure.id } } });
  existing_counts.payGroup = await db.payGroup.count({ where: { id: { not: group.id } } });
  const protected_settings = await protectedSettings(db);
  if (!protected_settings.company.count || !protected_settings.statutoryRates.count) throw new Error('Company and statutory setup must exist before employee replacement.');
  const selection = { pay_group_id: group.id, structure_id: structure.id, structure_name: structureName,
    original_structure_name: structure.name, source_overtime_id: overtime.id };
  // Both the SQL relation and the fingerprint itself are ordered: fake/alternative clients must also be deterministic.
  const orderedGroup = { ...group, policies: [...group.policies].sort((a, b) => String(a.id).localeCompare(String(b.id))) };
  const fingerprint_fields = Object.fromEntries(Object.entries({ existing_counts, selection, overtime_rules,
    protected_settings, group: orderedGroup, structure, records: report.records }).map(([key, value]) => [key, digest(value)]));
  return { ...imported, existing_counts, selection, calendar_method: 'ACTUAL', leave_policy: null, overtime_rules,
    protected_settings, group: orderedGroup, structure, source_overtime: overtime, fingerprint_fields,
    fingerprint: digest(fingerprint_fields) };
}

export function payrollReplacementSummary(plan) {
  return { employee_rows: plan.employee_rows, salary_rows: plan.salary_rows, attendance_rows: plan.attendance_rows,
    missing_salary_rows: plan.missing_salary_rows, missing_attendance_rows: plan.missing_attendance_rows,
    remove: plan.existing_counts, keep: Object.fromEntries(Object.entries(plan.protected_settings).map(([model, item]) => [model, item.count])),
    salary_structure: plan.selection.structure_name, rename_structure: plan.selection.original_structure_name !== plan.selection.structure_name,
    calendar_method: plan.calendar_method, leave_policy: null, overtime_rules: plan.overtime_rules };
}

async function verifyBackup(backup, target) {
  if (!backup?.verified || backup.database !== target.database || !backup.path || !backup.sha256) {
    throw new Error('A verified PostgreSQL backup of this database is required before replacement.');
  }
  const info = await lstat(backup.path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 32 || (info.mode & 0o077) !== 0) {
    throw new Error('The backup must be a nonempty private regular file.');
  }
  const file = await open(backup.path, 'r');
  try {
    const magic = Buffer.alloc(5);
    await file.read(magic, 0, 5, 0);
    if (magic.toString() !== 'PGDMP') throw new Error('The backup is not a PostgreSQL custom-format archive.');
  } finally { await file.close(); }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(backup.path)) hash.update(chunk);
  if (hash.digest('hex') !== backup.sha256) throw new Error('The backup changed after verification; existing data was not changed.');
}

/** Full development-only replacement, after a verified backup. All work rolls back on failure. */
export async function replacePayrollEmployeeData(db, { report, targetOptions, backup, plan: expectedPlan,
  payGroupName = 'Head office', structureName = 'Employee', fallbackStructureName = 'Site staff', beforeCommit } = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('Employee replacement is allowed only in development.');
  const target = developmentReplacementTarget(targetOptions);
  validatePayrollReplacementReport(report);
  await verifyBackup(backup, target);
  // Environment/key validation happens before deletion. These helpers match the ordinary employee importer.
  const { encryptPII, maskAadhaar } = await import('../utils/crypto.js');
  const { nextEmployeeCode } = await import('./employee.service.js');
  return db.$transaction(async (tx) => {
    const [connection] = await tx.$queryRaw`SELECT current_database() AS database`;
    if (connection?.database !== target.database) throw new Error('The connected database does not match the backed-up development target.');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ajpwer-employee-report-import'))`;
    await tx.$executeRawUnsafe(RESET_TABLE_LOCK_SQL);
    const plan = await planPayrollEmployeeReplacement(tx, { report, payGroupName, structureName, fallbackStructureName });
    if (expectedPlan && expectedPlan.fingerprint !== plan.fingerprint) {
      const changed = Object.keys(plan.fingerprint_fields).filter((key) => expectedPlan.fingerprint_fields?.[key] !== plan.fingerprint_fields[key]);
      const settings = Object.keys(plan.protected_settings).filter((key) => expectedPlan.protected_settings?.[key]?.hash !== plan.protected_settings[key].hash);
      throw new Error(`The development data changed after the backup plan${changed.length ? ` (${changed.join(', ')}${settings.length ? `; settings: ${settings.join(', ')}` : ''})` : ''}. Run the check and backup again.`);
    }
    // Existing guards stay installed. This transaction removes explicitly authorized test histories only.
    await tx.$executeRaw`SET LOCAL ajpwer.retention = 'on'`;
    await tx.payrollPeriod.updateMany({ data: { state: 'DRAFT' } });
    for (const model of PAYROLL_TEST_HISTORY_MODELS) await tx[model].deleteMany();
    await tx.auditLog.deleteMany({ where: { OR: [
      { entity_type: { in: EMPLOYEE_AUDIT_TYPES } },
      { action: { startsWith: 'export.' }, entity_type: 'report' },
      { action: 'pii.read', entity_type: 'report' },
    ] } });
    await tx.salaryComponent.deleteMany({ where: { structure_id: { not: plan.selection.structure_id } } });
    await tx.salaryStructure.deleteMany({ where: { id: { not: plan.selection.structure_id } } });
    await tx.payGroupPolicy.deleteMany({ where: { OR: [
      { pay_group_id: { not: plan.selection.pay_group_id } }, { policy: { kind: { in: ['LEAVE', 'OVERTIME'] } } },
    ] } });
    await tx.payGroup.deleteMany({ where: { id: { not: plan.selection.pay_group_id } } });
    await tx.salaryStructure.update({ where: { id: plan.selection.structure_id }, data: { name: structureName } });
    await tx.payGroup.update({ where: { id: plan.selection.pay_group_id }, data: { calendar_method: 'ACTUAL' } });
    const overtime = await tx.policy.create({ data: {
      policy_key: randomUUID(), kind: 'OVERTIME', name: 'Employee overtime 2× Basic', version: 1,
      valid_from: plan.source_overtime.valid_from, valid_to: null, rules: plan.overtime_rules,
      created_by: 'development-payroll-replacement',
    } });
    await tx.payGroupPolicy.create({ data: { pay_group_id: plan.selection.pay_group_id, policy_id: overtime.id } });
    const departments = new Map();
    const code_map = [];
    for (const person of report.records) {
      if (!departments.has(person.department)) {
        const department = await tx.department.upsert({ where: { name: person.department }, update: {},
          create: { name: person.department, colour: `chart-${departments.size % 5 + 1}` } });
        departments.set(person.department, department.id);
      }
      const code = await nextEmployeeCode(tx);
      const identity = person.identity;
      const employee = await tx.employee.create({ data: {
        code, name: person.name, status: 'ACTIVE', joined_on: toDbDate(person.joined_on),
        gender: person.gender, phone: person.phone, email: person.email, address: person.address,
        dob: person.dob ? toDbDate(person.dob) : null, designation: person.designation,
        department_id: departments.get(person.department), pay_group_id: plan.selection.pay_group_id, activated_at: new Date(),
        statutory: { create: { pf_enabled: person.statutory.pf_enabled, eps_enabled: true,
          esi_enabled: person.statutory.esi_enabled, pt_state: person.statutory.pt_state } },
        identity: { create: { pan_enc: encryptPII(identity.pan), aadhaar_enc: encryptPII(identity.aadhaar),
          aadhaar_masked: maskAadhaar(identity.aadhaar), uan: identity.uan, esi_number: identity.esi_number,
          bank_account_enc: encryptPII(identity.bank_account), bank_last4: identity.bank_account?.slice(-4) ?? null,
          bank_ifsc: identity.bank_ifsc, bank_name: identity.bank_name } },
      }, select: { id: true } });
      code_map.push({ source_row: person.source_row, source_code: person.source_code ?? person.code ?? null, code, employee_id: employee.id });
    }
    const after = await protectedSettings(tx, plan.protected_settings);
    if (json(after) !== json(plan.protected_settings)) throw new Error('Protected organisation or statutory settings changed; the replacement was rolled back.');
    const retainedComponents = await tx.salaryComponent.findMany({ where: { structure_id: plan.selection.structure_id } });
    if (rowDigest(retainedComponents) !== rowDigest(plan.structure.components)) throw new Error('The employee salary components changed; the replacement was rolled back.');
    await tx.auditLog.create({ data: { actor: 'development-payroll-replacement', action: 'employee.test_data.replace', entity_type: 'employee',
      detail: { imported_rows: report.records.length, active_only: true, generated_codes: true, calendar_method: 'ACTUAL',
        overtime_base: 'BASIC', overtime_multiplier: 2, leave_policy: null, salary_rows: 0, attendance_rows: 0,
        salary_structure_id: plan.selection.structure_id } } });
    const result = { ...payrollReplacementSummary(plan), imported_rows: code_map.length, code_map, backup_path: backup.path };
    // The CLI saves private code mapping/report files here. A write failure rolls back the database as well.
    if (beforeCommit) await beforeCommit(result);
    return result;
  }, { maxWait: 15_000, timeout: 180_000 });
}
