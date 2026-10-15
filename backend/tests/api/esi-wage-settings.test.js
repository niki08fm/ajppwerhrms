import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { toDbDate } from '../../src/utils/dbDates.js';
import { buildFixture, R, runAndWait, submitSteps, YM } from './fixture.js';

let f;
beforeEach(async () => { f = await buildFixture(); });
afterAll(async () => { await prisma.$disconnect(); });

async function selectStructure(basicPercent) {
  const response = await f.agent.post('/api/v1/structures').send({ name: 'Selected ESI wages', components: [
    { seq: 1, name: 'Basic', calc_type: 'PCT_GROSS', calc_value: basicPercent,
      frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: true, counts_as_esi_wages: true },
    { seq: 2, name: 'Special Allowance', calc_type: 'BALANCE', calc_value: 0,
      frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages: false, counts_as_esi_wages: false },
  ] });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  expect(response.body.data.components.map((component) => component.counts_as_esi_wages)).toEqual([true, false]);
  await prisma.employeeSalary.updateMany({ where: { employee_id: f.employees.B }, data: { structure_id: response.body.data.id } });
  return prisma.employeeSalary.findMany({ where: { employee_id: f.employees.B } });
}

describe('Employee ESI settings validate selected structure wages without rewriting salary', () => {
  it('enables ESI above the gross ceiling when selected wages are within it', async () => {
    const before = await selectStructure(50);
    const response = await f.agent.patch(`/api/v1/employees/${f.employees.B}/statutory`).send({ esi_enabled: true });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await prisma.employeeStatutory.findUniqueOrThrow({ where: { employee_id: f.employees.B } })).esi_enabled).toBe(true);
    expect(await prisma.employeeSalary.findMany({ where: { employee_id: f.employees.B } })).toEqual(before);
    const preview = await f.agent.get(`/api/v1/employees/${f.employees.B}/pay`);
    expect(preview.body.data.preview).toMatchObject({ gross: 2400000, esi_wage: 1200000,
      esi_within_ceiling: true, esi: { applicable: true, wage: 1200000 } });
  });

  it('rejects enabling when selected wages exceed the ceiling and there is no coverage lock', async () => {
    const before = await selectStructure(90);
    const response = await f.agent.patch(`/api/v1/employees/${f.employees.B}/statutory`).send({ esi_enabled: true });
    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({ field: 'esi_enabled' });
    expect(response.body.error.message).toMatch(/selected ESI wages/);
    expect((await prisma.employeeStatutory.findUniqueOrThrow({ where: { employee_id: f.employees.B } })).esi_enabled).toBe(false);
    expect(await prisma.employeeSalary.findMany({ where: { employee_id: f.employees.B } })).toEqual(before);
  });

  it('allows covered employees to remain enrolled even above the selected-wage ceiling', async () => {
    const before = await selectStructure(90);
    await prisma.employeeStatutory.update({ where: { employee_id: f.employees.B }, data: { esi_locked_until: toDbDate('2027-03-31') } });
    const response = await f.agent.patch(`/api/v1/employees/${f.employees.B}/statutory`).send({ esi_enabled: true });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await prisma.employeeSalary.findMany({ where: { employee_id: f.employees.B } })).toEqual(before);
  });

  it('round-trips selected wages through gross and CTC previews, employee profiles and offer letters', async () => {
    const [salary] = await selectStructure(50);
    const common = { structure_id: salary.structure_id, date: '2026-08-01', employee_id: f.employees.B,
      pf_enabled: true, esi_enabled: true };
    const expected = { gross: R(24000), esi_wage: R(12000), esi_within_ceiling: true,
      esi: { applicable: true, wage: R(12000), employer: R(390) },
      ctc: { employer_pf: R(1440), employer_esi: R(390), annual_ctc: R(309960) } };
    const gross = await f.agent.post('/api/v1/employees/salary-preview').send({ ...common, mode: 'GROSS', amount: R(24000) });
    expect(gross.status, JSON.stringify(gross.body)).toBe(200);
    expect(gross.body.data).toMatchObject(expected);
    const ctc = await f.agent.post('/api/v1/employees/salary-preview').send({ ...common, mode: 'CTC', amount: gross.body.data.ctc.annual_ctc });
    expect(ctc.status, JSON.stringify(ctc.body)).toBe(200);
    expect(ctc.body.data).toMatchObject({ ...expected, solution: { approximate: false, ambiguous: false } });

    const employeeInput = { name: 'Selected wages employee', gender: 'MALE', phone: '9000000000',
      department_id: f.deptId, designation: 'Engineer', pay_group_id: f.payGroupId,
      joined_on: '2026-08-01', status: 'ACTIVE', pt_state: 'Andhra Pradesh',
      salary: { mode: 'CTC', amount: R(309960), structure_id: salary.structure_id } };
    const employee = await f.agent.post('/api/v1/employees').send(employeeInput);
    expect(employee.status, JSON.stringify(employee.body)).toBe(201);
    const id = employee.body.data.id;
    const saved = await prisma.employeeSalary.findFirstOrThrow({ where: { employee_id: id } });
    expect(saved).toMatchObject({ mode: 'CTC', amount: BigInt(R(309960)), monthly_gross: BigInt(R(24000)), structure_id: salary.structure_id });
    expect((await prisma.employeeStatutory.findUniqueOrThrow({ where: { employee_id: id } })).esi_enabled).toBe(true);
    const profile = await f.agent.get(`/api/v1/employees/${id}/pay`);
    expect(profile.status, JSON.stringify(profile.body)).toBe(200);
    expect(profile.body.data.preview).toMatchObject(expected);

    const offer = await f.agent.post('/api/v1/offers').send({ name: 'Selected wages offer', gender: 'MALE', phone: '9000000000',
      department_id: f.deptId, designation: 'Engineer', pay_group_id: f.payGroupId,
      structure_id: salary.structure_id, mode: 'CTC', amount: R(309960),
      join_by: '2026-11-01', valid_till: '2026-10-31', pt_state: 'Andhra Pradesh' });
    expect(offer.status, JSON.stringify(offer.body)).toBe(201);
    const savedOffer = await prisma.offer.findUniqueOrThrow({ where: { id: offer.body.data.offer_id } });
    expect(savedOffer).toMatchObject({ amount: BigInt(R(309960)), monthly_gross: BigInt(R(24000)), structure_id: salary.structure_id });
    expect((await prisma.employeeStatutory.findUniqueOrThrow({ where: { employee_id: offer.body.data.employee_id } })).esi_enabled).toBe(true);
    const letter = await prisma.letter.findFirstOrThrow({ where: { employee_id: offer.body.data.employee_id, kind: 'OFFER' } });
    expect(letter.snapshot.salary).toMatchObject({ amount: R(309960), monthly_gross: R(24000),
      annual_ctc: R(309960), employer_pf: R(1440), employer_esi: R(390) });
  });

  it('stores selected earned wages in generated payroll and exports that frozen value', async () => {
    await selectStructure(50);
    const enabled = await f.agent.patch(`/api/v1/employees/${f.employees.B}/statutory`).send({ esi_enabled: true });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    await submitSteps(f.agent, YM, 6);
    expect((await runAndWait(f.agent, YM)).status).toBe('DONE');
    const payslip = await f.agent.get(`/api/v1/payroll/periods/${YM}/payslips/${f.employees.B}`);
    expect(payslip.status, JSON.stringify(payslip.body)).toBe(200);
    expect(payslip.body.data).toMatchObject({ gross: R(24000), esi_applicable: true,
      meta: { esi_wage: R(12000), statutory_gross: R(24000) } });
    expect(payslip.body.data.lines.find((line) => line.code === 'ESI').amount).toBe(R(90));
    expect(payslip.body.data.lines.find((line) => line.code === 'ER_ESI').amount).toBe(R(390));
    const locked = await f.agent.post(`/api/v1/payroll/periods/${YM}/lock`);
    expect(locked.status, JSON.stringify(locked.body)).toBe(200);
    const report = await f.agent.get(`/api/v1/payroll/periods/${YM}/report/esi`);
    expect(report.status, JSON.stringify(report.body)).toBe(200);
    expect(report.body.data.rows.find((row) => row.employee_id === f.employees.B))
      .toMatchObject({ wages: R(12000), employee: R(90), employer: R(390) });
  });
});
