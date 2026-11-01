import { afterAll, beforeEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/config/db.js';
import { buildFixture } from './fixture.js';
let f,
  readGate = null;
prisma.$use(async (params, next) => {
  const row = await next(params);
  if (readGate && params.model === 'PayrollPeriod' && params.action === 'findUnique') {
    const notify = readGate;
    readGate = null;
    notify();
  }
  return row;
});
beforeEach(async () => {
  readGate = null;
  f = await buildFixture();
});
afterAll(() => prisma.$disconnect());
for (const action of ['submit', 'reopen']) it(`rechecks payroll state after waiting for the ${action} lock`, async () => {
  const period = await prisma.payrollPeriod.create({
    data: {
      period_ym: '2026-08',
      steps_submitted: action === 'reopen' ? [1, 2, 3] : []
    }
  });
  let startRequest, observed;
  const held = new Promise(r => startRequest = r),
    read = new Promise(r => observed = r);
  const change = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM payroll_period WHERE id=${period.id}::uuid FOR UPDATE`;
    startRequest();
    await read;
    await tx.payrollPeriod.update({
      where: {
        id: period.id
      },
      data: {
        state: 'RUN'
      }
    });
  });
  await held;
  readGate = observed;
  const request = f.agent.post(`/api/v1/payroll/periods/2026-08/steps/1/${action}`).then(r => r);
  await change;
  expect((await request).status).toBe(409);
  const after = await prisma.payrollPeriod.findUnique({
    where: {
      id: period.id
    }
  });
  expect(after.steps_submitted).toEqual(period.steps_submitted);
});
it('does not reopen or confirm reviews while generation is queued', async () => {
  const period = await prisma.payrollPeriod.create({
    data: {
      period_ym: '2026-08',
      steps_submitted: [1],
      running_job_id: randomUUID()
    }
  });
  for (const action of ['submit', 'reopen']) {
    const result = await f.agent.post(`/api/v1/payroll/periods/2026-08/steps/1/${action}`);
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('PAYROLL_RUNNING');
  }
  expect((await prisma.payrollPeriod.findUnique({
    where: {
      id: period.id
    }
  })).steps_submitted).toEqual([1]);
});
