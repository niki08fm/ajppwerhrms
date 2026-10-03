import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { buildFixture, runAndWait, submitSteps, YM } from './fixture.js';

// August is YM. Person C has no bank account. A is T001, B T002, C T003.
let f;
const SEP = '2026-09';
const P = (ym) => `/api/v1/payroll/periods/${ym}`;
const hold = (key, body) => f.agent.post(`/api/v1/employees/${f.employees[key]}/hold`).send(body);
const release = (key, body) => f.agent.post(`/api/v1/employees/${f.employees[key]}/hold/release`).send(body);
const bank = async (ym) => (await f.agent.get(`${P(ym)}/report/bank`)).body.data;
const heldRow = (key, ym = YM) => prisma.heldPay.findUnique({ where: { employee_id_period_ym: { employee_id: f.employees[key], period_ym: ym } } });
const slip = (key, ym) => prisma.payslip.findFirstOrThrow({ where: { employee_id: f.employees[key], period: { period_ym: ym } }, include: { lines: true } });

beforeAll(async () => {
  f = await buildFixture({ noBankFor: ['C'] });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('Holding a salary', () => {
  it('from a month not yet run, one hold at a time', async () => {
    expect((await hold('A', { from_ym: YM, reason: 'Documents pending' })).status).toBe(201);
    expect((await hold('A', { from_ym: YM, reason: 'Again' })).status).toBe(409);
    expect((await hold('B', { from_ym: YM, reason: 'Under inquiry' })).status).toBe(201);
    expect((await hold('C', { from_ym: YM, reason: 'Bank details pending' })).status).toBe(201);
    const h = (await f.agent.get(`/api/v1/employees/${f.employees.A}/hold`)).body.data;
    expect(h.current).toMatchObject({ from_ym: YM, reason: 'Documents pending', months: [] });
  });

  it('a held salary needs no bank account, so it does not block step 3', async () => {
    await submitSteps(f.agent, YM, 4);
  });

  it('the held month is calculated as usual and kept out of the bank file', async () => {
    expect((await runAndWait(f.agent, YM)).status).toBe('DONE');
    const b = await bank(YM);
    expect(b.rows.map((r) => r.code)).not.toContain('T001');
    expect(b.notes.join(' ')).toMatch(/3 salaries are on hold/);
    const a = await slip('A', YM);
    expect(a.meta.held).toMatchObject({ reason: 'Documents pending', from_ym: YM });
    expect(a.lines.some((l) => l.code === 'PF' || l.kind === 'COMPONENT')).toBe(true);
    const held = await heldRow('A');
    expect(held.state).toBe('HELD');
    expect(held.amount).toBe(a.net);
    const register = (await f.agent.get(`${P(YM)}/report/register`)).body.data;
    expect(register.rows.find((r) => r.code === 'T001').payment).toBe('On hold');
  });

  it('released into the same month while it is run and not locked, it is simply paid there', async () => {
    expect((await release('B', { mode: 'PAYROLL', pay_ym: YM })).status).toBe(200);
    expect((await slip('B', YM)).meta.held).toBeNull();
    expect(await heldRow('B')).toBeNull();
    expect((await bank(YM)).rows.map((r) => r.code)).toContain('T002');
    expect((await prisma.payrollPeriod.findUnique({ where: { period_ym: YM } })).totals.held_count).toBe(2);
  });

  it('a later month only once the held month is locked', async () => {
    const r = await release('A', { mode: 'PAYROLL', pay_ym: SEP });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/not locked/);
    expect((await f.agent.post(`${P(YM)}/lock`)).status).toBe(200);
    expect((await f.agent.post(`${P(YM)}/mark-paid`).set('Idempotency-Key', 'hold-aug').send({ payment_ref: 'NEFT-AUG' })).status).toBe(200);
    expect((await hold('B', { from_ym: YM, reason: 'August is paid' })).status).toBe(409);

    expect((await release('A', { mode: 'PAYROLL', pay_ym: SEP })).status).toBe(200);
    expect(await heldRow('A')).toMatchObject({ state: 'QUEUED', pay_ym: SEP });
    expect((await release('C', { mode: 'SEPARATE', paid_on: '2026-09-05', payment_ref: 'CASH-77' })).status).toBe(200);
    expect(await heldRow('C')).toMatchObject({ state: 'PAID_SEPARATELY', payment_ref: 'CASH-77' });
  });

  it('a month whose held salary was released cannot be unlocked and run again', async () => {
    expect((await f.agent.post(`${P(YM)}/unmark-paid`)).status).toBe(200);
    const r = await f.agent.post(`${P(YM)}/unlock`);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/paid twice/);
    expect((await f.agent.post(`${P(YM)}/mark-paid`).set('Idempotency-Key', 'hold-aug-2').send({ payment_ref: 'NEFT-AUG-2' })).status).toBe(200);
  });

  it('released into payroll, it is paid once, as its own line in that month', async () => {
    await submitSteps(f.agent, SEP, 2);
    // C still has no bank account: left out of September.
    expect((await f.agent.post(`${P(SEP)}/exclusions`).send({ employee_id: f.employees.C, reason: 'Bank details still pending' })).status).toBe(200);
    for (const s of [3, 4]) expect((await f.agent.post(`${P(SEP)}/steps/${s}/submit`)).status).toBe(200);
    expect((await runAndWait(f.agent, SEP)).status).toBe('DONE');

    const aug = await heldRow('A');
    const sep = await slip('A', SEP);
    const line = sep.lines.find((l) => l.kind === 'HELD');
    expect(line).toMatchObject({ code: `HELD:${YM}`, name: 'Held salary for August 2026', is_taxable: false, counts_as_wages: false });
    expect(line.amount).toBe(aug.amount);
    expect((await bank(SEP)).rows.find((r) => r.code === 'T001').amount).toBe(Number(sep.net));
    expect((await bank(SEP)).rows.map((r) => r.code)).not.toContain('T003');

    expect((await f.agent.post(`${P(SEP)}/lock`)).status).toBe(200);
    expect((await f.agent.post(`${P(SEP)}/mark-paid`).set('Idempotency-Key', 'hold-sep').send({ payment_ref: 'NEFT-SEP' })).status).toBe(200);
    expect(await heldRow('A')).toMatchObject({ state: 'PAID', pay_ym: SEP });
  });

  it('the held salaries list shows what was held and how it was paid', async () => {
    const d = (await f.agent.get('/api/v1/held-salaries')).body.data;
    const byCode = Object.fromEntries(d.holds.map((h) => [h.employee.code, h]));
    expect(byCode.T001.months).toEqual([expect.objectContaining({ period_ym: YM, state: 'PAID', pay_ym: SEP })]);
    expect(byCode.T003.months).toEqual([expect.objectContaining({ state: 'PAID_SEPARATELY', payment_ref: 'CASH-77' })]);
    expect(byCode.T002.released_at).not.toBeNull();
    expect(d.totals).toMatchObject({ standing: 0, unpaid_months: 0, unpaid: 0 });
  });

  it('a hold that has held nothing yet can be stopped', async () => {
    expect((await hold('B', { from_ym: '2026-10', reason: 'Inquiry reopened' })).status).toBe(201);
    expect((await f.agent.post(`/api/v1/employees/${f.employees.B}/hold/stop`)).status).toBe(200);
    expect((await f.agent.post(`/api/v1/employees/${f.employees.B}/hold/stop`)).status).toBe(409);
  });
});
