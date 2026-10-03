import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { toDbDate } from '../../src/utils/dbDates.js';
import { buildFixture, runAndWait, submitSteps, YM } from './fixture.js';

// The fixture's leave policy: paid leave earns 1.25 a month and pays absences, at most 3 a month;
// sick leave is recorded by HR; maternity leave is for women. Everyone in it is a man.
let f;
const P = `/api/v1/payroll/periods/${YM}`;

beforeAll(async () => {
  f = await buildFixture();
});
afterAll(async () => {
  await prisma.$disconnect();
});

const absent = (key, date) =>
  f.agent
    .post('/api/v1/attendance/overrides')
    .send({ employee_id: f.employees[key], work_date: date, mode: 'MARK', status: 'ABSENT', reason_text: 'Did not come in that day' });
const adjust = (key, leave_type, date, days) => f.agent.post('/api/v1/leave/adjustments').send({ employee_id: f.employees[key], leave_type, date, days, reason: 'Opening balance from the old records' });
const step1 = async (key) => (await f.agent.get(`${P}/attendance`)).body.data.rows.find((r) => r.employee.id === f.employees[key]);
const balance = async (key, date, code) => (await f.agent.get('/api/v1/leave/balances').query({ date })).body.data.find((r) => r.employee.id === f.employees[key]).types.find((t) => t.code === code);

describe('Absences nobody applied for are paid from paid leave', () => {
  it('up to the balance and the monthly limit; the rest is loss of pay', async () => {
    for (const d of ['03', '04', '05', '06']) expect((await absent('A', `${YM}-${d}`)).status).toBe(201);
    expect((await adjust('A', 'PL', `${YM}-01`, 2)).status).toBe(201);
    // 2 brought in + 1.25 earned in August, but at most 3 a month: three of the four absences are paid.
    const a = await step1('A');
    expect(a.auto_leave_days).toBe(3);
    expect(a.lop_days).toBe(1);
    expect(await balance('A', `${YM}-31`, 'PL')).toMatchObject({ balance: 0.25, auto_ytd: 3, adjusted_ytd: 2, earned_ytd: 1.25 });
  });
});

describe('Leave HR records is paid from its own balance', () => {
  const body = () => ({ employee_id: f.employees.B, leave_type: 'SL', from_date: `${YM}-10`, to_date: `${YM}-11`, days: 1, reason: 'Fever' });

  it('sick leave uses sick leave, not paid leave', async () => {
    expect((await adjust('B', 'SL', `${YM}-01`, 5)).status).toBe(201);
    const pv = await f.agent.post('/api/v1/leave/preview').send(body());
    expect(pv.body.data).toMatchObject({ errors: [], working_days: 2 });
    const r = await f.agent.post('/api/v1/leave').send(body());
    expect(r.status).toBe(201);
    expect(r.body.data.days).toBe(2);
    expect((await f.agent.post(`/api/v1/leave/${r.body.data.id}/decide`).send({ decision: 'APPROVE' })).status).toBe(200);
    const b = await step1('B');
    expect(b.leave_days).toBe(2);
    expect(b.auto_leave_days).toBe(0);
    expect(b.lop_days).toBe(0);
    expect(await balance('B', `${YM}-31`, 'SL')).toMatchObject({ balance: 3, used_ytd: 2 });
  });

  it('the check warns before more is recorded than is left, and refuses leave the person cannot take', async () => {
    const more = await f.agent.post('/api/v1/leave/preview').send({ ...body(), from_date: `${YM}-24`, to_date: `${YM}-29` });
    expect(more.body.data.working_days).toBe(6);
    expect(more.body.data.warnings.join(' ')).toMatch(/Only 3 days of Sick leave left/);
    const ml = await f.agent.post('/api/v1/leave').send({ ...body(), leave_type: 'ML', from_date: `${YM}-17`, to_date: `${YM}-18` });
    expect(ml.status).toBe(422);
    expect(ml.body.error.message).toMatch(/women only/);
  });
});

describe('A locked month keeps its leave', () => {
  it('no adjustment can be dated in it, and the next month starts from what its payslips recorded', async () => {
    await submitSteps(f.agent, YM, 4);
    expect((await runAndWait(f.agent, YM)).status).toBe('DONE');
    expect((await f.agent.post(`${P}/lock`)).status).toBe(200);

    const late = await adjust('A', 'PL', `${YM}-20`, 1);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('PERIOD_LOCKED');

    const slip = await prisma.payslip.findFirst({ where: { employee_id: f.employees.A, period: { period_ym: YM } } });
    expect(slip.meta.leave.types.find((t) => t.code === 'PL').closing).toBe(0.25);
    // Written straight into the locked month, an adjustment changes nothing: September opens with August's 0.25.
    await prisma.leaveAdjustment.create({ data: { employee_id: f.employees.A, leave_type: 'PL', date: toDbDate(`${YM}-20`), days: 10, reason: 'Past the lock' } });
    expect(await balance('A', '2026-09-01', 'PL')).toMatchObject({ opening: 0.25, earned: 1.25 });
  });
});
