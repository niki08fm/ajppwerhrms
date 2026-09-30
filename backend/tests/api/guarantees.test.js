import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../../src/config/db.js';
import { app, buildFixture, R, submitSteps, YM } from './fixture.js';

let f;

beforeAll(async () => {
  f = await buildFixture();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('The punch ledger is append-only', () => {
  it('the database refuses to update or delete a punch', async () => {
    const p = await prisma.punch.findFirstOrThrow();
    await expect(prisma.punch.update({ where: { id: p.id }, data: { distance_m: 1 } })).rejects.toThrow(/append-only/);
    await expect(prisma.punch.delete({ where: { id: p.id } })).rejects.toThrow(/append-only/);
  });

  it('the audit log is insert-only', async () => {
    const a = await prisma.auditLog.findFirstOrThrow();
    await expect(prisma.auditLog.update({ where: { id: a.id }, data: { action: 'x' } })).rejects.toThrow(/insert-only/);
  });
});

describe('Salary records never overlap', () => {
  it('the exclusion constraint rejects an overlapping row', async () => {
    const s = await prisma.employeeSalary.findFirstOrThrow({ where: { employee_id: f.employees.A } });
    await expect(
      prisma.employeeSalary.create({
        data: { employee_id: f.employees.A, valid_from: new Date('2026-01-01'), mode: 'GROSS', amount: 1n, monthly_gross: 1n, structure_id: s.structure_id, reason: 'x' },
      }),
    ).rejects.toThrow();
  });

  it('a revision closes the old row the day before and inserts a new one', async () => {
    const r = await f.agent.post(`/api/v1/employees/${f.employees.B}/salary`).send({ mode: 'GROSS', amount: R(25000), valid_from: '2026-10-01', reason: 'Increment' });
    expect(r.status).toBe(201);
    const rows = await prisma.employeeSalary.findMany({ where: { employee_id: f.employees.B }, orderBy: { valid_from: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0].valid_to?.toISOString().slice(0, 10)).toBe('2026-09-30');
    const hist = await f.agent.get(`/api/v1/employees/${f.employees.B}/salary`);
    expect(hist.body.data[0].valid_from).toBe('2026-10-01');
  });
});

describe('Attendance corrections', () => {
  it('rejects an override that changes nothing, stores computed and overridden values, and reverts exactly', async () => {
    const date = `${YM}-03`;
    const day = await f.agent.get(`/api/v1/attendance/day?employee_id=${f.employees.A}&date=${date}`);
    const c = day.body.data.computed;
    const same = await f.agent
      .post('/api/v1/attendance/overrides')
      .send({
        employee_id: f.employees.A,
        work_date: date,
        status: c.status,
        day_value: c.day_value,
        worked_min: c.worked_min,
        ot_min: c.ot_min,
        late_min: c.late_min,
        reason_code: 'DATA_ERROR',
        reason_text: 'Nothing actually changes here',
      });
    expect(same.status).toBe(422);
    expect(same.body.error.code).toBe('NO_CHANGE');

    const short = await f.agent
      .post('/api/v1/attendance/overrides')
      .send({ employee_id: f.employees.A, work_date: date, status: 'HALF_DAY', day_value: 0.5, worked_min: 240, ot_min: 0, late_min: 0, reason_code: 'OTHER', reason_text: 'short' });
    expect(short.status).toBe(422);

    const ok = await f.agent
      .post('/api/v1/attendance/overrides')
      .send({
        employee_id: f.employees.A,
        work_date: date,
        status: 'HALF_DAY',
        day_value: 0.5,
        worked_min: 240,
        ot_min: 0,
        late_min: 0,
        reason_code: 'SITE_INSTRUCTION',
        reason_text: 'Sent home at noon by the site engineer',
      });
    expect(ok.status).toBe(201);
    const stored = await prisma.attendanceOverride.findFirstOrThrow({ where: { employee_id: f.employees.A } });
    expect(stored.computed_snapshot).toMatchObject({ status: c.status, worked_min: c.worked_min });

    const rev = await f.agent.delete(`/api/v1/attendance/overrides/${stored.id}`);
    expect(rev.status).toBe(200);
    const after = await f.agent.get(`/api/v1/attendance/day?employee_id=${f.employees.A}&date=${date}`);
    expect(after.body.data.override).toBeNull();
    expect(after.body.data.computed.status).toBe(c.status);
  });

  it('once step 1 is submitted, corrections stop until it is reopened', async () => {
    await submitSteps(f.agent, YM, 1);
    const r = await f.agent
      .post('/api/v1/attendance/overrides')
      .send({
        employee_id: f.employees.A,
        work_date: `${YM}-04`,
        status: 'ABSENT',
        day_value: 0,
        worked_min: 0,
        ot_min: 0,
        late_min: 0,
        reason_code: 'DATA_ERROR',
        reason_text: 'Was not actually on site',
      });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ATTENDANCE_FROZEN');
    expect(r.body.error.message).toMatch(/Reopen step 1/);
    await f.agent.post(`/api/v1/payroll/periods/${YM}/steps/1/reopen`);
  });
});

describe('Optimistic concurrency', () => {
  it('a PATCH with a stale updated_at is rejected with 409', async () => {
    const e = await f.agent.get(`/api/v1/employees/${f.employees.A}`);
    const seen = e.body.data.updated_at;
    const first = await f.agent.patch(`/api/v1/employees/${f.employees.A}`).send({ designation: 'Foreman', updated_at: seen });
    expect(first.status).toBe(200);
    const second = await f.agent.patch(`/api/v1/employees/${f.employees.A}`).send({ designation: 'Lineman', updated_at: seen });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('STALE_UPDATE');
  });

  it('unknown fields are rejected rather than ignored', async () => {
    const e = await f.agent.get(`/api/v1/employees/${f.employees.A}`);
    const r = await f.agent.patch(`/api/v1/employees/${f.employees.A}`).send({ site_id: 'x', updated_at: e.body.data.updated_at });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/Unknown field/);
  });
});

describe('Personal data', () => {
  it('Aadhaar is masked, PAN is encrypted at rest, and every read of identity is logged', async () => {
    const before = await prisma.auditLog.count({ where: { action: 'pii.read' } });
    const e = await f.agent.get(`/api/v1/employees/${f.employees.A}`);
    expect(e.body.data.identity.aadhaar_masked).toBe('XXXX XXXX 1234');
    expect(e.body.data.identity.pan).not.toBe('ABCDE1234F');
    const row = await prisma.employeeIdentity.findUniqueOrThrow({ where: { employee_id: f.employees.A } });
    expect(row.pan_enc).not.toContain('ABCDE');
    expect(await prisma.auditLog.count({ where: { action: 'pii.read' } })).toBe(before + 1);
  });
});

describe('Auth', () => {
  it('rejects unauthenticated requests with a readable message', async () => {
    const r = await request(app).get('/api/v1/employees');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('site login works only inside the geofence, and the rejection is logged', async () => {
    const outside = await request(app).post('/api/v1/auth/site-login').send({ login: 'site-alpha', password: 'site-pass-1', lat: 17.385, lng: 78.4867, accuracy_m: 10 });
    expect(outside.status).toBe(403);
    expect(outside.body.error.code).toBe('GEOFENCE_REJECTED');
    expect(await prisma.auditLog.count({ where: { action: 'geofence.rejected' } })).toBeGreaterThan(0);

    const poor = await request(app).post('/api/v1/auth/site-login').send({ login: 'site-alpha', password: 'site-pass-1', lat: 16.5062, lng: 80.648, accuracy_m: 120 });
    expect(poor.status).toBe(403);

    const tablet = request.agent(app);
    const inside = await tablet.post('/api/v1/auth/site-login').send({ login: 'site-alpha', password: 'site-pass-1', lat: 16.5063, lng: 80.6481, accuracy_m: 12 });
    expect(inside.status).toBe(200);
    // A site token cannot read salaries or the employee list.
    expect((await tablet.get('/api/v1/employees')).status).toBe(401);
    expect((await tablet.get('/api/v1/tablet/summary')).status).toBe(200);
    // A punch from outside the fence is rejected even with a valid session.
    const far = await tablet.post('/api/v1/punches/identify').send({ embedding: Array(128).fill(0.1), lat: 17.385, lng: 78.4867, accuracy_m: 10 });
    expect(far.status).toBe(403);
  });

  it('rotation invalidates existing tablet tokens', async () => {
    const tablet = request.agent(app);
    await tablet.post('/api/v1/auth/site-login').send({ login: 'site-alpha', password: 'site-pass-1', lat: 16.5063, lng: 80.6481, accuracy_m: 12 });
    expect((await tablet.get('/api/v1/tablet/summary')).status).toBe(200);
    const rot = await f.agent.post(`/api/v1/sites/${f.siteId}/reissue-login`);
    expect(rot.status).toBe(200);
    expect((await tablet.get('/api/v1/tablet/summary')).status).toBe(401);
  });
});

describe('Tablet punch', () => {
  it('identifies, punches once, and deduplicates a retry on (employee, site, client time)', async () => {
    const emb = Array.from({ length: 128 }, (_, i) => Math.sin(i + 1));
    await f.agent.post(`/api/v1/employees/${f.employees.A}/face`).send({ embedding: emb, model_version: 'test', consent: true });
    const pw = (await f.agent.post(`/api/v1/sites/${f.siteId}/reissue-login`)).body.data.password;
    const tablet = request.agent(app);
    await tablet.post('/api/v1/auth/site-login').send({ login: 'site-alpha', password: pw, lat: 16.5063, lng: 80.6481, accuracy_m: 12 });
    const id = await tablet.post('/api/v1/punches/identify').send({ embedding: emb, lat: 16.5063, lng: 80.6481, accuracy_m: 12 });
    expect(id.status).toBe(200);
    expect(id.body.data.matched).toBe(true);
    expect(id.body.data.employee.id).toBe(f.employees.A);
    const body = {
      direction: id.body.data.direction,
      client_punched_at: new Date().toISOString(),
      lat: 16.5063,
      lng: 80.6481,
      accuracy_m: 12,
      match_token: id.body.data.match_token,
      device_id: 'tab-1',
    };
    const p1 = await tablet.post('/api/v1/punches').send(body);
    expect(p1.status).toBe(201);
    const p2 = await tablet.post('/api/v1/punches').send(body);
    expect(p2.status).toBe(200);
    expect(p2.body.data.duplicate).toBe(true);
  });
});

describe('Salary structures: name, percentage or fixed, % of gross, CTC or basic, an optional maximum', () => {
  const comp = (seq, name, calc_type, calc_value, extra = {}) => ({
    seq,
    name,
    calc_type,
    calc_value,
    max_amount: null,
    frequency: 'MONTHLY',
    pay_month: null,
    is_taxable: true,
    counts_as_wages: name === 'Basic',
    colour: 'chart-1',
    ...extra,
  });

  it('a structure sent without a Special Allowance gets one, last', async () => {
    const r = await f.agent.post('/api/v1/structures').send({ name: 'No balance sent', components: [comp(1, 'Basic', 'PCT_GROSS', 50), comp(2, 'HRA', 'PCT_BASIC', 40)] });
    expect(r.status).toBe(201);
    const last = r.body.data.components.at(-1);
    expect(last).toMatchObject({ name: 'Special Allowance', calc_type: 'BALANCE', frequency: 'MONTHLY' });
    expect(r.body.data.sample.monthly.reduce((s, c) => s + c.amount, 0)).toBe(r.body.data.sample.gross);
  });

  it('a maximum is refused on a fixed amount, by the API and by the database', async () => {
    const r = await f.agent.post('/api/v1/structures').send({ name: 'Bad max', components: [comp(1, 'Basic', 'PCT_GROSS', 50), comp(2, 'Conveyance', 'FIXED', R(1600), { max_amount: R(1000) })] });
    expect(r.status).toBe(422);
    const s = await prisma.salaryStructure.findFirstOrThrow();
    await expect(prisma.salaryComponent.create({ data: { structure_id: s.id, seq: 99, name: 'Bad', calc_type: 'FIXED', calc_value: R(100), max_amount: BigInt(R(50)) } })).rejects.toThrow();
  });

  it('% of CTC runs on the agreed CTC, a capped HRA sends the excess to the Special Allowance, and PF uses the ₹25,000 ceiling', async () => {
    const created = await f.agent.post('/api/v1/structures').send({
      name: 'Managers (CTC based)',
      components: [comp(1, 'Basic', 'PCT_CTC', 40), comp(2, 'HRA', 'PCT_BASIC', 50, { max_amount: R(8000) }), comp(3, 'Conveyance', 'FIXED', R(1600))],
    });
    expect(created.status).toBe(201);
    const r = await f.agent.post('/api/v1/employees/salary-preview').send({ mode: 'CTC', amount: R(600000), structure_id: created.body.data.id, date: '2026-09-30' });
    expect(r.status).toBe(200);
    const p = r.body.data;
    const amt = (name) => p.structure.monthly.find((c) => c.name === name).amount;
    expect(amt('Basic')).toBe(R(20000)); // 40% of ₹6,00,000 ÷ 12
    expect(amt('HRA')).toBe(R(8000)); // 50% of basic would be ₹10,000; capped
    // Basic ₹20,000 is under the ₹25,000 ceiling: company PF is 12% of it, ₹2,400 (EDLI and admin are not in CTC).
    expect(p.gross).toBe(R(50000 - 2400));
    expect(amt('Special Allowance')).toBe(p.gross - R(20000 + 8000 + 1600));
    expect(p.ctc.annual_ctc).toBe(R(600000));
  });
});

describe('PF has one limit: the ceiling', () => {
  it('stored rates carry no separate maximum, and publishing one is refused', async () => {
    const cur = (await f.agent.get('/api/v1/statutory-rates')).body.data.current;
    expect(cur.pf.ceiling).toBe(R(25000));
    expect(cur.pf).not.toHaveProperty('max_contribution');
    const r = await f.agent
      .patch('/api/v1/statutory-rates')
      .send({ valid_from: '2027-04-01', pf: { ...cur.pf, max_contribution: R(6000) }, esi: cur.esi, gratuity: cur.gratuity, recovery_cap_pct: 40 });
    expect(r.status).toBe(422);
  });
});

describe('A structure has no date: attaching it to a pay group decides who is paid on it, and from when', () => {
  const comp = (seq, name, calc_type, calc_value) => ({
    seq,
    name,
    calc_type,
    calc_value,
    max_amount: null,
    frequency: 'MONTHLY',
    pay_month: null,
    is_taxable: true,
    counts_as_wages: name === 'Basic',
    colour: 'chart-1',
  });

  it('a structure sent with a date of its own is refused', async () => {
    const r = await f.agent.post('/api/v1/structures').send({ name: 'Dated', valid_from: '2026-10-01', components: [comp(1, 'Basic', 'PCT_GROSS', 50)] });
    expect(r.status).toBe(422);
  });

  it('moves everyone in the group from the chosen month, keeps their agreed pay, and reports who it cannot move', async () => {
    const created = await f.agent.post('/api/v1/structures').send({ name: 'Site staff v2', components: [comp(1, 'Basic', 'PCT_GROSS', 60), comp(2, 'HRA', 'PCT_BASIC', 30)] });
    expect(created.status).toBe(201);
    const sid = created.body.data.id;
    const group = await prisma.payGroup.findFirstOrThrow({ where: { employees: { some: { id: f.employees.A } } } });

    const plan = await f.agent.get(`/api/v1/pay-groups/${group.id}/structure-move?structure_id=${sid}&from=2026-10`);
    expect(plan.status).toBe(200);
    const moving = plan.body.data.move.map((m) => m.employee.id);
    expect(moving).toContain(f.employees.A);
    // B already has a revision starting 1 October (an earlier test): moved on that change instead, never overwritten.
    expect(plan.body.data.skipped.find((x) => x.employee.id === f.employees.B)?.reason).toMatch(/Already has a salary change on 2026-10-01/);

    const before = await prisma.employeeSalary.findFirstOrThrow({ where: { employee_id: f.employees.A, valid_to: null } });
    const r = await f.agent.patch(`/api/v1/pay-groups/${group.id}`).send({ structure_id: sid, structure_from: '2026-10' });
    expect(r.status).toBe(200);
    expect(r.body.data.structure.id).toBe(sid);
    expect(r.body.data.structure_move.moved).toBe(moving.length);

    const rows = await prisma.employeeSalary.findMany({ where: { employee_id: f.employees.A }, orderBy: { valid_from: 'asc' } });
    const [old, now] = rows.slice(-2);
    expect(old.id).toBe(before.id);
    expect(old.valid_to?.toISOString().slice(0, 10)).toBe('2026-09-30');
    expect(now.valid_from.toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(now.structure_id).toBe(sid);
    expect(now.monthly_gross).toBe(before.monthly_gross);
    expect(await prisma.auditLog.count({ where: { action: 'salary.structure_change', entity_id: f.employees.A } })).toBe(1);
  });

  it('never reaches a month that has already been run', async () => {
    const group = await prisma.payGroup.findFirstOrThrow({ where: { employees: { some: { id: f.employees.A } } } });
    const other = await prisma.salaryStructure.findFirstOrThrow({ where: { name: 'Site staff' } });
    await prisma.payrollPeriod.create({ data: { period_ym: '2026-11', state: 'LOCKED' } });
    const r = await f.agent.patch(`/api/v1/pay-groups/${group.id}`).send({ structure_id: other.id, structure_from: '2026-11' });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/November 2026 has already been run/);
    const plan = await f.agent.get(`/api/v1/pay-groups/${group.id}/structure-move?structure_id=${other.id}`);
    // With no month given, the default is the earliest one not yet run: after November here, or the current month if later.
    const nowYm = new Date().toISOString().slice(0, 7);
    expect(plan.body.data.from).toBe(nowYm <= '2026-11' ? '2026-12' : nowYm);
    await prisma.payrollPeriod.delete({ where: { period_ym: '2026-11' } });
  });
});

describe('Structure preview reads as a salary breakup: earnings → gross, company contributions → CTC, deductions → net', () => {
  const comp = (seq, name, calc_type, calc_value) => ({
    seq,
    name,
    calc_type,
    calc_value,
    max_amount: null,
    frequency: 'MONTHLY',
    pay_month: null,
    is_taxable: true,
    counts_as_wages: name === 'Basic',
    colour: 'chart-1',
  });
  // Basic 50% of gross (PF wage), HRA 40% of basic, conveyance ₹1,600, the Special Allowance takes the rest.
  const components = [comp(1, 'Basic', 'PCT_GROSS', 50), comp(2, 'HRA', 'PCT_BASIC', 40), comp(3, 'Conveyance', 'FIXED', R(1600))];
  const at = (sample) => f.agent.post('/api/v1/structures/validate').send({ components, sample: { pt_state: 'Telangana', ...sample } });

  it('CTC ₹4,00,000: with PF off the whole CTC is gross; with PF on the company share comes out of it', async () => {
    const off = (await at({ mode: 'CTC', amount: R(400000), pf_enabled: false, esi_enabled: true })).body.data.breakup;
    expect(off.gross).toBe(R(33333));
    expect(off.ctc.employer_pf).toBe(0);
    expect(off.take_home).toBe(R(33333 - 200));
    const on = (await at({ mode: 'CTC', amount: R(400000), pf_enabled: true, esi_enabled: true })).body.data.breakup;
    // Company contributions are the 12% PF only (EDLI and admin are not in CTC): gross + 12% of basic = ₹33,333.
    expect(on.gross).toBe(R(31446));
    expect(on.pf.employee).toBe(R(1887));
    expect(on.ctc.employer_pf).toBe(R(1887));
    expect(on.ctc.monthly_cost).toBe(R(33333));
    expect(on.take_home).toBe(R(31446 - 1887 - 200));
  });

  it('gross ₹4,00,000 a year: gross stays; with PF on the company share is paid on top', async () => {
    const monthly = Math.round(R(400000 / 12)); // ₹33,333.33
    const on = (await at({ mode: 'GROSS', amount: monthly, pf_enabled: true, esi_enabled: true })).body.data.breakup;
    expect(on.gross).toBe(monthly);
    expect(on.pf.employee).toBe(R(2000));
    expect(on.ctc.employer_pf).toBe(R(2000));
    expect(on.take_home).toBe(monthly - R(2000) - R(200));
  });

  it('ESI applies only at ₹21,000 gross or less, and switching it off removes both shares', async () => {
    const esi = (await at({ mode: 'GROSS', amount: R(18000), pf_enabled: true, esi_enabled: true })).body.data.breakup;
    expect(esi.esi).toMatchObject({ applicable: true, employee: R(135), employer: R(585) });
    expect(esi.ctc.monthly_cost).toBe(R(18000 + 1080 + 585));
    expect(esi.take_home).toBe(R(18000 - 1080 - 135 - 150));
    const none = (await at({ mode: 'GROSS', amount: R(18000), pf_enabled: true, esi_enabled: false })).body.data.breakup;
    expect(none.esi.employee).toBe(0);
    expect(none.take_home).toBe(R(18000 - 1080 - 150));
    const above = (await at({ mode: 'CTC', amount: R(400000), pf_enabled: true, esi_enabled: true })).body.data.breakup;
    expect(above.esi.applicable).toBe(false);
  });
});
