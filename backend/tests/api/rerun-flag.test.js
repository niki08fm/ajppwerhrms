import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { buildFixture, R, runAndWait, submitSteps, YM } from './fixture.js';

let f;
const P = `/api/v1/payroll/periods/${YM}`;
const period = async () => (await f.agent.get(P)).body.data;

afterAll(async () => {
  await prisma.$disconnect();
});
beforeEach(async () => {
  f = await buildFixture();
  await submitSteps(f.agent, YM, 6);
  expect((await runAndWait(f.agent, YM)).status).toBe('DONE');
});

describe('A generated month flags changes that reach it', () => {
  it('a policy version covering the month: regenerate before locking, and regenerating clears it', async () => {
    const leave = await prisma.policy.findFirstOrThrow({ where: { kind: 'LEAVE', deleted_at: null } });
    const published = await f.agent.post(`/api/v1/policies/${leave.policy_key}/versions`).send({ valid_from: `${YM}-10`, rules: leave.rules });
    expect(published.status, JSON.stringify(published.body)).toBe(201);
    expect((await period()).rerun_reason).toMatch(/leave policy/);
    const lock = await f.agent.post(`${P}/lock`);
    expect(lock.status).toBe(409);
    expect(lock.body.error.code).toBe('RERUN_NEEDED');
    expect((await runAndWait(f.agent, YM)).status).toBe('DONE');
    expect((await period()).rerun_reason).toBeNull();
    expect((await f.agent.post(`${P}/lock`)).status).toBe(200);
  });

  it('a change starting after the month leaves it alone', async () => {
    const att = await prisma.policy.findFirstOrThrow({ where: { kind: 'WEEKOFF_PAY', deleted_at: null } });
    expect((await f.agent.post(`/api/v1/policies/${att.policy_key}/versions`).send({ valid_from: '2026-11-01', rules: att.rules })).status).toBe(201);
    expect((await period()).rerun_reason).toBeNull();
  });

  it('a holiday, a salary revision or a pay group setting in the month flags it', async () => {
    expect((await f.agent.post('/api/v1/holidays').send({ date: `${YM}-20`, name: 'Site holiday' })).status).toBe(201);
    expect((await period()).rerun_reason).toMatch(/holiday/);
    expect((await runAndWait(f.agent, YM)).status).toBe('DONE');
    const revision = await f.agent.post(`/api/v1/employees/${f.employees.A}/salary`).send({ mode: 'GROSS', amount: R(26000), valid_from: `${YM}-01`, structure_id: f.structureId, reason: 'Increment' });
    expect(revision.status, JSON.stringify(revision.body)).toBe(201);
    expect((await period()).rerun_reason).toMatch(/salary/);
    expect((await runAndWait(f.agent, YM)).status).toBe('DONE');
    expect((await f.agent.patch(`/api/v1/pay-groups/${f.payGroupId}`).send({ weekly_off: ['SUN', 'SAT'] })).status).toBe(200);
    expect((await period()).rerun_reason).toMatch(/pay group/);
  });
});
