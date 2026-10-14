import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { invalidatePrincipal } from '../../src/middleware/auth.js';
import { decryptPII } from '../../src/utils/crypto.js';
import { toDbDate } from '../../src/utils/dbDates.js';
import {
  PAYROLL_TEST_HISTORY_MODELS, planPayrollEmployeeReplacement, replacePayrollEmployeeData,
} from '../../src/services/payroll-test-data.service.js';
import { buildFixture, R, YM } from './fixture.js';

let f;
let backup;
let privateDirectory;
let targetOptions;

const record = (changes = {}) => ({ source_row: 2, source_code: 'SOURCE-IGNORED', code: 'SOURCE-IGNORED',
  name: 'Replacement Example', status: 'ACTIVE', joined_on: '2025-01-01', designation: 'Engineer',
  gender: 'FEMALE', phone: '', department: 'Electrical', email: null, address: null, dob: null,
  identity: { pan: 'ABCDE1234F', aadhaar: '012345678901', uan: '001234567890',
    esi_number: '0012345678', bank_account: '0001234567', bank_ifsc: 'SBIN0001234', bank_name: 'Example Bank' },
  statutory: { pf_enabled: true, esi_enabled: false, pt_state: 'Andhra Pradesh' }, ...changes });
const report = (records = [record()]) => ({ records, errors: [] });
const sourceOvertime = { base: 'COMPONENTS', components: ['BASIC', 'HRA'], multiplier: 1.5, divisor: 26,
  hours_per_day: 9, after_min: 30, rounding_min: 15, monthly_cap_min: 3000, counts_from: 'SHIFT_END' };
const options = (changes = {}) => ({ report: report(), targetOptions, backup, ...changes });
const snapshot = (model) => prisma[model].findMany({ orderBy: { id: 'asc' } });
const protectedModels = ['company', 'appUser', 'role', 'site', 'project', 'shift', 'holiday',
  'statutoryRates', 'ptSlab', 'taxRegime', 'taxSlab', 'policy', 'department', 'savedView'];

beforeEach(async () => {
  f = await buildFixture();
  invalidatePrincipal();
  await prisma.payGroup.update({ where: { id: f.payGroupId }, data: { name: 'Head office' } });
  const overtime = await prisma.policy.create({ data: { policy_key: randomUUID(), kind: 'OVERTIME', name: 'Original overtime',
    version: 1, valid_from: toDbDate('2025-01-01'), rules: sourceOvertime } });
  await prisma.payGroupPolicy.create({ data: { pay_group_id: f.payGroupId, policy_id: overtime.id } });
  const url = new URL(process.env.DATABASE_URL);
  const database = decodeURIComponent(url.pathname.slice(1));
  targetOptions = { databaseUrl: process.env.DATABASE_URL, nodeEnv: 'development',
    confirmedDatabase: database, replaceDevelopmentData: true };
  privateDirectory = await mkdtemp(path.join(os.tmpdir(), 'payroll-reset-api-'));
  // Fixture-only receipt: this tests archive/mode/hash guards, not pg_restore itself.
  // Production CLI tests verify a real pg_dump separately; no fixture archive is restored.
  const archive = Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(64, 7)]);
  const backupPath = path.join(privateDirectory, 'fixture.dump');
  await writeFile(backupPath, archive, { mode: 0o600 });
  backup = { verified: true, database, path: backupPath, sha256: createHash('sha256').update(archive).digest('hex') };
});
afterEach(async () => { if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true }); });
afterAll(async () => { await prisma.$disconnect(); });

async function seedPaidPayrollAndHistory() {
  const period = await prisma.payrollPeriod.create({ data: { period_ym: YM, pay_group_id: f.payGroupId } });
  const slip = await prisma.payslip.create({ data: { period_id: period.id, employee_id: f.employees.A,
    gross: R(20000), salary_gross: R(20000), total_deductions: R(1400), reimbursements: 0,
    net: R(18600), employer_total: R(1200), ctc_month: R(21200), pf_wage: R(10000),
    esi_applicable: false, paid_days: 26, lop_days: 0, divisor: 26, meta: { employee_name: 'Person A' },
    computed_at: new Date(), engine_version: 'fixture',
    lines: { create: { seq: 1, kind: 'COMPONENT', code: 'BASIC', name: 'Basic', full_amount: R(10000),
      amount: R(10000), is_taxable: true, counts_as_wages: true } } } });
  await prisma.payrollPeriod.update({ where: { id: period.id }, data: { state: 'PAID', payment_ref: 'OLD-TEST-PAID', paid_at: new Date() } });
  await prisma.payrollExclusion.create({ data: { period_id: period.id, employee_id: f.employees.OFFER, reason: 'Old exclusion' } });
  const hold = await prisma.salaryHold.create({ data: { employee_id: f.employees.A, from_ym: YM, reason: 'Old hold', created_by: 'fixture' } });
  const settlement = await prisma.settlement.create({ data: { employee_id: f.employees.A, last_day: toDbDate(`${YM}-31`),
    period_id: period.id, earnings: [], deductions: [], total_earnings: R(100), total_deductions: 0, net: R(100) } });
  await prisma.heldPay.create({ data: { hold_id: hold.id, employee_id: f.employees.A, period_ym: YM,
    amount: R(100), state: 'PAID', settlement_id: settlement.id } });
  await prisma.adhocItem.create({ data: { period_ym: YM, kind: 'EARNING', name: 'Old company-wide ad hoc',
    amount: R(100), is_taxable: true, target_type: 'ALL', target_ids: [], note: 'Old fixture' } });
  await prisma.recoveryCarry.create({ data: { employee_id: f.employees.A, period_ym: YM, amount: R(10) } });
  await prisma.advance.create({ data: { employee_id: f.employees.A, amount: R(100), reason: 'Old advance',
    granted_on: toDbDate(`${YM}-01`), instalment: R(50) } });
  await prisma.loan.create({ data: { employee_id: f.employees.A, loan_type: 'Old loan', principal: R(100),
    months: 2, emi: R(50), started_on: toDbDate(`${YM}-01`) } });
  const face = await prisma.employeeFace.create({ data: { employee_id: f.employees.A,
    embedding: Buffer.alloc(512, 1), model_version: 'fixture-model', consent_at: new Date() } });
  const authorization = await prisma.faceRegistrationAuthorization.create({ data: { employee_id: f.employees.A,
    reason: 'Old fixture approval', approved_by: 'fixture', expires_at: new Date('2027-01-01') } });
  const session = await prisma.punchSession.create({ data: { site_id: f.siteId, employee_id: f.employees.A,
    purpose: 'REGISTER', state: { employee_name: 'Person A' }, face_registration_authorization_id: authorization.id } });
  await prisma.punchAttempt.create({ data: { session_id: session.id, site_id: f.siteId, employee_id: f.employees.A,
    request_id: 'old-attempt', purpose: 'REGISTER', outcome: 'REGISTERED', tries_after: 0,
    reply: { employee_name: 'Person A' } } });
  await prisma.faceException.create({ data: { site_id: f.siteId, occurred_at: new Date(), reason: 'Old exception',
    claimed_employee_id: f.employees.A, best_match_id: f.employees.B, claimed_name: 'Person A', session_id: session.id } });
  const punch = await prisma.punch.findFirstOrThrow({ where: { employee_id: f.employees.A, direction: 'OUT' } });
  const destination = await prisma.site.create({ data: { code: 'BETA', name: 'Beta', state: 'Andhra Pradesh', lat: 16.5,
    lng: 80.6, radius_m: 400, login: 'site-beta', password_hash: 'fixture-preserved-password-hash' } });
  await prisma.siteChange.create({ data: { employee_id: f.employees.A, work_date: punch.work_date,
    from_site_id: f.siteId, to_site_id: destination.id, out_punch_id: punch.id, left_at: punch.punched_at } });
  await prisma.siteTransferRequest.create({ data: { employee_id: f.employees.A, from_site_id: f.siteId,
    to_site_id: destination.id, departure_date: toDbDate(`${YM}-04`), reason: 'Old transfer', requested_by: 'fixture' } });
  await prisma.attendanceOverride.create({ data: { employee_id: f.employees.A, work_date: toDbDate(`${YM}-03`),
    status: 'PRESENT', day_value: 1, worked_min: 480, ot_min: 0, late_min: 0, reason_code: 'DATA_ERROR',
    reason_text: 'Old correction', created_by: 'fixture', computed_snapshot: {} } });
  await prisma.leaveRequest.create({ data: { employee_id: f.employees.A, leave_type: 'CL', from_date: toDbDate(`${YM}-04`),
    to_date: toDbDate(`${YM}-04`), days: 1, status: 'APPROVED' } });
  await prisma.leaveAdjustment.create({ data: { employee_id: f.employees.A, leave_type: 'CL', date: toDbDate(`${YM}-01`),
    days: 1, reason: 'Old adjustment' } });
  await prisma.leaveBalance.create({ data: { employee_id: f.employees.A, leave_type: 'CL', year: 2026, accrued: 12, used: 1 } });
  await prisma.dailyAggregate.create({ data: { date: toDbDate(`${YM}-03`), site_id: f.siteId, headcount: 5, data: { employee_name: 'Person A' } } });
  await prisma.onboardingTask.create({ data: { employee_id: f.employees.A, task_code: 'PERSONAL' } });
  await prisma.exitTask.create({ data: { employee_id: f.employees.A, task_code: 'CLEARANCE' } });
  await prisma.document.create({ data: { employee_id: f.employees.A, doc_type: 'PAN', collected_on: toDbDate(`${YM}-01`), file_key: 'fixture-no-file' } });
  await prisma.letter.create({ data: { employee_id: f.employees.A, kind: 'JOINING', ref: 'OLD-LETTER', snapshot: { employee_name: 'Person A' } } });
  await prisma.offer.create({ data: { employee_id: f.employees.OFFER, ref: 'OLD-OFFER', mode: 'GROSS', amount: R(18000),
    monthly_gross: R(18000), structure_id: f.structureId, issued_on: toDbDate(`${YM}-01`), join_by: toDbDate(`${YM}-02`), valid_till: toDbDate(`${YM}-31`) } });
  await prisma.job.create({ data: { kind: 'payroll.run', status: 'DONE', params: { ym: YM }, result: { employee_name: 'Person A' } } });
  await prisma.idempotencyKey.create({ data: { key: 'old-key', scope: 'payroll.run:fixture', status_code: 202, response: { employee_name: 'Person A' } } });
  await prisma.auditLog.create({ data: { actor: 'fixture', action: 'employee.update', entity_type: 'employee', entity_id: f.employees.A,
    detail: { employee_name: 'Person A' } } });
  const preservedAudit = await prisma.auditLog.create({ data: { actor: 'fixture', action: 'site.update', entity_type: 'site', entity_id: f.siteId, detail: { field: 'radius_m' } } });
  return { period, slip, face, punch, preservedAudit };
}

describe('development payroll test-data replacement', () => {
  it('removes paid history and old face/punch records while preserving settings, credentials and retained components', async () => {
    const old = await seedPaidPayrollAndHistory();
    const group = await prisma.payGroup.findUniqueOrThrow({ where: { id: f.payGroupId } });
    const unused = await prisma.salaryStructure.create({ data: { name: 'Obsolete sample', components: { create:
      { seq: 1, name: 'Basic', calc_type: 'FIXED', calc_value: 10000, counts_as_wages: true } } } });
    await prisma.payGroup.create({ data: { name: 'Obsolete sample group', calendar_method: 'FIXED_30',
      weekly_off: ['SAT'], shift_id: group.shift_id } });
    const settings = Object.fromEntries(await Promise.all(protectedModels.map(async (model) => [model, await snapshot(model)])));
    const components = await prisma.salaryComponent.findMany({ where: { structure_id: f.structureId }, orderBy: { id: 'asc' } });
    const employeesBefore = await snapshot('employee');
    const source = report([record(), record({ source_row: 3, name: 'Second Replacement', phone: '9000000000',
      statutory: { pf_enabled: false, esi_enabled: true, pt_state: 'Andhra Pradesh' } })]);
    const plan = await planPayrollEmployeeReplacement(prisma, { report: source });
    expect(plan.existing_counts).toMatchObject({ employee: 5, payslip: 1, employeeFace: 1, punchSession: 1,
      faceRegistrationAuthorization: 1, payslipLine: 1, heldPay: 1, settlement: 1, salaryStructure: 1, payGroup: 1 });
    const replaced = await replacePayrollEmployeeData(prisma, options({ report: source, plan }));
    expect(replaced).toMatchObject({ imported_rows: 2, salary_rows: 0, attendance_rows: 0,
      missing_salary_rows: 2, missing_attendance_rows: 2, salary_structure: 'Employee', calendar_method: 'ACTUAL', leave_policy: null });
    expect(replaced.code_map.map((entry) => entry.code)).toEqual(['AJ0001', 'AJ0002']);
    expect(replaced.code_map.map((entry) => entry.source_code)).toEqual(['SOURCE-IGNORED', 'SOURCE-IGNORED']);
    const imported = await prisma.employee.findMany({ orderBy: { code: 'asc' }, include: { statutory: true, identity: true } });
    expect(imported).toHaveLength(2);
    for (const employee of imported) {
      expect(employee.status).toBe('ACTIVE');
      expect(employee.pay_group_id).toBe(f.payGroupId);
      expect(employeesBefore.map((row) => row.id)).not.toContain(employee.id);
      expect(employee.statutory.eps_enabled).toBe(true);
      expect(decryptPII(employee.identity.pan_enc)).toBe('ABCDE1234F');
      expect(decryptPII(employee.identity.bank_account_enc)).toBe('0001234567');
      expect(employee.identity.aadhaar_masked).toBe('XXXX XXXX 8901');
    }
    expect(imported[0].phone).toBe('');
    expect(imported[0].statutory).toMatchObject({ pf_enabled: true, esi_enabled: false });
    expect(imported[1].statutory).toMatchObject({ pf_enabled: false, esi_enabled: true });
    for (const model of PAYROLL_TEST_HISTORY_MODELS) {
      if (!['employee', 'employeeIdentity', 'employeeStatutory'].includes(model)) expect(await prisma[model].count(), model).toBe(0);
    }
    for (const model of protectedModels) {
      const originalIds = settings[model].map((row) => row.id);
      const kept = await prisma[model].findMany({ where: { id: { in: originalIds } }, orderBy: { id: 'asc' } });
      expect(kept, model).toEqual(settings[model]);
    }
    expect(await prisma.salaryStructure.findMany()).toMatchObject([{ id: f.structureId, name: 'Employee' }]);
    expect(await prisma.salaryStructure.findUnique({ where: { id: unused.id } })).toBeNull();
    expect(await prisma.salaryComponent.findMany({ where: { structure_id: f.structureId }, orderBy: { id: 'asc' } })).toEqual(components);
    const configured = await prisma.payGroup.findUniqueOrThrow({ where: { id: f.payGroupId }, include: { policies: { include: { policy: true } } } });
    expect(configured).toMatchObject({ calendar_method: 'ACTUAL', weekly_off: group.weekly_off, shift_id: group.shift_id, pay_day: group.pay_day });
    expect(configured.policies.some((link) => link.policy.kind === 'LEAVE')).toBe(false);
    expect(configured.policies.find((link) => link.policy.kind === 'OVERTIME').policy.rules).toEqual({
      base: 'BASIC', multiplier: 2, divisor: null, hours_per_day: 9, after_min: 30,
      rounding_min: 15, monthly_cap_min: 3000, counts_from: 'SHIFT_END' });
    expect(await prisma.auditLog.findUnique({ where: { id: old.preservedAudit.id } })).toEqual(old.preservedAudit);
    expect(await prisma.auditLog.count({ where: { action: 'employee.update' } })).toBe(0);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'employee.test_data.replace' } });
    expect(audit.detail).toMatchObject({ imported_rows: 2, salary_rows: 0, attendance_rows: 0, generated_codes: true });
    expect(JSON.stringify(audit.detail)).not.toContain('Replacement Example');
    await expect(prisma.auditLog.delete({ where: { id: audit.id } })).rejects.toThrow(/insert-only/);
    const at = new Date('2026-08-03T03:30:00Z');
    const newPunch = await prisma.punch.create({ data: { employee_id: imported[0].id, site_id: f.siteId, direction: 'IN',
      punched_at: at, client_punched_at: at, work_date: toDbDate('2026-08-03'), method: 'MANUAL' } });
    await expect(prisma.punch.delete({ where: { id: newPunch.id } })).rejects.toThrow(/append-only/);
    const login = await f.agent.get('/api/v1/auth/me');
    expect(login.status).toBe(200);
  });

  it('rolls the complete replacement back when saving the private mapping fails before commit', async () => {
    const old = await seedPaidPayrollAndHistory();
    const employees = await snapshot('employee');
    const components = await snapshot('salaryComponent');
    const policies = await snapshot('policy');
    const counts = Object.fromEntries(await Promise.all(PAYROLL_TEST_HISTORY_MODELS.map(async (model) => [model, await prisma[model].count()])));
    await expect(replacePayrollEmployeeData(prisma, options({ beforeCommit: async () => { throw new Error('Private mapping write failed'); } })))
      .rejects.toThrow('Private mapping write failed');
    expect(await snapshot('employee')).toEqual(employees);
    expect(await snapshot('salaryComponent')).toEqual(components);
    expect(await snapshot('policy')).toEqual(policies);
    expect(await prisma.payrollPeriod.findUniqueOrThrow({ where: { id: old.period.id } })).toMatchObject({ state: 'PAID', payment_ref: 'OLD-TEST-PAID' });
    expect(await prisma.payslip.findUniqueOrThrow({ where: { id: old.slip.id } })).toMatchObject({ gross: BigInt(R(20000)) });
    for (const [model, count] of Object.entries(counts)) expect(await prisma[model].count(), model).toBe(count);
    expect(await prisma.auditLog.count({ where: { action: 'employee.test_data.replace' } })).toBe(0);
    await expect(prisma.payslip.delete({ where: { id: old.slip.id } })).rejects.toThrow(/PAID period/);
    await expect(prisma.punch.delete({ where: { id: old.punch.id } })).rejects.toThrow(/append-only/);
  });

  it('refuses a changed plan or an active job before deleting any old data', async () => {
    const plan = await planPayrollEmployeeReplacement(prisma, { report: report() });
    await prisma.site.update({ where: { id: f.siteId }, data: { radius_m: 450 } });
    await expect(replacePayrollEmployeeData(prisma, options({ plan }))).rejects.toThrow(/data changed after the backup plan/);
    expect(await prisma.employee.count()).toBe(5);
    expect(await prisma.punch.count()).toBeGreaterThan(0);
    await prisma.job.create({ data: { kind: 'payroll.run', status: 'RUNNING', params: { ym: YM } } });
    await expect(replacePayrollEmployeeData(prisma, options())).rejects.toThrow(/queued\/running jobs/);
    expect(await prisma.employee.count()).toBe(5);
    expect(await prisma.salaryStructure.count()).toBe(1);
  });

  it('refuses missing, altered or public backups and mismatched actual connections without touching employees', async () => {
    await expect(replacePayrollEmployeeData(prisma, options({ backup: { ...backup, verified: false } }))).rejects.toThrow(/verified PostgreSQL backup/);
    await expect(replacePayrollEmployeeData(prisma, options({ backup: { ...backup, sha256: '0'.repeat(64) } }))).rejects.toThrow(/backup changed/);
    await chmod(backup.path, 0o644);
    await expect(replacePayrollEmployeeData(prisma, options())).rejects.toThrow(/private regular file/);
    await chmod(backup.path, 0o600);
    const otherUrl = new URL(process.env.DATABASE_URL);
    otherUrl.pathname = '/different_local_database';
    await expect(replacePayrollEmployeeData(prisma, options({ targetOptions: { ...targetOptions,
      databaseUrl: otherUrl.toString(), confirmedDatabase: 'different_local_database' },
      backup: { ...backup, database: 'different_local_database' } }))).rejects.toThrow(/connected database does not match/);
    expect(await prisma.employee.count()).toBe(5);
    expect(await prisma.punch.count()).toBeGreaterThan(0);
    expect(await prisma.employeeSalary.count()).toBe(5);
  });
});
