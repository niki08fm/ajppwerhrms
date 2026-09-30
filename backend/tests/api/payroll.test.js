import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { buildFixture, R, runAndWait, submitSteps, waitJob, YM } from './fixture.js';

let f;
const P = `/api/v1/payroll/periods/${YM}`;

afterAll(async () => {
  await prisma.$disconnect();
});

describe('§20.25 Step gates', () => {
  beforeEach(async () => {
    f = await buildFixture({ noBankFor: ['C'] });
  });

  it('step 2 cannot be submitted before step 1', async () => {
    const r = await f.agent.post(`${P}/steps/2/submit`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('STEP_NOT_SUBMITTED');
  });

  it('step 3 cannot be submitted while a blocking issue stands and the person is not held back', async () => {
    await submitSteps(f.agent, YM, 2);
    const r = await f.agent.post(`${P}/steps/3/submit`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('BLOCKING_ISSUES');
    expect(r.body.error.details.some((i) => i.kind === 'NO_BANK')).toBe(true);

    const hold = await f.agent.post(`${P}/exclusions`).send({ employee_id: f.employees.C, reason: 'Bank details pending' });
    expect(hold.status).toBe(200);
    const ok = await f.agent.post(`${P}/steps/3/submit`);
    expect(ok.status).toBe(200);
  });

  it('a run is refused until steps 1–4 are submitted', async () => {
    const r = await f.agent.post(`${P}/run`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('STEP_NOT_SUBMITTED');
  });
});

describe('§20.26 Reopen cascades', () => {
  it('reopening step 3 clears steps 3 and 4 and leaves 1 and 2 submitted', async () => {
    f = await buildFixture();
    await submitSteps(f.agent, YM, 4);
    const r = await f.agent.post(`${P}/steps/3/reopen`);
    expect(r.status).toBe(200);
    expect(r.body.data.steps_submitted).toEqual([1, 2]);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'payroll.step.reopen' } });
    expect(audit?.detail).toMatchObject({ step: 3, cleared: [3, 4] });
  });
});

describe('§20.27 Lock freezes', () => {
  it('a salary change after locking leaves the locked payslip; unlock and rerun picks it up', async () => {
    f = await buildFixture();
    await submitSteps(f.agent, YM, 4);
    const job = await runAndWait(f.agent, YM);
    expect(job.status).toBe('DONE');
    expect((await f.agent.post(`${P}/lock`)).status).toBe(200);

    const before = await f.agent.get(`${P}/payslips/${f.employees.A}`);
    expect(before.status).toBe(200);
    const lockedGross = before.body.data.gross;

    // Raise A's salary effective the first of the locked month.
    const rev = await f.agent.post(`/api/v1/employees/${f.employees.A}/salary`).send({ mode: 'GROSS', amount: R(26000), valid_from: `${YM}-01`, reason: 'Increment' });
    expect(rev.status).toBe(201);

    const live = await f.agent.get(`/api/v1/employees/${f.employees.A}/payslip-preview?month=${YM}`);
    expect(live.body.data.result.gross).toBeGreaterThan(lockedGross);
    const stillLocked = await f.agent.get(`${P}/payslips/${f.employees.A}`);
    expect(stillLocked.body.data.gross).toBe(lockedGross);

    // The database itself refuses to change a locked payslip.
    await expect(prisma.payslip.updateMany({ where: { employee_id: f.employees.A }, data: { net: 1n } })).rejects.toThrow(/cannot be changed/);

    expect((await f.agent.post(`${P}/unlock`)).status).toBe(200);
    expect((await runAndWait(f.agent, YM)).status).toBe('DONE');
    const after = await f.agent.get(`${P}/payslips/${f.employees.A}`);
    expect(after.body.data.gross).toBe(live.body.data.result.gross);
  });
});

describe('§20.28 Full lifecycle', () => {
  it('DRAFT → RUN → LOCKED → PAID → LOCKED → RUN → rerun, each audited, totals reconciling', async () => {
    f = await buildFixture();
    await submitSteps(f.agent, YM, 4);
    const reconcile = async () => {
      const slips = await prisma.payslip.findMany({ where: { period: { period_ym: YM } } });
      for (const s of slips) expect(s.gross - s.total_deductions + s.reimbursements).toBe(s.net);
      const lines = await prisma.payslipLine.findMany({ where: { payslip: { period: { period_ym: YM } } } });
      for (const s of slips) {
        const earn = lines.filter((l) => l.payslip_id === s.id && ['COMPONENT', 'YEARLY', 'OT', 'OFFDAY', 'ADHOC'].includes(l.kind)).reduce((a, l) => a + l.amount, 0n);
        expect(earn).toBe(s.gross);
      }
      return slips.length;
    };

    expect((await runAndWait(f.agent, YM)).status).toBe('DONE');
    expect(await reconcile()).toBe(3);
    expect((await f.agent.post(`${P}/lock`)).body.data.state).toBe('LOCKED');
    const paid = await f.agent.post(`${P}/mark-paid`).set('Idempotency-Key', 'pay-1').send({ payment_ref: 'NEFT-TEST-1' });
    expect(paid.body.data.state).toBe('PAID');
    // Double submit: the same result, no second payment.
    const again = await f.agent.post(`${P}/mark-paid`).set('Idempotency-Key', 'pay-1').send({ payment_ref: 'NEFT-TEST-1' });
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect((await f.agent.post(`${P}/unmark-paid`)).body.data.state).toBe('LOCKED');
    expect((await f.agent.post(`${P}/unlock`)).body.data.state).toBe('RUN');
    expect((await runAndWait(f.agent, YM)).status).toBe('DONE');
    expect(await reconcile()).toBe(3);
    expect((await f.agent.post(`${P}/back-to-steps`)).body.data.state).toBe('DRAFT');
    expect(await prisma.payslip.count()).toBe(0);

    const actions = (await prisma.auditLog.findMany({ where: { entity_type: 'payroll_period' }, orderBy: { at: 'asc' } })).map((a) => a.action);
    for (const a of ['payroll.run', 'payroll.lock', 'payroll.mark_paid', 'payroll.unmark_paid', 'payroll.unlock', 'payroll.rerun', 'payroll.back_to_steps']) expect(actions).toContain(a);
    const lock = await prisma.auditLog.findFirst({ where: { action: 'payroll.lock' } });
    expect(lock?.detail).toMatchObject({ from: 'RUN', to: 'LOCKED' });
  });

  it('an invalid transition is refused with a clear message', async () => {
    f = await buildFixture();
    const r = await f.agent.post(`${P}/lock`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INVALID_TRANSITION');
  });
});

describe('§20.29 Concurrent run', () => {
  it('two simultaneous run requests: one run and one clear rejection', async () => {
    f = await buildFixture();
    await submitSteps(f.agent, YM, 4);
    const [a, b] = await Promise.all([f.agent.post(`${P}/run`), f.agent.post(`${P}/run`)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([202, 409]);
    const rejected = a.status === 409 ? a : b;
    expect(rejected.body.error.code).toBe('RUN_IN_PROGRESS');
    const accepted = a.status === 202 ? a : b;
    expect((await waitJob(f.agent, accepted.body.data.job_id)).status).toBe('DONE');
    expect(await prisma.payslip.count()).toBe(3);
  });
});

describe('§20.30 Pipeline excluded', () => {
  it('people on offer, accepted or onboarding never appear in a run', async () => {
    f = await buildFixture();
    await submitSteps(f.agent, YM, 4);
    await runAndWait(f.agent, YM);
    const ids = (await prisma.payslip.findMany({ select: { employee_id: true } })).map((p) => p.employee_id);
    expect(ids).not.toContain(f.employees.OFFER);
    expect(ids).not.toContain(f.employees.ONBOARD);
    expect(ids).toHaveLength(3);
  });
});

describe('§20.31 Held back', () => {
  it('someone excluded does not appear in the run and stays on the held-back list', async () => {
    f = await buildFixture();
    await f.agent.post(`${P}/exclusions`).send({ employee_id: f.employees.B, reason: 'Disputed attendance' });
    await submitSteps(f.agent, YM, 4);
    await runAndWait(f.agent, YM);
    const ids = (await prisma.payslip.findMany({ select: { employee_id: true } })).map((p) => p.employee_id);
    expect(ids).not.toContain(f.employees.B);
    const held = await f.agent.get('/api/v1/payroll/held-back');
    expect(held.body.data.map((h) => h.employee.id)).toContain(f.employees.B);
    expect(held.body.data[0].period_ym).toBe(YM);
  });
});

describe('Reports', () => {
  it('all twelve reports build from the snapshot and the bank file carries only positive amounts', async () => {
    f = await buildFixture();
    await submitSteps(f.agent, YM, 4);
    await runAndWait(f.agent, YM);
    const list = await f.agent.get('/api/v1/payroll/reports');
    expect(list.body.data).toHaveLength(12);
    for (const r of list.body.data) {
      const res = await f.agent.get(`${P}/report/${r.key}`);
      expect(res.status, r.key).toBe(200);
    }
    const bank = await f.agent.get(`${P}/report/bank`);
    for (const row of bank.body.data.rows) expect(row.amount).toBeGreaterThan(0);
    const csv = await f.agent.get(`${P}/report/register?format=csv`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/payroll-register-2026-08\.csv/);
  });
});
