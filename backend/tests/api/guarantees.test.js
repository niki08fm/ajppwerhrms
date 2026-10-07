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
    const r = await f.agent.post(`/api/v1/employees/${f.employees.B}/salary`).send({ mode: 'GROSS', amount: R(25000), valid_from: '2026-10-01', structure_id: f.structureId, reason: 'Increment' });
    expect(r.status).toBe(201);
    const rows = await prisma.employeeSalary.findMany({ where: { employee_id: f.employees.B }, orderBy: { valid_from: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0].valid_to?.toISOString().slice(0, 10)).toBe('2026-09-30');
    const hist = await f.agent.get(`/api/v1/employees/${f.employees.B}/salary`);
    expect(hist.body.data[0].valid_from).toBe('2026-10-01');
  });
});

describe('Attendance corrections', () => {
  // A Monday: Person A punched 09:00–17:30. The shift is 09:00–17:30, an 8-hour day, 15 minutes' grace.
  const D = `${YM}-03`;
  const correct = (body, date = D) => f.agent.post('/api/v1/attendance/overrides').send({ employee_id: f.employees.A, work_date: date, ...body });
  const preview = (body) => f.agent.post('/api/v1/attendance/overrides/preview').send({ employee_id: f.employees.A, work_date: D, ...body });
  const dayOf = async (date = D) => (await f.agent.get(`/api/v1/attendance/day?employee_id=${f.employees.A}&date=${date}`)).body.data;

  it('rejects a correction that changes nothing, stores computed and corrected values, and reverts exactly', async () => {
    const day = await dayOf();
    const c = day.computed;
    expect([day.in_min, day.out_min]).toEqual([540, 1050]);
    expect(day.context).toMatchObject({ kind: 'WORKING', shift_start_min: 540, grace_min: 15, standard_min: 480 });
    const same = await correct({ mode: 'TIMES', in_min: 540, out_min: 1050, reason_text: 'Nothing actually changes here' });
    expect(same.status).toBe(422);
    expect(same.body.error.code).toBe('NO_CHANGE');
    expect((await correct({ mode: 'MARK', status: 'HALF_DAY', reason_text: 'ok' })).status).toBe(422);

    const ok = await correct({ mode: 'MARK', status: 'HALF_DAY', reason_text: 'Sent home at noon by the site engineer' });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ status: 'HALF_DAY', day_value: 0.5, worked_min: 240, in_min: null, out_min: null });
    const stored = await prisma.attendanceOverride.findUniqueOrThrow({ where: { id: ok.body.data.id } });
    expect(stored.computed_snapshot).toMatchObject({ status: c.status, worked_min: c.worked_min });

    const rev = await f.agent.delete(`/api/v1/attendance/overrides/${stored.id}`);
    expect(rev.status).toBe(200);
    const after = await dayOf();
    expect(after.override).toBeNull();
    expect(after.computed.status).toBe(c.status);
  });

  it('times decide late minutes, the day and overtime; given the overtime, the out time follows', async () => {
    // Overtime from the end of the day, in half hours, nothing under half an hour.
    const pol = await f.agent.post('/api/v1/policies').send({
      kind: 'OVERTIME',
      name: 'Overtime',
      valid_from: '2025-01-01',
      rules: { base: 'BASIC_HRA', divisor: null, after_min: 30, multiplier: 2, counts_from: 'SHIFT_END', rounding_min: 30, hours_per_day: 8, monthly_cap_min: 3000 },
    });
    expect(pol.status).toBe(201);
    const ids = (await f.agent.get(`/api/v1/pay-groups/${f.payGroupId}`)).body.data.policies.map((p) => p.id);
    expect((await f.agent.patch(`/api/v1/pay-groups/${f.payGroupId}`).send({ policy_ids: [...ids, pol.body.data.id] })).status).toBe(200);

    // In at 09:40, past the grace: 40 minutes late, and the day ends a full day later, at 17:40.
    const late = await preview({ in_min: 580, out_min: 1150 });
    expect(late.status).toBe(200);
    expect(late.body.data).toMatchObject({ status: 'PRESENT', late_min: 40, due_out_min: 1060, ot_min: 90, worked_min: 570 });
    // Given an hour of overtime instead, the out time is the end of the day plus the hour.
    expect((await preview({ in_min: 540, ot_min: 60 })).body.data).toMatchObject({ out_min: 1110, ot_min: 60, late_min: 0 });
    expect((await preview({ in_min: 580, ot_min: 60 })).body.data).toMatchObject({ out_min: 1120, ot_min: 60, late_min: 40 });
    // Five hours: a half day.
    expect((await preview({ in_min: 540, out_min: 840 })).body.data).toMatchObject({ status: 'HALF_DAY', day_value: 0.5, ot_min: 0 });

    const saved = await correct({ mode: 'TIMES', in_min: 580, out_min: 1150, reason_text: "Punched out on a colleague's phone" });
    expect(saved.status).toBe(201);
    expect(saved.body.data).toMatchObject({ status: 'PRESENT', late_min: 40, ot_min: 90, in_min: 580, out_min: 1150 });
    // The day now shows HR's times.
    expect(await dayOf()).toMatchObject({ in_min: 580, out_min: 1150 });
    expect((await correct({ mode: 'TIMES', in_min: 600, out_min: 590, reason_text: 'Out before in' })).status).toBe(422);
    expect((await f.agent.delete(`/api/v1/attendance/overrides/${saved.body.data.id}`)).status).toBe(200);
    expect((await f.agent.patch(`/api/v1/pay-groups/${f.payGroupId}`).send({ policy_ids: ids })).status).toBe(200);
  });

  it('a marked day takes overtime directly; on an off day the mark says it was worked', async () => {
    const full = await correct({ mode: 'MARK', status: 'PRESENT', ot_min: 120, reason_text: 'Worked late on the substation' });
    expect(full.status).toBe(201);
    expect(full.body.data).toMatchObject({ status: 'PRESENT', day_value: 1, worked_min: 480, ot_min: 120 });
    expect((await correct({ mode: 'MARK', status: 'HALF_DAY', ot_min: 30, reason_text: 'Half day with overtime' })).status).toBe(422);
    expect((await f.agent.delete(`/api/v1/attendance/overrides/${full.body.data.id}`)).status).toBe(200);

    // A Sunday, the weekly off, paid by its policy.
    const sunday = await correct({ mode: 'MARK', status: 'PRESENT', reason_text: 'Called in on Sunday' }, `${YM}-02`);
    expect(sunday.status).toBe(201);
    expect(sunday.body.data).toMatchObject({ status: 'OFF_WORKED', day_value: 1, worked_min: 480, ot_min: 0 });
    expect((await f.agent.delete(`/api/v1/attendance/overrides/${sunday.body.data.id}`)).status).toBe(200);
  });

  it('the same mark for many days at once', async () => {
    const date = `${YM}-04`;
    const r = await f.agent.post('/api/v1/attendance/overrides/bulk').send({
      items: [
        { employee_id: f.employees.A, work_date: date },
        { employee_id: f.employees.B, work_date: date },
      ],
      status: 'ABSENT',
      reason_text: 'Site shut by the client',
    });
    expect(r.status).toBe(200);
    expect(r.body.data.applied).toBe(2);
    for (const key of ['A', 'B']) {
      const o = await prisma.attendanceOverride.findFirstOrThrow({ where: { employee_id: f.employees[key], status: 'ABSENT' } });
      expect((await f.agent.delete(`/api/v1/attendance/overrides/${o.id}`)).status).toBe(200);
    }
  });

  it('once step 1 is submitted, corrections stop until it is reopened', async () => {
    await submitSteps(f.agent, YM, 1);
    const r = await correct({ mode: 'MARK', status: 'ABSENT', reason_text: 'Was not actually on site' }, `${YM}-04`);
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
    const far = await tablet.post('/api/v1/punches/sessions').send({ lat: 17.385, lng: 78.4867, accuracy_m: 10 });
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

// Tablet punches (face v2) are covered in face-punch.test.js.

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
      .send({ valid_from: '2027-04-01', pf: { ...cur.pf, max_contribution: R(6000) }, esi: cur.esi, recovery_cap_pct: 40 });
    expect(r.status).toBe(422);
  });
});

describe('Salary structures belong to employee salary history, independently of pay groups', () => {
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

  it('refuses group-wide structure changes and keeps employee salary records intact', async () => {
    const created = await f.agent.post('/api/v1/structures').send({ name: 'Independent structure', components: [comp(1, 'Basic', 'PCT_GROSS', 60), comp(2, 'HRA', 'PCT_BASIC', 30)] });
    expect(created.status).toBe(201);
    const before = await prisma.employeeSalary.findMany({ where: { employee: { pay_group_id: f.payGroupId } }, orderBy: { id: 'asc' } });
    const rejected = await f.agent.patch(`/api/v1/pay-groups/${f.payGroupId}`).send({ structure_id: created.body.data.id, structure_from: '2026-10' });
    expect(rejected.status).toBe(422);
    expect((await f.agent.get(`/api/v1/pay-groups/${f.payGroupId}/structure-move?structure_id=${created.body.data.id}`)).status).toBe(404);
    const after = await prisma.employeeSalary.findMany({ where: { employee: { pay_group_id: f.payGroupId } }, orderBy: { id: 'asc' } });
    expect(after).toEqual(before);
    const group = await f.agent.get(`/api/v1/pay-groups/${f.payGroupId}`);
    expect(group.body.data).not.toHaveProperty('structure');
    expect(group.body.data).not.toHaveProperty('structure_id');
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
