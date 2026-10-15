import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { buildFixture, R, runAndWait, submitSteps, YM } from './fixture.js';

// August 2026 is the first AJPWER month here: April–July were paid before AJPWER.
let f;
let director;
const path = (id = director) => `/api/v1/employees/${id}/opening-tds`;
const P = `/api/v1/payroll/periods/${YM}`;
const slip = (id) => prisma.payslip.findFirstOrThrow({ where: { employee_id: id, period: { period_ym: YM } }, include: { lines: true } });
const tdsOf = (s) => s.lines.filter((l) => l.code === 'TDS').reduce((a, l) => a + Number(l.amount), 0);
const rupee = (paise) => Math.round(paise / 100) * 100;

beforeAll(async () => {
  f = await buildFixture();
  // C has a month of attendance and a bank account; on a director's salary the year's tax is well above the rebate.
  director = f.employees.C;
  await prisma.employeeSalary.updateMany({ where: { employee_id: director }, data: { amount: BigInt(R(383000)), monthly_gross: BigInt(R(383000)) } });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('TDS deducted before AJPWER', () => {
  it('is empty until HR enters it', async () => {
    const r = await f.agent.get(`${path()}?fy=2026`);
    expect(r.status).toBe(200);
    expect(r.body.data).toBeNull();
  });

  it('rejects a negative amount or an impossible year', async () => {
    expect((await f.agent.put(path()).send({ fy_start: 2026, tds_deducted: -1 })).status).toBe(422);
    expect((await f.agent.put(path()).send({ fy_start: 1990, tds_deducted: 0 })).status).toBe(422);
  });

  it('saves one figure per financial year, audit-logged, and replaces it on a second save', async () => {
    expect((await f.agent.put(path()).send({ fy_start: 2026, tds_deducted: R(100000) })).status).toBe(200);
    const r = await f.agent.put(path()).send({ fy_start: 2026, tds_deducted: R(324584), note: 'Apr–Jul from the old payroll' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ fy_start: 2026, tds_deducted: R(324584), note: 'Apr–Jul from the old payroll' });
    expect(await prisma.employeeOpeningTds.count({ where: { employee_id: director } })).toBe(1);
    const logged = await prisma.auditLog.findMany({ where: { entity_type: 'employee_opening_tds', entity_id: director } });
    expect(logged.map((l) => l.action)).toEqual(['employee.opening_tds.save', 'employee.opening_tds.save']);
  });

  it('shows the year’s working on the Tax tab', async () => {
    const r = await f.agent.get(`/api/v1/employees/${director}/tax`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const y = r.body.data.year;
    expect(y).toMatchObject({ fy_start: 2026, opening_tds: R(324584), deducted_in_ajpwer: 0 });
    expect(y.monthly_tds).toBe(rupee((y.annual_tax - R(324584)) / y.remaining_months));
  });

  it('warns at review about people with months before AJPWER and nothing entered', async () => {
    const r = await f.agent.get(`${P}/issues`);
    expect(r.status).toBe(200);
    const missing = r.body.data.issues.filter((i) => i.kind === 'NO_OPENING_TDS');
    expect(missing.map((i) => i.employee_id)).toContain(f.employees.A);
    expect(missing.map((i) => i.employee_id)).not.toContain(director);
    expect(missing[0]).toMatchObject({ severity: 'WARNING', fix_tab: 'tax' });
    expect(missing[0].message).toMatch(/April 2026.*July 2026/);
  });

  it('takes it off the year’s tax in the payroll run, spread over the months left', async () => {
    await submitSteps(f.agent, YM, 5);
    expect((await runAndWait(f.agent, YM)).status).toBe('DONE');
    const s = await slip(director);
    // August to March: 8 months left.
    expect(s.meta.tds).toMatchObject({ opening_tds: R(324584), deducted_before: R(324584), remaining_months: 8 });
    expect(tdsOf(s)).toBe(rupee((s.meta.tds.annual - R(324584)) / 8));
  });

  it('cleared, the month goes back to the even spread', async () => {
    expect((await f.agent.post(`${P}/back-to-steps`)).status).toBe(200);
    expect((await f.agent.delete(path()).send({ fy_start: 2026 })).status).toBe(200);
    expect((await f.agent.get(`${path()}?fy=2026`)).body.data).toBeNull();
    await submitSteps(f.agent, YM, 5);
    expect((await runAndWait(f.agent, YM)).status).toBe('DONE');
    const s = await slip(director);
    expect(s.meta.tds.opening_tds).toBeNull();
    expect(tdsOf(s)).toBe(rupee(s.meta.tds.annual / 12));
  });

  it('is read-only once the person has exited', async () => {
    await prisma.employee.update({ where: { id: f.employees.B }, data: { status: 'EXITED' } });
    expect((await f.agent.put(path(f.employees.B)).send({ fy_start: 2026, tds_deducted: 0 })).status).toBe(403);
  });
});
