import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  developmentReplacementTarget, PAYROLL_TEST_HISTORY_MODELS, payrollReplacementSummary,
  payrollTestOvertimeRules, planPayrollEmployeeReplacement, validatePayrollReplacementReport,
} from '../../src/services/payroll-test-data.service.js';

const targetOptions = (changes = {}) => ({ databaseUrl: 'postgresql://preview:secret@127.0.0.1:5432/employee_preview',
  nodeEnv: 'development', confirmedDatabase: 'employee_preview', replaceDevelopmentData: true, ...changes });
const person = (changes = {}) => ({ source_row: 2, name: 'Replacement Example', status: 'ACTIVE',
  joined_on: '2025-01-01', designation: 'Engineer', gender: 'FEMALE', phone: '', department: 'Electrical',
  identity: { pan: 'ABCDE1234F', bank_account: '0001234567', bank_ifsc: 'SBIN0001234' },
  statutory: { pf_enabled: true, esi_enabled: false, pt_state: 'Andhra Pradesh' }, ...changes });
const report = (records = [person()], errors = []) => ({ records, errors });
const overtimeRules = (changes = {}) => ({ base: 'COMPONENTS', components: ['BASIC', 'HRA', 'DA'],
  multiplier: 1.5, divisor: 26, hours_per_day: 9, after_min: 40, rounding_min: 15,
  monthly_cap_min: 3120, counts_from: 'SHIFT_END', ...changes });

const protectedModels = ['company', 'role', 'appUser', 'savedView', 'site', 'project', 'shift', 'holiday',
  'statutoryRates', 'ptSlab', 'taxRegime', 'taxSlab', 'policy', 'department'];

/** A read-only database double: any attempted write fails instead of passing silently. */
function readOnlyDatabase({ names = ['Employee', 'Site staff'], activeJobs = 0, attached = true } = {}) {
  const policy = { id: 'original-ot', kind: 'OVERTIME', name: 'Existing overtime', status: 'ACTIVE',
    deleted_at: null, version: 1, valid_from: new Date('2025-01-01'), rules: overtimeRules() };
  const structures = names.map((name, i) => ({ id: `structure-${i}`, name,
    components: [{ id: `component-${i}`, seq: 1, name: 'Basic', deleted_at: null,
      counts_as_wages: true, counts_as_esi_wages: true }] }));
  const group = { id: 'group-main', name: 'Head office', calendar_method: 'FIXED_26',
    policies: attached ? [{ id: 'link-ot', deleted_at: null, policy }] : [] };
  const rows = Object.fromEntries(protectedModels.map((model) => [model, [{ id: `${model}-original` }]]));
  rows.policy = [policy];
  rows.site[0].password_hash = 'protected-site-password-hash';
  const write = vi.fn(() => { throw new Error('The manifest attempted a write.'); });
  const db = { $transaction: write, $executeRaw: write, $executeRawUnsafe: write };
  for (const model of new Set([...PAYROLL_TEST_HISTORY_MODELS, ...protectedModels, 'payGroup', 'salaryStructure', 'salaryComponent'])) {
    db[model] = { count: vi.fn(async () => 3), findMany: vi.fn(async () => rows[model] ?? []),
      create: write, update: write, updateMany: write, deleteMany: write, upsert: write };
  }
  db.job.count.mockImplementation(async (query) => query?.where?.status ? activeJobs : 3);
  db.payGroup.findMany.mockImplementation(async ({ where }) => group.name.toLowerCase() === where.name.equals.toLowerCase() ? [group] : []);
  db.payGroup.count.mockResolvedValue(2);
  db.salaryStructure.findMany.mockImplementation(async ({ where }) => structures.filter((row) => row.name.toLowerCase() === where.name.equals.toLowerCase()));
  db.salaryStructure.count.mockImplementation(async ({ where }) => structures.filter((row) => row.id !== where.id.not).length);
  db.salaryComponent.count.mockResolvedValue(4);
  db.policy.findFirst = vi.fn(async () => policy);
  return { db, write, group, policy, structures, rows };
}

describe('development employee replacement target', () => {
  it.each(['127.0.0.1', 'localhost', '[::1]'])('accepts an explicitly confirmed local PostgreSQL database on %s', (host) => {
    expect(developmentReplacementTarget(targetOptions({ databaseUrl: `postgresql://preview:secret@${host}:5444/employee_preview` })))
      .toEqual({ database: 'employee_preview', host: host === '[::1]' ? '::1' : host, port: '5444', user: 'preview', password: 'secret' });
  });

  it('decodes database names and credentials and defaults the PostgreSQL port', () => {
    expect(developmentReplacementTarget(targetOptions({ databaseUrl: 'postgres://user%20name:secret%40value@localhost/employee%20preview',
      confirmedDatabase: 'employee preview' })))
      .toEqual({ database: 'employee preview', host: 'localhost', port: '5432', user: 'user name', password: 'secret@value' });
  });

  it.each([
    [{ nodeEnv: 'production' }, /only in development/],
    [{ nodeEnv: 'test' }, /only in development/],
    [{ databaseUrl: 'postgres://user:secret@database.example/employee_preview' }, /local development/],
    [{ databaseUrl: 'postgres://user:secret@localhost.example/employee_preview' }, /local development/],
    [{ databaseUrl: 'https://localhost/employee_preview' }, /must be PostgreSQL/],
    [{ databaseUrl: 'not a connection URL' }, /valid PostgreSQL/],
    [{ databaseUrl: 'postgres://localhost/' }, /database name is invalid/],
    [{ databaseUrl: 'postgres://localhost/employee%2Fpreview', confirmedDatabase: 'employee/preview' }, /database name is invalid/],
    [{ confirmedDatabase: 'other_database' }, /matching.*exactly/],
    [{ confirmedDatabase: 'EMPLOYEE_PREVIEW' }, /matching.*exactly/],
    [{ replaceDevelopmentData: false }, /replace-development-data/],
  ])('refuses an unsafe or unconfirmed replacement target %#', (changes, message) => {
    expect(() => developmentReplacementTarget(targetOptions(changes))).toThrow(message);
  });
});

describe('replacement workbook validation', () => {
  it('accepts active profiles without source codes or phone numbers and reports salary and attendance as missing', () => {
    const input = report([person(), person({ source_row: 3, phone: '9000000000', code: 'duplicate-source', source_code: 'duplicate-source' })]);
    const before = JSON.stringify(input);
    expect(validatePayrollReplacementReport(input)).toEqual({ employee_rows: 2, salary_rows: 0, attendance_rows: 0,
      missing_salary_rows: 2, missing_attendance_rows: 2 });
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([null, {}, { records: [], errors: [] }, report([person()], [{ row: 2, field: 'name' }])])
    ('refuses missing, empty or invalid workbooks %#', (input) => {
      expect(() => validatePayrollReplacementReport(input)).toThrow(/workbook|No active employees/);
    });

  it.each([
    { status: 'EXITED' }, { status: 'OFFER' }, { joined_on: '2025-02-30' }, { name: '' },
    { designation: '' }, { gender: 'UNKNOWN' }, { department: '' }, { phone: 'invalid-phone' },
    { identity: { pan: 'bad' } }, { statutory: { pf_enabled: 'yes', esi_enabled: false, pt_state: 'Andhra Pradesh' } },
    { statutory: { pf_enabled: true, esi_enabled: false, pt_state: '' } },
  ])('refuses incomplete or inactive employee records without leaking employee values %#', (changes) => {
    let message;
    try { validatePayrollReplacementReport(report([person(changes)])); } catch (error) { message = error.message; }
    expect(message).toMatch(/row 2 requires valid profile and statutory data/);
    expect(message).not.toContain('Replacement Example');
    expect(message).not.toContain('ABCDE1234F');
    expect(message).not.toContain('0001234567');
  });

  it.each([{ salary: { amount: 20000 } }, { attendance: { worked_days: 25 } }])
    ('requires the separate import workflow for supplied salary or attendance %#', (changes) => {
      expect(() => validatePayrollReplacementReport(report([person(changes)]))).toThrow(/salary\/attendance import workflow/);
    });
});

describe('requested test overtime configuration', () => {
  it('uses 2× Basic and the calendar-month divisor without changing configured hours, thresholds, rounding or cap', () => {
    const source = overtimeRules();
    const before = structuredClone(source);
    expect(payrollTestOvertimeRules(source)).toEqual({ base: 'BASIC', multiplier: 2, divisor: null,
      hours_per_day: 9, after_min: 40, rounding_min: 15, monthly_cap_min: 3120, counts_from: 'SHIFT_END' });
    expect(source).toEqual(before);
  });

  it('keeps an uncapped standard-day timing policy and rejects missing timing settings', () => {
    expect(payrollTestOvertimeRules(overtimeRules({ monthly_cap_min: null, counts_from: 'STANDARD_DAY' })))
      .toMatchObject({ monthly_cap_min: null, counts_from: 'STANDARD_DAY' });
    expect(() => payrollTestOvertimeRules()).toThrow();
    expect(() => payrollTestOvertimeRules(overtimeRules({ hours_per_day: 0 }))).toThrow();
  });
});

describe('read-only employee replacement manifest', () => {
  it('keeps the selected Employee structure, records protected setup counts and returns a safe summary', async () => {
    const fixture = readOnlyDatabase();
    const input = report();
    const plan = await planPayrollEmployeeReplacement(fixture.db, { report: input });
    expect(plan.selection).toMatchObject({ pay_group_id: 'group-main', structure_id: 'structure-0',
      structure_name: 'Employee', original_structure_name: 'Employee', source_overtime_id: 'original-ot' });
    expect(plan).toMatchObject({ calendar_method: 'ACTUAL', leave_policy: null, missing_salary_rows: 1, missing_attendance_rows: 1 });
    expect(plan.existing_counts).toMatchObject({ employee: 3, employeeFace: 3, punch: 3, payslip: 3,
      salaryStructure: 1, salaryComponent: 4, payGroup: 2 });
    expect(plan.protected_settings.site).toMatchObject({ count: 1, ids: ['site-original'] });
    expect(plan.protected_settings.statutoryRates.count).toBe(1);
    expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const summary = payrollReplacementSummary(plan);
    expect(summary).toMatchObject({ salary_structure: 'Employee', rename_structure: false, salary_rows: 0,
      attendance_rows: 0, keep: { company: 1, site: 1, statutoryRates: 1, policy: 1 } });
    const serialized = JSON.stringify(summary);
    for (const value of ['Replacement Example', 'ABCDE1234F', '0001234567', 'protected-site-password-hash', 'structure-0', 'group-main']) {
      expect(serialized).not.toContain(value);
    }
    expect(fixture.write).not.toHaveBeenCalled();
    expect(fixture.db.policy.findFirst).not.toHaveBeenCalled();
  });

  it('falls back to Site staff only when Employee is unavailable and marks the rename', async () => {
    const fixture = readOnlyDatabase({ names: ['Site staff'], attached: false });
    const plan = await planPayrollEmployeeReplacement(fixture.db, { report: report() });
    expect(plan.selection).toMatchObject({ structure_name: 'Employee', original_structure_name: 'Site staff', structure_id: 'structure-0' });
    expect(payrollReplacementSummary(plan).rename_structure).toBe(true);
    expect(fixture.db.policy.findFirst).toHaveBeenCalledOnce();
    expect(fixture.write).not.toHaveBeenCalled();
  });

  it.each([{ names: ['Employee', 'employee'] }, { names: [] }])('refuses ambiguous or missing structures %#', async ({ names }) => {
    const fixture = readOnlyDatabase({ names });
    await expect(planPayrollEmployeeReplacement(fixture.db, { report: report() })).rejects.toThrow(/exactly one.*salary structure/);
    expect(fixture.write).not.toHaveBeenCalled();
  });

  it('does not silently use a fallback when an explicit different structure was requested', async () => {
    const fixture = readOnlyDatabase({ names: ['Site staff'] });
    await expect(planPayrollEmployeeReplacement(fixture.db, { report: report(), structureName: 'Office' }))
      .rejects.toThrow(/exactly one.*salary structure/);
  });

  it('refuses missing/ambiguous groups, empty components or missing overtime and statutory setup', async () => {
    const missingGroup = readOnlyDatabase();
    await expect(planPayrollEmployeeReplacement(missingGroup.db, { report: report(), payGroupName: 'Missing group' })).rejects.toThrow(/exactly one.*pay group/);
    const ambiguousGroup = readOnlyDatabase();
    ambiguousGroup.db.payGroup.findMany.mockResolvedValue([ambiguousGroup.group, { ...ambiguousGroup.group, id: 'group-duplicate' }]);
    await expect(planPayrollEmployeeReplacement(ambiguousGroup.db, { report: report() })).rejects.toThrow(/exactly one.*pay group/);
    const emptyStructure = readOnlyDatabase();
    emptyStructure.structures[0].components[0].deleted_at = new Date();
    await expect(planPayrollEmployeeReplacement(emptyStructure.db, { report: report() })).rejects.toThrow(/no active components/);
    const missingOvertime = readOnlyDatabase({ attached: false });
    missingOvertime.db.policy.findFirst.mockResolvedValue(null);
    await expect(planPayrollEmployeeReplacement(missingOvertime.db, { report: report() })).rejects.toThrow(/overtime timing policy/);
    const missingRates = readOnlyDatabase();
    missingRates.rows.statutoryRates = [];
    await expect(planPayrollEmployeeReplacement(missingRates.db, { report: report() })).rejects.toThrow(/Company and statutory setup/);
  });

  it('rejects active jobs before inspecting replacement selections', async () => {
    const fixture = readOnlyDatabase({ activeJobs: 1 });
    await expect(planPayrollEmployeeReplacement(fixture.db, { report: report() })).rejects.toThrow(/queued\/running jobs/);
    expect(fixture.db.payGroup.findMany).not.toHaveBeenCalled();
    expect(fixture.write).not.toHaveBeenCalled();
  });

  it('ignores inactive attached policies and chooses the newest active attached overtime version', async () => {
    const fixture = readOnlyDatabase();
    const newer = { ...fixture.policy, id: 'newer-ot', version: 2, valid_from: new Date('2026-01-01'),
      rules: overtimeRules({ hours_per_day: 8, monthly_cap_min: null }) };
    fixture.group.policies.push({ deleted_at: null, policy: newer },
      { deleted_at: new Date(), policy: { ...newer, id: 'deleted-link', version: 10 } },
      { deleted_at: null, policy: { ...newer, id: 'retired-ot', status: 'RETIRED', version: 20 } });
    const plan = await planPayrollEmployeeReplacement(fixture.db, { report: report() });
    expect(plan.selection.source_overtime_id).toBe('newer-ot');
    expect(plan.overtime_rules).toMatchObject({ base: 'BASIC', multiplier: 2, divisor: null, hours_per_day: 8, monthly_cap_min: null });
  });

  it('changes the fingerprint when source records or protected settings change without exposing values', async () => {
    const fixture = readOnlyDatabase();
    const first = await planPayrollEmployeeReplacement(fixture.db, { report: report() });
    const changedEmployee = await planPayrollEmployeeReplacement(fixture.db, { report: report([person({ name: 'Another Replacement' })]) });
    expect(changedEmployee.fingerprint).not.toBe(first.fingerprint);
    fixture.rows.site[0].password_hash = 'changed-site-password-hash';
    const changedSettings = await planPayrollEmployeeReplacement(fixture.db, { report: report() });
    expect(changedSettings.fingerprint).not.toBe(first.fingerprint);
    expect(fixture.write).not.toHaveBeenCalled();
  });

  it('ignores relation ordering and JSON key ordering when comparing the same saved configuration', async () => {
    const fixture = readOnlyDatabase();
    fixture.group.policies.push({ id: 'link-attendance', deleted_at: null,
      policy: { id: 'attendance', kind: 'ATTENDANCE', rules: { grace_min: 15, standard_min: 540 } } });
    const first = await planPayrollEmployeeReplacement(fixture.db, { report: report() });
    fixture.group.policies.reverse();
    fixture.policy.rules = Object.fromEntries(Object.entries(fixture.policy.rules).reverse());
    fixture.group.policies.find((link) => link.id === 'link-attendance').policy.rules = { standard_min: 540, grace_min: 15 };
    const second = await planPayrollEmployeeReplacement(fixture.db, { report: report() });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.fingerprint_fields).toEqual(first.fingerprint_fields);
    expect(second.protected_settings).toEqual(first.protected_settings);
    expect(fixture.write).not.toHaveBeenCalled();
  });

  it('keeps fingerprints stable when API BigInt and Decimal JSON serializers are installed after the plan', async () => {
    const originalBigInt = Object.getOwnPropertyDescriptor(BigInt.prototype, 'toJSON');
    const originalDecimal = Object.getOwnPropertyDescriptor(Prisma.Decimal.prototype, 'toJSON');
    try {
      delete BigInt.prototype.toJSON;
      Prisma.Decimal.prototype.toJSON = function () { return this.toString(); };
      const fixture = readOnlyDatabase();
      fixture.rows.ptSlab[0].amount = 20_000n;
      fixture.rows.statutoryRates[0].recovery_cap_pct = new Prisma.Decimal('50.000001');
      fixture.rows.taxRegime[0].std_deduction = 7_500_000n;
      fixture.structures[0].components[0].calc_value = new Prisma.Decimal('50.000001');
      fixture.structures[0].components[0].max_amount = 2_000_000n;
      const before = await planPayrollEmployeeReplacement(fixture.db, { report: report() });
      // These are the existing API hooks from config/db.js. They run before JSON replacers.
      BigInt.prototype.toJSON = function () { return Number(this); };
      Prisma.Decimal.prototype.toJSON = function () { return this.toNumber(); };
      const after = await planPayrollEmployeeReplacement(fixture.db, { report: report() });
      expect(after.fingerprint).toBe(before.fingerprint);
      expect(after.fingerprint_fields).toEqual(before.fingerprint_fields);
      expect(after.protected_settings).toEqual(before.protected_settings);
      fixture.structures[0].components[0].calc_value = new Prisma.Decimal('50.000002');
      const actualChange = await planPayrollEmployeeReplacement(fixture.db, { report: report() });
      expect(actualChange.fingerprint).not.toBe(before.fingerprint);
      expect(fixture.write).not.toHaveBeenCalled();
    } finally {
      if (originalBigInt) Object.defineProperty(BigInt.prototype, 'toJSON', originalBigInt);
      else delete BigInt.prototype.toJSON;
      if (originalDecimal) Object.defineProperty(Prisma.Decimal.prototype, 'toJSON', originalDecimal);
      else delete Prisma.Decimal.prototype.toJSON;
    }
  });
});
