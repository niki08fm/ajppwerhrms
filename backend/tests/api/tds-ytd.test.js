import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { buildFixture, R, runAndWait, submitSteps, YM } from './fixture.js';

const NEXT = '2026-09';
const tdsLine = (slip) => slip.lines.filter((l) => l.code === 'TDS').reduce((a, l) => a + Number(l.amount), 0);

afterAll(async () => {
  await prisma.$disconnect();
});

async function slipFor(employeeId, ym) {
  return prisma.payslip.findFirstOrThrow({ where: { employee_id: employeeId, period: { period_ym: ym } }, include: { lines: true } });
}

describe('TDS year to date across payroll runs', () => {
  it('nets the TDS of earlier months, keeps the regime the year started on and flags estimated months', async () => {
    const f = await buildFixture();
    const A = f.employees.A;
    await prisma.employeeSalary.updateMany({ where: { employee_id: A }, data: { amount: BigInt(R(200000)), monthly_gross: BigInt(R(200000)) } });

    await submitSteps(f.agent, YM, 6);
    expect((await runAndWait(f.agent, YM)).status).toBe('DONE');
    expect((await f.agent.post(`/api/v1/payroll/periods/${YM}/lock`)).status).toBe(200);
    const august = await slipFor(A, YM);
    const augustTds = tdsLine(august);
    expect(augustTds).toBeGreaterThan(0);
    expect(august.meta.tds.tds_to_date).toBe(0);
    expect(august.meta.tds.months_left).toBe(8);
    expect(august.meta.tax_ytd.taxable).toBeGreaterThan(0);

    // A regime change after the year's first run waits for April.
    const change = await f.agent.patch(`/api/v1/employees/${A}/statutory`).send({ tax_regime_code: 'OLD' });
    expect(change.status).toBe(200);
    expect(change.body.warning).toMatch(/until March/);

    const issues = await f.agent.get(`/api/v1/payroll/periods/${NEXT}/issues`);
    const kinds = (issues.body.data?.issues ?? issues.body.data ?? []).filter((i) => i.employee_id === A).map((i) => i.kind);
    expect(kinds).toContain('REGIME_LOCKED');
    expect(kinds).toContain('TDS_ESTIMATED');

    await submitSteps(f.agent, NEXT, 6);
    expect((await runAndWait(f.agent, NEXT)).status).toBe('DONE');
    const september = await slipFor(A, NEXT);
    expect(september.meta.regime).toBe('NEW');
    expect(september.meta.tds.tds_to_date).toBe(augustTds);
    expect(september.meta.tds.months_left).toBe(7);
    // April–July have no payroll on record: estimated at the current salary.
    expect(september.meta.tds.estimated_months).toBe(4);
  });

  it('counts a previous employer recorded for this tax year', async () => {
    const f = await buildFixture();
    const A = f.employees.A;
    await prisma.employeeSalary.updateMany({ where: { employee_id: A }, data: { amount: BigInt(R(100000)), monthly_gross: BigInt(R(100000)) } });
    const preview = async () => (await f.agent.get(`/api/v1/employees/${A}/payslip-preview?month=${YM}`)).body.data.result.tds;
    const without = await preview();
    await prisma.employeeStatutory.update({ where: { employee_id: A }, data: { prev_employer_fy: 2026, prev_employer_income: BigInt(R(600000)), prev_employer_tds: BigInt(R(10000)) } });
    const withPrevious = await preview();
    expect(withPrevious.previous_income).toBe(R(600000));
    expect(withPrevious.previous_tds).toBe(R(10000));
    expect(withPrevious.annual).toBeGreaterThan(without.annual);
  });
});
