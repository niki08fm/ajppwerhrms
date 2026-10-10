import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { istMidnight } from '@ajpwer/shared';
import { embeddingToBytes, MODEL_VERSION } from '@ajpwer/face';
import { prisma } from '../../src/config/db.js';
import { invalidateFaceCache, setFaceClient } from '../../src/services/face.service.js';
import { hashPassword } from '../../src/services/auth.service.js';
import { toDbDate } from '../../src/utils/dbDates.js';
import { app, buildFixture } from './fixture.js';

const DATE = '2026-10-10';
const POS = { lat: 16.5063, lng: 80.6481, accuracy_m: 12 };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const EMBEDDING = [1, ...Array(127).fill(0)];
const frame = (yaw = 0) => ({ faces: 1, face: { box: [200, 120, 160, 160], score: 0.99, landmarks: [] }, yaw,
  quality: { brightness: 120, sharpness: 220, face_px: 160 }, live: { v2: 0.95, v1se: 0.95, score: 0.95 }, embedding: EMBEDDING });
const face = { analyze: vi.fn() };
let f, beta, electrical, civil, alphaTablet, betaTablet, hr;
let requestNo = 0;

async function tablet(login, password) {
  const agent = request.agent(app);
  const r = await agent.post('/api/v1/auth/site-login').send({ login, password, ...POS });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return agent;
}
async function recorded(employeeId, direction, min, siteId = f.siteId, date = DATE) {
  const at = new Date(istMidnight(date).getTime() + min * 60_000);
  return prisma.punch.create({ data: { employee_id: employeeId, site_id: siteId, direction,
    punched_at: at, client_punched_at: at, work_date: toDbDate(date), method: 'FACE' } });
}
async function registerTemplate(employeeId) {
  await prisma.employeeFace.create({ data: { employee_id: employeeId, embedding: embeddingToBytes(EMBEDDING),
    model_version: MODEL_VERSION, kind: 'REGISTERED', consent_at: new Date() } });
  invalidateFaceCache();
}
async function start(agent, extra = {}) {
  return agent.post('/api/v1/punches/sessions').send({ ...POS, ...extra });
}
function upload(agent, id, registration = false, requestId = `workspace-${++requestNo}`) {
  let r = agent.post(`/api/v1/punches/sessions/${id}/frames`)
    .field('request_id', requestId).field('lat', POS.lat).field('lng', POS.lng).field('accuracy_m', POS.accuracy_m);
  for (const name of registration ? ['front', 'left', 'right', 'blink'] : ['front', 'front2', 'front3']) {
    r = r.attach(name, JPEG, { filename: `${name}.jpg`, contentType: 'image/jpeg' });
  }
  return r;
}

beforeAll(async () => {
  f = await buildFixture();
  beta = await prisma.site.create({ data: { code: 'BETA', name: 'Beta', state: 'Andhra Pradesh', lat: POS.lat, lng: POS.lng,
    radius_m: 400, login: 'site-beta', password_hash: await hashPassword('beta-pass-1') } });
  electrical = f.deptId;
  civil = (await prisma.department.create({ data: { name: 'Civil', colour: 'chart-2' } })).id;
  await prisma.employee.update({ where: { id: f.employees.B }, data: { department_id: civil } });
  setFaceClient(face);
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${DATE}T18:00:00+05:30`));
  await prisma.$transaction([
    prisma.$executeRawUnsafe("SET LOCAL ajpwer.retention = 'on'"),
    prisma.$executeRawUnsafe('TRUNCATE punch CASCADE'),
  ]);
  await prisma.siteTransferRequest.deleteMany({});
  await prisma.punchAttempt.deleteMany({});
  await prisma.punchSession.deleteMany({});
  await prisma.employeeFace.deleteMany({});
  await prisma.loginAttempt.deleteMany({});
  await prisma.employee.updateMany({ where: { id: { in: [f.employees.A, f.employees.B, f.employees.C] } }, data: { status: 'ACTIVE' } });
  invalidateFaceCache();
  face.analyze.mockReset();
  face.analyze.mockImplementation(async (_pictures, { requestId }) => ({ model_version: MODEL_VERSION, ms: 20,
    frames: requestId.endsWith(':0') ? [frame(0), frame(25)] : requestId.endsWith(':1') ? [frame(-25), frame(0)] : [frame(0), frame(2), frame(-2)] }));
  alphaTablet = await tablet('site-alpha', 'site-pass-1');
  betaTablet = await tablet('site-beta', 'beta-pass-1');
  hr = request.agent(app);
  expect((await hr.post('/api/v1/auth/login').send({ email: 'hr@test.in', password: 'test-password-1' })).status).toBe(200);
});
afterEach(() => vi.useRealTimers());
afterAll(async () => { setFaceClient(null); await prisma.$disconnect(); });

describe('A site login reads only its own recorded attendance', () => {
  it('counts unique INs, current presence, late starts and signed-out people; department mix uses the latest punch', async () => {
    await recorded(f.employees.A, 'IN', 570);
    await recorded(f.employees.B, 'IN', 540);
    await recorded(f.employees.B, 'OUT', 600);
    await recorded(f.employees.B, 'IN', 610);
    await recorded(f.employees.C, 'IN', 540);
    await recorded(f.employees.C, 'OUT', 990);
    const r = await alphaTablet.get('/api/v1/tablet/summary');
    expect(r.status).toBe(200);
    expect(r.body.data.counts).toEqual({ punched_in_today: 3, on_site_now: 2, late_in: 1, signed_out: 1, early_out: 1 });
    expect(r.body.data.departments.map((d) => [d.id, d.count])).toEqual([[civil, 1], [electrical, 1]]);
    expect(r.body.data.on_site_now.map((p) => p.id)).toEqual([f.employees.A, f.employees.B]);
    expect(JSON.stringify(r.body)).not.toMatch(/salary|pay_group|bank|phone|aadhaar|embedding/);
  });
  it('an OUT-only record does not inflate total punched in, and an employee now elsewhere disappears from headcount', async () => {
    await recorded(f.employees.A, 'IN', 540);
    await recorded(f.employees.A, 'OUT', 600);
    await recorded(f.employees.A, 'IN', 640, beta.id);
    await recorded(f.employees.B, 'OUT', 600);
    const r = await alphaTablet.get('/api/v1/tablet/summary');
    expect(r.body.data.counts.punched_in_today).toBe(1);
    expect(r.body.data.counts.on_site_now).toBe(0);
    expect(r.body.data.counts.late_in).toBe(0);
    expect(r.body.data.counts.early_out).toBe(0);
    expect(r.body.data.departments).toEqual([]);
    const destination = await betaTablet.get('/api/v1/tablet/summary');
    expect(destination.body.data.counts).toMatchObject({ punched_in_today: 1, on_site_now: 1, late_in: 0 });
    const day = await alphaTablet.get(`/api/v1/tablet/attendance/day?date=${DATE}`);
    expect(day.body.data.rows.find((r) => r.id === f.employees.B).status).toBe('OUT_ONLY');
  });
  it('keeps an overnight open IN on its work date and never reopens yesterday after a fresh IN today', async () => {
    vi.setSystemTime(new Date('2026-10-11T02:00:00+05:30'));
    await recorded(f.employees.A, 'IN', 1380);
    const overnight = await alphaTablet.get(`/api/v1/tablet/attendance/day?date=${DATE}`);
    expect(overnight.body.data.rows[0]).toMatchObject({ id: f.employees.A, on_site_now: true, status: 'ON_SITE' });
    await recorded(f.employees.A, 'OUT', 1470);
    await recorded(f.employees.A, 'IN', 60, f.siteId, '2026-10-11');
    const closed = await alphaTablet.get(`/api/v1/tablet/attendance/day?date=${DATE}`);
    expect(closed.body.data.rows[0]).toMatchObject({ id: f.employees.A, on_site_now: false, status: 'SIGNED_OUT' });
    const current = await alphaTablet.get('/api/v1/tablet/attendance/day?date=2026-10-11');
    expect(current.body.data.rows[0]).toMatchObject({ id: f.employees.A, on_site_now: true, status: 'ON_SITE' });
  });
  it('keeps daily and monthly registers site-scoped, with all calendar dates and one counted day for repeated INs', async () => {
    await recorded(f.employees.A, 'IN', 540);
    await recorded(f.employees.A, 'OUT', 600);
    await recorded(f.employees.A, 'IN', 620);
    await recorded(f.employees.A, 'OUT', 1050);
    await recorded(f.employees.B, 'IN', 540, beta.id);
    const day = await alphaTablet.get(`/api/v1/tablet/attendance/day?date=${DATE}`);
    expect(day.status).toBe(200);
    expect(day.body.data.rows).toHaveLength(1);
    expect(day.body.data.rows[0]).toMatchObject({ id: f.employees.A, punches_in: 2, punches_out: 2, worked_min: 490 });
    const month = await alphaTablet.get('/api/v1/tablet/attendance/month?ym=2026-10');
    expect(month.status).toBe(200);
    expect(month.body.data.rows).toHaveLength(1);
    expect(month.body.data.rows[0]).toMatchObject({ id: f.employees.A, punched_days: 1 });
    expect(month.body.data.days).toHaveLength(31);
    expect(month.body.data.days.find((d) => d.date === DATE).punched_in).toBe(1);
    expect(JSON.stringify(month.body)).not.toContain(f.employees.B);
    expect(JSON.stringify(month.body)).not.toMatch(/salary|pay_group|bank|phone|aadhaar/);
  });
  it('rejects cross-site filters, company attendance access and register writes', async () => {
    for (const endpoint of ['summary', `attendance/day?date=${DATE}`, 'attendance/month?ym=2026-10', 'transfers']) {
      const separator = endpoint.includes('?') ? '&' : '?';
      expect((await alphaTablet.get(`/api/v1/tablet/${endpoint}${separator}site_id=${beta.id}`)).status).toBe(403);
    }
    expect((await alphaTablet.get(`/api/v1/attendance?date=${DATE}`)).status).toBe(401);
    expect((await alphaTablet.post('/api/v1/attendance/overrides').send({})).status).toBe(401);
    expect((await request(app).get('/api/v1/tablet/summary')).status).toBe(401);
    expect((await alphaTablet.get('/api/v1/tablet/attendance/day?date=bad-date')).status).toBe(422);
    expect((await alphaTablet.get('/api/v1/tablet/attendance/month?ym=bad-month')).status).toBe(422);
  });
});

describe('Transfer requests are separate from punches', () => {
  const body = () => ({ employee_code: 'T001', to_site_id: beta.id, departure_date: DATE, reason: 'Work at the next site' });
  it('offers only people currently here, stores a pending request and never writes a punch or travel credit', async () => {
    await recorded(f.employees.A, 'IN', 540);
    await recorded(f.employees.B, 'IN', 540, beta.id);
    const search = await alphaTablet.get('/api/v1/tablet/employees?for=transfer&q=Person');
    expect(search.body.data.map((p) => p.code)).toEqual(['T001']);
    const before = await prisma.punch.count();
    const r = await alphaTablet.post('/api/v1/tablet/transfers').send(body());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'PENDING', departure_date: DATE, from_site: { id: f.siteId }, to_site: { id: beta.id } });
    expect(await prisma.punch.count()).toBe(before);
    expect(await prisma.siteChange.count()).toBe(0);
    expect((await alphaTablet.get('/api/v1/tablet/summary')).body.data.counts.on_site_now).toBe(1);
    expect((await betaTablet.get('/api/v1/tablet/transfers')).body.data).toEqual([]);
    const duplicate = await alphaTablet.post('/api/v1/tablet/transfers').send(body());
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('TRANSFER_PENDING');
  });
  it('rejects another site employee, inactive destination, same-site and source-site spoofing', async () => {
    await recorded(f.employees.A, 'IN', 540);
    await recorded(f.employees.B, 'IN', 540, beta.id);
    expect((await alphaTablet.post('/api/v1/tablet/transfers').send({ ...body(), employee_code: 'T002' })).body.error.code).toBe('EMPLOYEE_NOT_AT_SITE');
    expect((await alphaTablet.post('/api/v1/tablet/transfers').send({ ...body(), to_site_id: f.siteId })).status).toBe(422);
    expect((await alphaTablet.post('/api/v1/tablet/transfers').send({ ...body(), from_site_id: beta.id })).status).toBe(422);
    await prisma.site.update({ where: { id: beta.id }, data: { is_active: false } });
    expect((await alphaTablet.post('/api/v1/tablet/transfers').send(body())).status).toBe(422);
    await prisma.site.update({ where: { id: beta.id }, data: { is_active: true } });
  });
  it('only HR can review, a decision is final, and approval leaves attendance unchanged', async () => {
    await recorded(f.employees.A, 'IN', 540);
    const r = await alphaTablet.post('/api/v1/tablet/transfers').send(body());
    const id = r.body.data.id;
    expect((await alphaTablet.post(`/api/v1/site-transfer-requests/${id}/decide`).send({ decision: 'APPROVED' })).status).toBe(401);
    const reviewed = await hr.post(`/api/v1/site-transfer-requests/${id}/decide`).send({ decision: 'APPROVED', note: 'Approved by HR' });
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    expect(reviewed.body.data).toMatchObject({ status: 'APPROVED', decided_by: 'hr@test.in', decision_note: 'Approved by HR' });
    expect((await hr.post(`/api/v1/site-transfer-requests/${id}/decide`).send({ decision: 'REJECTED' })).status).toBe(409);
    expect(await prisma.punch.count()).toBe(1);
    expect(await prisma.siteChange.count()).toBe(0);
    expect((await alphaTablet.get('/api/v1/tablet/transfers')).body.data[0].status).toBe('APPROVED');
  });
});

describe('First registration follows activation and works at any site', () => {
  it('offers only active unregistered employees; onboarding cannot start a registration', async () => {
    const choices = await betaTablet.get('/api/v1/tablet/employees?for=register&q=Person');
    expect(choices.body.data.map((p) => p.code)).toEqual(['T001', 'T002', 'T003']);
    const refused = await start(betaTablet, { purpose: 'REGISTER', employee_code: 'T005', name: 'Person ONBOARD' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('UNKNOWN_EMPLOYEE');
  });
  it('registers an active person at another site without writing attendance, and a retry preserves the reply', async () => {
    const s = await start(betaTablet, { purpose: 'REGISTER', employee_code: 'T001', name: 'Person A' });
    expect(s.status).toBe(201);
    const uploaded = await upload(betaTablet, s.body.data.session_id, true, 'register-idempotent');
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    expect(uploaded.body.data.outcome).toBe('REGISTERED');
    const templates = await prisma.employeeFace.findMany({ where: { employee_id: f.employees.A, deleted_at: null } });
    expect(templates).toHaveLength(3);
    expect(templates.every((t) => t.site_id === beta.id)).toBe(true);
    expect(await prisma.punch.count()).toBe(0);
    const retry = await upload(betaTablet, s.body.data.session_id, true, 'register-idempotent');
    expect(retry.body.data.outcome).toBe('REGISTERED');
    expect(await prisma.employeeFace.count({ where: { employee_id: f.employees.A, deleted_at: null } })).toBe(3);
    expect((await start(alphaTablet, { purpose: 'REGISTER', employee_code: 'T001', name: 'Person A' })).body.error.code).toBe('ALREADY_REGISTERED');
  });
  it('rejects status changes during capture and before saving successful face analysis', async () => {
    const s = await start(alphaTablet, { purpose: 'REGISTER', employee_code: 'T001', name: 'Person A' });
    await prisma.employee.update({ where: { id: f.employees.A }, data: { status: 'ONBOARDING' } });
    const r = await upload(alphaTablet, s.body.data.session_id, true);
    expect(r.body.error.code).toBe('FACE_REGISTRATION_NOT_ACTIVE');
    expect(face.analyze).not.toHaveBeenCalled();
    await prisma.employee.update({ where: { id: f.employees.A }, data: { status: 'ACTIVE' } });
    const realAnalyze = face.analyze.getMockImplementation();
    face.analyze.mockImplementation(async (...args) => {
      await prisma.employee.update({ where: { id: f.employees.A }, data: { status: 'ONBOARDING' } });
      return realAnalyze(...args);
    });
    const final = await upload(alphaTablet, s.body.data.session_id, true);
    expect(final.body.error.code).toBe('FACE_REGISTRATION_NOT_ACTIVE');
    expect(await prisma.employeeFace.count({ where: { employee_id: f.employees.A } })).toBe(0);
  });
});

describe('Moving to another site cannot accidentally punch OUT at the destination', () => {
  it('requires an OUT at the source before the destination can identify an IN', async () => {
    await registerTemplate(f.employees.A);
    await recorded(f.employees.A, 'IN', 1000);
    const s = await start(betaTablet);
    const blocked = await upload(betaTablet, s.body.data.session_id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CROSS_SITE_OPEN_SHIFT');
    expect(await prisma.punch.count()).toBe(1);
    await recorded(f.employees.A, 'OUT', 1050);
    const allowed = await upload(betaTablet, s.body.data.session_id);
    expect(allowed.body.data).toMatchObject({ outcome: 'IDENTIFIED', direction: 'IN' });
  });
  it('rechecks the source IN at confirmation time and refuses a punch after the employee becomes inactive', async () => {
    await registerTemplate(f.employees.A);
    const s = await start(betaTablet);
    const identified = await upload(betaTablet, s.body.data.session_id);
    expect(identified.body.data.outcome).toBe('IDENTIFIED');
    await recorded(f.employees.A, 'IN', 1070);
    const confirm = () => betaTablet.post(`/api/v1/punches/sessions/${s.body.data.session_id}/confirm`)
      .send({ ...POS, confirm_token: identified.body.data.confirm_token });
    expect((await confirm()).body.error.code).toBe('CROSS_SITE_OPEN_SHIFT');
    expect(await prisma.punch.count()).toBe(1);
    await prisma.employee.update({ where: { id: f.employees.A }, data: { status: 'ONBOARDING' } });
    expect((await confirm()).body.error.code).toBe('EMPLOYEE_NOT_ACTIVE');
    expect(await prisma.punch.count()).toBe(1);
  });
});
