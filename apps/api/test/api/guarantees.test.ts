import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../../src/lib/prisma';
import { app, buildFixture, R, submitSteps, YM, type Fixture } from './fixture';

let f: Fixture;

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
      prisma.employeeSalary.create({ data: { employee_id: f.employees.A, valid_from: new Date('2026-01-01'), mode: 'GROSS', amount: 1n, monthly_gross: 1n, structure_id: s.structure_id, reason: 'x' } }),
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
    const same = await f.agent.post('/api/v1/attendance/overrides').send({ employee_id: f.employees.A, work_date: date, status: c.status, day_value: c.day_value, worked_min: c.worked_min, ot_min: c.ot_min, late_min: c.late_min, reason_code: 'DATA_ERROR', reason_text: 'Nothing actually changes here' });
    expect(same.status).toBe(422);
    expect(same.body.error.code).toBe('NO_CHANGE');

    const short = await f.agent.post('/api/v1/attendance/overrides').send({ employee_id: f.employees.A, work_date: date, status: 'HALF_DAY', day_value: 0.5, worked_min: 240, ot_min: 0, late_min: 0, reason_code: 'OTHER', reason_text: 'short' });
    expect(short.status).toBe(422);

    const ok = await f.agent.post('/api/v1/attendance/overrides').send({ employee_id: f.employees.A, work_date: date, status: 'HALF_DAY', day_value: 0.5, worked_min: 240, ot_min: 0, late_min: 0, reason_code: 'SITE_INSTRUCTION', reason_text: 'Sent home at noon by the site engineer' });
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
    const r = await f.agent.post('/api/v1/attendance/overrides').send({ employee_id: f.employees.A, work_date: `${YM}-04`, status: 'ABSENT', day_value: 0, worked_min: 0, ot_min: 0, late_min: 0, reason_code: 'DATA_ERROR', reason_text: 'Was not actually on site' });
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
    const body = { direction: id.body.data.direction, client_punched_at: new Date().toISOString(), lat: 16.5063, lng: 80.6481, accuracy_m: 12, match_token: id.body.data.match_token, device_id: 'tab-1' };
    const p1 = await tablet.post('/api/v1/punches').send(body);
    expect(p1.status).toBe(201);
    const p2 = await tablet.post('/api/v1/punches').send(body);
    expect(p2.status).toBe(200);
    expect(p2.body.data.duplicate).toBe(true);
  });
});
