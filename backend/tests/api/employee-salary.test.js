import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { toDbDate } from '../../src/utils/dbDates.js';
import { buildFixture, R } from './fixture.js';

let f;
beforeEach(async () => { f = await buildFixture(); });
afterAll(async () => { await prisma.$disconnect(); });

const salaryPath = (employeeId = f.employees.A) => `/api/v1/employees/${employeeId}/salary`;
const body = (date, amount = 26000, structureId = f.structureId) => ({ mode: 'GROSS', amount: R(amount), valid_from: date, structure_id: structureId, reason: 'Reviewed salary agreement' });
const dateOf = (date) => date?.toISOString().slice(0, 10) ?? null;
const rows = (employeeId = f.employees.A) => prisma.employeeSalary.findMany({ where: { employee_id: employeeId, deleted_at: null }, orderBy: { valid_from: 'asc' } });
async function add(date, amount = 26000) {
  const result = await f.agent.post(salaryPath()).send(body(date, amount));
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body.data.id;
}
async function otherStructure() {
  return prisma.salaryStructure.create({ data: { name: 'Individual agreement', components: { create: [
    { seq: 1, name: 'Basic', calc_type: 'PCT_GROSS', calc_value: 60, counts_as_wages: true },
    { seq: 2, name: 'Special Allowance', calc_type: 'BALANCE', calc_value: 0 },
  ] } } });
}
async function freeze({ ym = '2026-08', state = 'LOCKED', salaryId, finalMonth } = {}) {
  const period = await prisma.payrollPeriod.create({ data: { period_ym: ym, state: 'RUN' } });
  await prisma.payslip.create({ data: {
    period_id: period.id, employee_id: f.employees.A,
    gross: 2000000n, salary_gross: 2000000n, total_deductions: 0n, reimbursements: 0n, net: 2000000n,
    employer_total: 0n, ctc_month: 2000000n, pf_wage: 1000000n, esi_applicable: true,
    paid_days: 26, lop_days: 0, divisor: 26, computed_at: new Date(), engine_version: 'test',
    meta: { salary: salaryId ? { salary_id: salaryId } : {}, ...(finalMonth ? { final_month_ym: finalMonth } : {}) },
  } });
  await prisma.payrollPeriod.update({ where: { id: period.id }, data: { state } });
  return period;
}

describe('Salary agreements belong to employees', () => {
  it('requires an explicit structure for creation and stores the selected employee structure', async () => {
    const structure = await otherStructure();
    const employee = { name: 'New employee', gender: 'FEMALE', phone: '9000000000', department_id: f.deptId,
      designation: 'Engineer', pay_group_id: f.payGroupId, joined_on: '2026-08-01', status: 'ACTIVE',
      pt_state: 'Andhra Pradesh', salary: { mode: 'GROSS', amount: R(28000), structure_id: structure.id } };
    const missing = { ...employee, salary: { mode: 'GROSS', amount: R(28000) } };
    expect((await f.agent.post('/api/v1/employees').send(missing)).status).toBe(422);
    const result = await f.agent.post('/api/v1/employees').send(employee);
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    const saved = await rows(result.body.data.id);
    expect(saved[0].structure_id).toBe(structure.id);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: result.body.data.id } })).pay_group_id).toBe(f.payGroupId);
  });

  it('previews only the explicit salary structure and never falls back to a pay group', async () => {
    const structure = await otherStructure();
    const input = { mode: 'GROSS', amount: R(28000), employee_id: f.employees.A, pay_group_id: f.payGroupId, date: '2026-08-01' };
    const missing = await f.agent.post('/api/v1/employees/salary-preview').send(input);
    expect(missing.status).toBe(422);
    expect(missing.body.error.field).toBe('structure_id');
    const preview = await f.agent.post('/api/v1/employees/salary-preview').send({ ...input, structure_id: structure.id });
    expect(preview.status).toBe(200);
    expect(preview.body.data.structure.basic).toBe(R(16800));
  });

  it('adds a first explicitly dated gross agreement even without historic statutory rates', async () => {
    await prisma.employeeSalary.deleteMany({ where: { employee_id: f.employees.A } });
    const pay = await f.agent.get(`/api/v1/employees/${f.employees.A}/pay`);
    expect(pay.status).toBe(200);
    expect(pay.body.data).toMatchObject({ salary: null, preview: null });
    const configured = await prisma.statutoryRates.findFirstOrThrow({ orderBy: { valid_from: 'desc' } });
    expect(pay.body.data.rates).toEqual({ pf: configured.pf, esi: configured.esi });
    expect(await rows()).toEqual([]);
    expect((await f.agent.get(salaryPath())).body.data).toEqual([]);
    const result = await f.agent.post(salaryPath()).send(body('2025-02-01'));
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    const saved = await rows();
    expect(saved).toHaveLength(1);
    expect(dateOf(saved[0].valid_from)).toBe('2025-02-01');
    expect(saved[0].monthly_gross).toBe(BigInt(R(26000)));
    expect(saved[0].structure_id).toBe(f.structureId);
    expect(await prisma.onboardingTask.count({ where: { employee_id: f.employees.A, task_code: 'PAY', done_at: { not: null } } })).toBe(1);
    const unconfigured = await prisma.employeeSalary.findFirst({ where: { employee_id: f.employees.A, valid_from: { lte: toDbDate('2025-01-15') }, deleted_at: null } });
    expect(unconfigured).toBeNull();
  });

  it('rejects a missing or deleted structure when saving an employee revision', async () => {
    const missing = { ...body('2026-10-01') };
    delete missing.structure_id;
    expect((await f.agent.post(salaryPath()).send(missing)).status).toBe(422);
    const structure = await otherStructure();
    await prisma.salaryStructure.update({ where: { id: structure.id }, data: { deleted_at: new Date() } });
    expect((await f.agent.post(salaryPath()).send(body('2026-10-01', 28000, structure.id))).status).toBe(404);
    expect(await rows()).toHaveLength(1);
  });

  it('keeps salaries unchanged when pay group or designation changes, and records the designation journey', async () => {
    const original = await rows();
    const group = await prisma.payGroup.findUniqueOrThrow({ where: { id: f.payGroupId } });
    const other = await prisma.payGroup.create({ data: {
      name: 'Other calendar', calendar_method: 'ACTUAL', weekly_off: ['SAT', 'SUN'], shift_id: group.shift_id,
    } });
    const employee = await f.agent.get(`/api/v1/employees/${f.employees.A}`);
    const result = await f.agent.patch(`/api/v1/employees/${f.employees.A}`).send({ updated_at: employee.body.data.updated_at, pay_group_id: other.id, designation: 'Senior engineer' });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(await rows()).toEqual(original);
    const journey = await f.agent.get(`/api/v1/employees/${f.employees.A}/timeline`);
    expect(journey.body.data.find((entry) => entry.action === 'employee.designation_change').detail).toMatchObject({ from: 'Electrician', to: 'Senior engineer' });
  });
});

describe('Editing and deleting salary history', () => {
  it('edits a revision and recomputes dates when it moves across a neighboring revision', async () => {
    const middle = await add('2026-10-01');
    const latest = await add('2026-11-01', 29000);
    const structure = await otherStructure();
    const result = await f.agent.patch(`${salaryPath()}/${latest}`).send(body('2026-09-15', 31000, structure.id));
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const history = await rows();
    expect(history.map((row) => [row.id, dateOf(row.valid_from), dateOf(row.valid_to)])).toEqual([
      [history[0].id, '2025-01-01', '2026-09-14'], [latest, '2026-09-15', '2026-09-30'], [middle, '2026-10-01', null],
    ]);
    expect(history[1].amount).toBe(BigInt(R(31000)));
    expect(history[1].structure_id).toBe(structure.id);
    const event = await prisma.auditLog.findFirstOrThrow({ where: { entity_id: f.employees.A, action: 'salary.edit' } });
    expect(event.detail).toMatchObject({ old: { id: latest, valid_from: '2026-11-01' }, new: { id: latest, valid_from: '2026-09-15', amount: R(31000), structure_id: structure.id } });
  });

  it('allows an explicit new first coverage date but rejects dates before joining', async () => {
    const initial = (await rows())[0];
    expect((await f.agent.patch(`${salaryPath()}/${initial.id}`).send(body('2024-12-31'))).status).toBe(422);
    const result = await f.agent.patch(`${salaryPath()}/${initial.id}`).send(body('2025-02-01'));
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(dateOf((await rows())[0].valid_from)).toBe('2025-02-01');
  });

  it('rejects duplicate dates atomically and keeps the original history', async () => {
    await add('2026-10-01');
    const latest = await add('2026-11-01');
    const original = await rows();
    const result = await f.agent.patch(`${salaryPath()}/${latest}`).send(body('2026-10-01'));
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('SALARY_OVERLAP');
    expect(await rows()).toEqual(original);
    expect(await prisma.auditLog.count({ where: { action: 'salary.edit' } })).toBe(0);
  });

  it('soft-deletes a middle revision and closes the preceding one at the next start', async () => {
    const middle = await add('2026-10-01');
    const latest = await add('2026-11-01');
    const result = await f.agent.delete(`${salaryPath()}/${middle}`);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const history = await rows();
    expect(history).toHaveLength(2);
    expect(dateOf(history[0].valid_to)).toBe('2026-10-31');
    expect(history[1].id).toBe(latest);
    expect((await prisma.employeeSalary.findUniqueOrThrow({ where: { id: middle } })).deleted_at).not.toBeNull();
    const visible = await f.agent.get(salaryPath());
    expect(visible.body.data.map((row) => row.id)).not.toContain(middle);
    expect(await prisma.auditLog.count({ where: { action: 'salary.delete', entity_id: f.employees.A } })).toBe(1);
  });

  it('deleting the first revision preserves its original configured coverage start', async () => {
    const initial = (await rows())[0];
    await f.agent.patch(`${salaryPath()}/${initial.id}`).send(body('2025-02-01'));
    const next = await add('2026-10-01');
    const result = await f.agent.delete(`${salaryPath()}/${initial.id}`);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    const history = await rows();
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(next);
    expect(dateOf(history[0].valid_from)).toBe('2025-02-01');
    expect(history[0].valid_to).toBeNull();
  });

  it('deleting the latest revision reopens the prior one and never removes the last salary', async () => {
    const latest = await add('2026-10-01');
    expect((await f.agent.delete(`${salaryPath()}/${latest}`)).status).toBe(200);
    const initial = (await rows())[0];
    expect(initial.valid_to).toBeNull();
    const history = await f.agent.get(salaryPath());
    expect(history.body.data[0]).toMatchObject({ can_edit: true, can_delete: false, deletion_reason: 'Keep at least one salary revision.' });
    const blocked = await f.agent.delete(`${salaryPath()}/${initial.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('LAST_SALARY');
  });

  it('does not allow a revision from another employee to be changed or deleted', async () => {
    const other = (await rows(f.employees.B))[0];
    expect((await f.agent.patch(`${salaryPath()}/${other.id}`).send(body('2026-10-01'))).status).toBe(404);
    expect((await f.agent.delete(`${salaryPath()}/${other.id}`)).status).toBe(404);
    expect((await rows(f.employees.B))[0].id).toBe(other.id);
  });
});

describe('Frozen payroll protects salary history', () => {
  it('serializes a salary edit behind settlement payment without deadlocking and rechecks exited status', async () => {
    const initial = (await rows())[0];
    const period = await freeze({ salaryId: initial.id });
    const future = await add('2026-10-01');
    await prisma.employee.update({ where: { id: f.employees.A }, data: { status: 'NOTICE' } });
    const original = await rows();
    let releasePayment;
    let markPeriodLocked;
    const periodLocked = new Promise((resolve) => { markPeriodLocked = resolve; });
    const finishPayment = new Promise((resolve) => { releasePayment = resolve; });
    const payment = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payroll_period WHERE id = ${period.id}::uuid FOR UPDATE`;
      markPeriodLocked();
      await finishPayment;
      // This is the same period -> employee lock order as F&F mark-paid.
      await tx.payrollPeriod.update({ where: { id: period.id }, data: { state: 'PAID' } });
      await tx.employee.update({ where: { id: f.employees.A }, data: { status: 'EXITED' } });
    }, { timeout: 20_000 });
    await Promise.race([periodLocked, payment]);
    const editing = f.agent.patch(`${salaryPath()}/${future}`).send(body('2026-10-01', 31000)).then((response) => response);
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const [activity] = await prisma.$queryRaw`
          SELECT COUNT(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'
            AND query LIKE '%SELECT p.id FROM payroll_period p%'`;
        if (activity.count > 0) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      releasePayment();
      await Promise.allSettled([payment, editing]);
    }
    await payment;
    const result = await editing;
    expect(waiting, 'salary edit should wait on the payment period lock').toBe(true);
    expect(result.status, JSON.stringify(result.body)).toBe(403);
    expect(result.body.error.code).toBe('FORBIDDEN');
    expect(await rows()).toEqual(original);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: f.employees.A } })).status).toBe('EXITED');
    expect(await prisma.auditLog.count({ where: { action: 'salary.edit' } })).toBe(0);
  });

  it.each(['LOCKED', 'PAID'])('protects a salary snapshot used in %s payroll while allowing later revisions', async (state) => {
    const initial = (await rows())[0];
    await freeze({ state, salaryId: initial.id });
    const later = await add('2026-10-01');
    const history = await f.agent.get(salaryPath());
    expect(history.body.data.find((row) => row.id === initial.id)).toMatchObject({ can_edit: false, can_delete: false });
    expect(history.body.data.find((row) => row.id === initial.id).protection_reason).toMatch(/payroll for August 2026/);
    const edit = await f.agent.patch(`${salaryPath()}/${initial.id}`).send(body('2025-01-01', 35000));
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('SALARY_PROTECTED');
    expect((await f.agent.delete(`${salaryPath()}/${initial.id}`)).status).toBe(409);
    expect((await f.agent.delete(`${salaryPath()}/${later}`)).status).toBe(200);
    expect((await rows())[0].amount).toBe(initial.amount);
  });

  it('blocks a future revision from moving into a protected month even if it was never snapshotted', async () => {
    const initial = (await rows())[0];
    await freeze({ salaryId: initial.id });
    const future = await add('2026-11-01');
    const original = await rows();
    const result = await f.agent.patch(`${salaryPath()}/${future}`).send(body('2026-08-15'));
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('SALARY_PROTECTED');
    expect(await rows()).toEqual(original);
    expect((await f.agent.post(salaryPath()).send(body('2026-11-15'))).status).toBe(201);
  });

  it('uses the final work month for frozen settlements even without a snapshot salary ID', async () => {
    const initial = (await rows())[0];
    await freeze({ ym: '2026-11', state: 'PAID', finalMonth: '2026-08' });
    const later = await add('2026-10-01');
    expect((await f.agent.patch(`${salaryPath()}/${initial.id}`).send(body('2025-01-01', 35000))).status).toBe(409);
    const initialBody = { ...body('2025-01-01', 20000), reason: 'Changed description only' };
    expect((await f.agent.patch(`${salaryPath()}/${initial.id}`).send(initialBody)).status).toBe(409);
    expect((await f.agent.patch(`${salaryPath()}/${later}`).send(body('2026-10-01', 31000))).status).toBe(200);
  });
});
