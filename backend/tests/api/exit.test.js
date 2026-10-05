import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { buildFixture, R, runAndWait, submitSteps, YM } from './fixture.js';

// Person C earns ₹30,000 gross, Person B ₹24,000. There is no notice period and no exit policy.
let f;
const C = () => f.employees.C;
const P = `/api/v1/payroll/periods/${YM}`;

beforeAll(async () => {
  f = await buildFixture();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const settlement = async (id = C()) => (await f.agent.get(`/api/v1/settlements/${id}`)).body.data;
const line = (s, code) => [...s.result.earnings, ...s.result.deductions].find((l) => l.code === code);
const adjust = (body, id = C()) => f.agent.post(`/api/v1/settlements/${id}/adjust`).send(body);
const exitOf = async (id = C()) => (await f.agent.get(`/api/v1/employees/${id}/exit`)).body.data;
const tickAll = async (id) => {
  for (const code of ['HANDOVER', 'ASSETS', 'NO_DUES']) expect((await f.agent.post(`/api/v1/employees/${id}/exit/tasks/${code}`).send({ done: true })).status).toBe(200);
};

describe('An exit has no notice period and no policy', () => {
  it('any kind of exit is recorded with its last day; nothing is recovered or paid for notice', async () => {
    const r = await f.agent.post(`/api/v1/employees/${C()}/resign`).send({ resigned_on: '2026-09-21', last_day: '2026-09-30', exit_reason: 'TERMINATION' });
    expect(r.status).toBe(200);
    const s = await settlement();
    expect([...s.result.earnings, ...s.result.deductions].some((l) => l.code.startsWith('NOTICE'))).toBe(false);
    const x = await exitOf();
    expect(x).toMatchObject({ status: 'NOTICE', last_day: '2026-09-30', exit_reason: 'TERMINATION' });
    expect(x).not.toHaveProperty('notice_days');

    const changed = await f.agent.patch(`/api/v1/employees/${C()}/exit`).send({ resigned_on: '2026-09-21', last_day: '2026-09-30', exit_reason: 'RESIGNATION' });
    expect(changed.status).toBe(200);
    expect((await settlement()).result.net).toBe(s.result.net);
  });

  it('there is no exit policy to create', async () => {
    const r = await f.agent.post('/api/v1/policies').send({ kind: 'EXIT', name: 'Exits', valid_from: '2025-01-01', rules: { types: [], checklist: [] } });
    expect(r.status).toBe(422);
  });
});

describe('The exit checklist', () => {
  it('the same tasks for everyone; open required tasks block the relieving letter until ticked', async () => {
    const x = await exitOf();
    expect(x.checklist.map((t) => t.code)).toEqual(['HANDOVER', 'ASSETS', 'NO_DUES', 'EXIT_INTERVIEW']);
    expect((await settlement()).result.clearance.map((c) => c.code)).toContain('EXIT_CHECKLIST');
    expect((await f.agent.post(`/api/v1/employees/${C()}/letters`).send({ kind: 'RELIEVING' })).status).toBe(422);
    await tickAll(C());
    expect((await settlement()).result.clearance.map((c) => c.code)).not.toContain('EXIT_CHECKLIST');
    expect((await f.agent.post(`/api/v1/employees/${C()}/letters`).send({ kind: 'RELIEVING' })).status).toBe(201);
  });
});

describe("HR's changes to a settlement", () => {
  it('add lines and take them away, each with its reason; statutory lines stay', async () => {
    const before = await settlement();
    expect((await adjust({ action: 'ADD_LINE', kind: 'EARNING', name: 'Project bonus', amount: R(2500), reason: 'Promised for the Alpha handover' })).status).toBe(200);
    expect((await adjust({ action: 'ADD_LINE', kind: 'DEDUCTION', name: 'Damaged multimeter', amount: R(1200), reason: 'Signed off by stores' })).status).toBe(200);
    let s = await settlement();
    expect(s.result.net).toBe(before.result.net + R(2500) - R(1200));

    expect((await adjust({ action: 'EXCLUDE', code: 'PF', reason: 'Trying to skip statutory' })).status).toBe(422);
    expect((await adjust({ action: 'SET_DAYS', code: 'FINAL_SALARY', days: 3, reason: 'Not a day-based line' })).status).toBe(422);
    expect((await adjust({ action: 'ADD_LINE', kind: 'DEDUCTION', name: 'Tools', amount: R(100), reason: 'short' })).status).toBe(422);

    for (const l of s.result.earnings.concat(s.result.deductions).filter((x) => x.added)) expect((await adjust({ action: 'REMOVE_LINE', id: l.id })).status).toBe(200);
    s = await settlement();
    expect(s.result.net).toBe(before.result.net);
    expect(await prisma.auditLog.count({ where: { action: 'settlement.adjust' } })).toBe(4);
  });
});

describe('Processing the F&F', () => {
  const B = () => f.employees.B;
  const processFnf = (body) => f.agent.post(`/api/v1/employees/${B()}/exit/process`).send(body);

  it('waits for the checklist, goes in the month of the last day or later, and can be taken back', async () => {
    expect((await f.agent.post(`/api/v1/employees/${B()}/resign`).send({ resigned_on: '2026-08-01', last_day: '2026-08-31', exit_reason: 'RESIGNATION' })).status).toBe(200);
    const early = await processFnf({ period_ym: YM });
    expect(early.status).toBe(409);
    expect(early.body.error.message).toMatch(/checklist/);
    await tickAll(B());
    expect((await processFnf({ period_ym: '2026-07' })).status).toBe(422);

    const r = await processFnf({ period_ym: YM });
    expect(r.status).toBe(200);
    let x = await exitOf(B());
    expect(x.settlement).toMatchObject({ state: 'INCLUDED', period_ym: YM, paid_separately: null });
    expect((await prisma.payrollPeriod.findUnique({ where: { period_ym: YM } })).settlement_ids).toContain(x.settlement.id);
    expect((await processFnf({ period_ym: YM })).status).toBe(409);
    // While processed, the exit cannot be withdrawn.
    expect((await f.agent.post(`/api/v1/employees/${B()}/exit/withdraw`).send({ reason: 'Stayed after a counter-offer' })).status).toBe(409);

    expect((await f.agent.delete(`/api/v1/employees/${B()}/exit/process`)).status).toBe(200);
    x = await exitOf(B());
    expect(x.settlement).toMatchObject({ state: 'OPEN', period_ym: null });
  });

  it('paid separately, it is in that month’s payroll but never in its bank file — and paid once', async () => {
    const r = await processFnf({ period_ym: YM, paid_separately: { paid_on: '2026-09-02', payment_ref: 'CHQ-004512' } });
    expect(r.status).toBe(200);
    await submitSteps(f.agent, YM, 5);
    expect((await runAndWait(f.agent, YM)).status).toBe('DONE');

    const bank = (await f.agent.get(`${P}/report/bank`)).body.data;
    expect(bank.rows.some((row) => row.code === 'T002')).toBe(false);
    expect(bank.notes.join(' ')).toMatch(/1 F&F was paid separately/);
    const register = (await f.agent.get(`${P}/report/register`)).body.data;
    expect(register.rows.find((row) => row.code === 'T002')).toMatchObject({ payment: 'F&F, paid separately' });

    expect((await f.agent.post(`${P}/lock`)).status).toBe(200);
    expect((await f.agent.post(`${P}/mark-paid`).set('Idempotency-Key', 'exit-pay-1').send({ payment_ref: 'NEFT-AUG' })).status).toBe(200);
    const s = await prisma.settlement.findFirstOrThrow({ where: { employee_id: B() } });
    expect(s.state).toBe('PAID');
    expect(s.paid_separately).toMatchObject({ payment_ref: 'CHQ-004512' });
    expect((await prisma.employee.findUnique({ where: { id: B() } })).status).toBe('EXITED');
    // Paid: it cannot be processed again.
    expect((await processFnf({ period_ym: '2026-09' })).status).toBe(409);
  });
});

describe('Withdrawing an exit', () => {
  it('the person is active again and the open settlement is set aside', async () => {
    const r = await f.agent.post(`/api/v1/employees/${f.employees.A}/resign`).send({ resigned_on: '2026-09-01', last_day: '2026-09-30', exit_reason: 'RESIGNATION' });
    expect(r.status).toBe(200);
    const ok = await f.agent.post(`/api/v1/employees/${f.employees.A}/exit/withdraw`).send({ reason: 'Stayed after a counter-offer' });
    expect(ok.status).toBe(200);
    expect(await exitOf(f.employees.A)).toMatchObject({ status: 'ACTIVE', last_day: null, exit_reason: null, settlement: null });
  });
});
