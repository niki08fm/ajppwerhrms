import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../../src/config/db.js';
import { invalidatePrincipal } from '../../src/middleware/auth.js';
import { app, buildFixture, R, runAndWait, submitSteps, YM } from './fixture.js';

let f;
beforeEach(async () => { f = await buildFixture(); invalidatePrincipal(); });
afterAll(async () => { await prisma.$disconnect(); });

const statutoryPath = (employeeId = f.employees.C) => `/api/v1/employees/${employeeId}/statutory`;
const payrollPath = `/api/v1/payroll/periods/${YM}`;
const savedStatutory = (employeeId = f.employees.C) => prisma.employeeStatutory.findUniqueOrThrow({ where: { employee_id: employeeId } });
const savedSalaries = (employeeId = f.employees.C) => prisma.employeeSalary.findMany({ where: { employee_id: employeeId }, orderBy: { valid_from: 'asc' } });
const lineAmount = (payslip, code) => payslip.lines.filter((line) => line.code === code).reduce((sum, line) => sum + line.amount, 0);

async function setStatutory(body, employeeId = f.employees.C) {
  const response = await f.agent.patch(statutoryPath(employeeId)).send(body);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

async function payPreview(employeeId = f.employees.C) {
  const response = await f.agent.get(`/api/v1/employees/${employeeId}/pay`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data.preview;
}

async function payrollSnapshot(employeeId = f.employees.C) {
  const response = await f.agent.get(`${payrollPath}/payslips/${employeeId}`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}

async function pfReport() {
  const response = await f.agent.get(`${payrollPath}/report/pf`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}

describe('Employee EPS participation', () => {
  it('defaults EPS on for a new employee and respects an explicit employee-level opt-out', async () => {
    const common = { gender: 'MALE', phone: '9000000000', department_id: f.deptId,
      designation: 'Engineer', pay_group_id: f.payGroupId, joined_on: '2026-08-01',
      status: 'ACTIVE', pt_state: 'Andhra Pradesh',
      salary: { mode: 'GROSS', amount: R(30000), structure_id: f.structureId } };
    for (const [name, choice, expected] of [
      ['Default EPS employee', {}, true],
      ['EPF-only employee', { eps_enabled: false }, false],
      ['PF-disabled employee', { pf_enabled: false }, true],
    ]) {
      const response = await f.agent.post('/api/v1/employees').send({ ...common, name, ...choice });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const id = response.body.data.id;
      expect(await savedStatutory(id)).toMatchObject({ pf_enabled: choice.pf_enabled ?? true, eps_enabled: expected });
      const employee = await f.agent.get(`/api/v1/employees/${id}`);
      expect(employee.status, JSON.stringify(employee.body)).toBe(200);
      expect(employee.body.data.statutory.eps_enabled).toBe(expected);
      const preview = await payPreview(id);
      expect(preview.pf.eps).toBe(choice.pf_enabled === false || !expected ? 0 : R(1250));
    }
  });

  it('moves only the employer pension share into EPF, keeping salary, CTC, take-home and PF charges unchanged', async () => {
    await setStatutory({ vpf_pct: 2 });
    const salaries = await savedSalaries();
    const enabled = await payPreview();
    expect(enabled.pf).toMatchObject({ pf_wage: R(15000), eps_wage: R(15000), employee: R(1800),
      vpf: R(300), employer_total: R(1800), employer_epf: R(550), eps: R(1250) });

    await setStatutory({ eps_enabled: false });
    expect(await savedStatutory()).toMatchObject({ pf_enabled: true, eps_enabled: false, pf_restrict_to_ceiling: true });
    const disabled = await payPreview();
    expect(disabled.pf).toMatchObject({ pf_wage: R(15000), eps_wage: 0, employee: R(1800),
      vpf: R(300), employer_total: R(1800), employer_epf: R(1800), eps: 0 });
    expect(disabled.structure).toEqual(enabled.structure);
    expect(disabled.ctc).toEqual(enabled.ctc);
    for (const key of ['gross', 'employee_statutory', 'employer_statutory', 'take_home']) expect(disabled[key], key).toBe(enabled[key]);
    for (const key of ['pf_wage', 'employee', 'vpf', 'employer_total', 'edli', 'admin']) expect(disabled.pf[key], key).toBe(enabled.pf[key]);
    expect(await savedSalaries()).toEqual(salaries);
    const offAudit = await prisma.auditLog.findFirstOrThrow({ where: { entity_id: f.employees.C, action: 'statutory.update', detail: { path: ['changes', 'eps_enabled', 'to'], equals: false } } });
    expect(offAudit.detail.changes).toEqual({ eps_enabled: { from: true, to: false } });

    await setStatutory({ eps_enabled: true });
    expect(await payPreview()).toEqual(enabled);
    expect(await savedSalaries()).toEqual(salaries);
    const onAudit = await prisma.auditLog.findFirstOrThrow({ where: { entity_id: f.employees.C, action: 'statutory.update', detail: { path: ['changes', 'eps_enabled', 'to'], equals: true } } });
    expect(onAudit.detail.changes).toEqual({ eps_enabled: { from: false, to: true } });
  });

  it('uses the employee EPS choice in both gross and CTC calculation previews', async () => {
    const enabled = await payPreview();
    await setStatutory({ eps_enabled: false });
    const profile = await payPreview();
    for (const [mode, amount] of [['GROSS', R(30000)], ['CTC', enabled.ctc.annual_ctc]]) {
      const response = await f.agent.post('/api/v1/employees/salary-preview').send({
        mode, amount, structure_id: f.structureId, employee_id: f.employees.C, date: `${YM}-01`,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body.data).toMatchObject({ gross: R(30000), take_home: profile.take_home,
        ctc: { annual_ctc: enabled.ctc.annual_ctc, employer_pf: R(1800) },
        pf: { employee: R(1800), employer_total: R(1800), employer_epf: R(1800), eps: 0, eps_wage: 0 } });
    }
  });

  it('returns zero PF contributions when PF is disabled and preserves the employee EPS choice on re-enabling PF', async () => {
    expect((await savedStatutory()).eps_enabled).toBe(true);
    await setStatutory({ pf_enabled: false });
    expect((await payPreview()).pf).toMatchObject({ pf_wage: 0, eps_wage: 0, employee: 0,
      employer_total: 0, employer_epf: 0, eps: 0, vpf: 0, edli: 0, admin: 0 });
    expect((await savedStatutory()).eps_enabled).toBe(true);
    await setStatutory({ pf_enabled: true });
    expect((await payPreview()).pf).toMatchObject({ employee: R(1800), employer_epf: R(550), eps: R(1250) });
    await setStatutory({ eps_enabled: false });
    await setStatutory({ pf_enabled: false });
    await setStatutory({ pf_enabled: true });
    expect((await savedStatutory()).eps_enabled).toBe(false);
    expect((await payPreview()).pf).toMatchObject({ employee: R(1800), employer_total: R(1800), employer_epf: R(1800), eps: 0 });
  });

  it('requires a boolean and keeps exited employee profiles read-only', async () => {
    const before = await savedStatutory();
    for (const value of ['false', 0, null]) {
      const response = await f.agent.patch(statutoryPath()).send({ eps_enabled: value });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
    }
    await prisma.employee.update({ where: { id: f.employees.C }, data: { status: 'EXITED' } });
    const exited = await f.agent.patch(statutoryPath()).send({ eps_enabled: false });
    expect(exited.status).toBe(403);
    expect(exited.body.error.code).toBe('FORBIDDEN');
    expect(await savedStatutory()).toEqual(before);
    expect(await prisma.auditLog.count({ where: { action: 'statutory.update', entity_id: f.employees.C } })).toBe(0);
  });

  it('requires salary.write permission to change EPS', async () => {
    expect((await request(app).patch(statutoryPath()).send({ eps_enabled: false })).status).toBe(401);
    await prisma.role.updateMany({ data: { permissions: { set: ['people.read', 'salary.read'] } } });
    invalidatePrincipal();
    expect((await f.agent.get(`/api/v1/employees/${f.employees.C}/pay`)).status).toBe(200);
    expect((await f.agent.patch(statutoryPath()).send({ eps_enabled: false })).status).toBe(403);
    expect((await savedStatutory()).eps_enabled).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: 'statutory.update', entity_id: f.employees.C } })).toBe(0);
  });
});

describe('EPS in payroll snapshots and ECR reports', () => {
  it('freezes EPS-off wages and the full employer EPF allocation even after EPS is re-enabled in the profile', async () => {
    const originalSalaries = await savedSalaries();
    const originalPreview = await payPreview();
    await setStatutory({ eps_enabled: false });
    await submitSteps(f.agent, YM, 6);
    expect((await runAndWait(f.agent, YM)).status).toBe('DONE');
    const snapshot = await payrollSnapshot();
    expect(snapshot).toMatchObject({ gross: R(30000), pf_wage: R(15000), employer_total: R(1800),
      ctc_month: R(31800), engine_version: '1.6.0', meta: { eps_wage: 0 } });
    expect(lineAmount(snapshot, 'PF')).toBe(R(1800));
    expect(lineAmount(snapshot, 'ER_EPF')).toBe(R(1800));
    expect(lineAmount(snapshot, 'ER_EPS')).toBe(0);
    expect(snapshot.net).toBe(originalPreview.take_home);
    expect((await f.agent.post(`${payrollPath}/lock`)).status).toBe(200);
    const paid = await f.agent.post(`${payrollPath}/mark-paid`).set('Idempotency-Key', 'eps-only-paid').send({ payment_ref: 'EPS-ONLY-TEST' });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const frozenSnapshot = await payrollSnapshot();
    const frozenReport = await pfReport();
    expect(frozenReport.rows.find((row) => row.employee_id === f.employees.C)).toMatchObject({
      pf_wage: R(15000), eps_wage: 0, employee: R(1800), employer_epf: R(1800), eps: 0,
    });

    await setStatutory({ eps_enabled: true });
    expect((await payPreview()).pf.eps).toBe(R(1250));
    expect(await payrollSnapshot()).toEqual(frozenSnapshot);
    expect(await pfReport()).toEqual(frozenReport);
    expect(await savedSalaries()).toEqual(originalSalaries);
  });

  it('uses frozen pension wages for legacy payslips without EPS metadata, independently of the current employee choice', async () => {
    await submitSteps(f.agent, YM, 6);
    expect((await runAndWait(f.agent, YM)).status).toBe('DONE');
    const snapshot = await payrollSnapshot();
    expect(snapshot.meta.eps_wage).toBe(R(15000));
    const stored = await prisma.payslip.findUniqueOrThrow({ where: { id: snapshot.id } });
    const legacyMeta = { ...stored.meta };
    delete legacyMeta.eps_wage;
    await prisma.payslip.update({ where: { id: snapshot.id }, data: { meta: legacyMeta, engine_version: '1.5.0' } });
    expect((await f.agent.post(`${payrollPath}/lock`)).status).toBe(200);
    const before = await pfReport();
    expect(before.rows.find((row) => row.employee_id === f.employees.C)).toMatchObject({
      pf_wage: R(15000), eps_wage: R(15000), employee: R(1800), employer_epf: R(550), eps: R(1250),
    });
    await setStatutory({ eps_enabled: false });
    expect((await payPreview()).pf.eps).toBe(0);
    expect(await pfReport()).toEqual(before);
    expect((await payrollSnapshot()).meta).not.toHaveProperty('eps_wage');
  });
});
