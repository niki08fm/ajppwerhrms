import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { embeddingToBytes, FaceServiceUnavailable, MODEL_VERSION } from '@ajpwer/face';
import { prisma } from '../../src/config/db.js';
import { env } from '../../src/config/env.js';
import { invalidateFaceCache, loadGallery, setFaceClient } from '../../src/services/face.service.js';
import { hashPassword } from '../../src/services/auth.service.js';
import { toDbDate } from '../../src/utils/dbDates.js';
import { app, buildFixture } from './fixture.js';

const POS = { lat: 16.5063, lng: 80.6481, accuracy_m: 12 };
const NOW = new Date('2026-10-11T09:00:00+05:30');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const OLD = [1, ...Array(127).fill(0)];
const NEW = [0, 1, ...Array(126).fill(0)];
const frame = (yaw = 0, embedding = NEW, live = 0.95) => ({ faces: 1,
  face: { box: [200, 120, 160, 160], score: 0.99, landmarks: [] }, yaw,
  quality: { brightness: 120, sharpness: 220, face_px: 160 },
  live: { v2: live, v1se: live, score: live }, embedding });
const face = { analyze: vi.fn() };
let f, beta, alphaTablet, betaTablet, hr, reader;
let requestNo = 0;

async function signInSite(login, password) {
  const agent = request.agent(app);
  expect((await agent.post('/api/v1/auth/site-login').send({ login, password, ...POS })).status).toBe(200);
  return agent;
}
async function signInHR(email = 'hr@test.in') {
  const agent = request.agent(app);
  expect((await agent.post('/api/v1/auth/login').send({ email, password: 'test-password-1' })).status).toBe(200);
  return agent;
}
const endpoint = (employee = f.employees.A) => `/api/v1/employees/${employee}/face-registration`;
const grant = (employee = f.employees.A) => hr.post(`${endpoint(employee)}/authorize`).send({ reason: 'Repeated face failures confirmed by HR' });
const start = (agent = alphaTablet, code = 'T001', name = 'Person A') => agent.post('/api/v1/punches/sessions').send({ ...POS, purpose: 'REGISTER', employee_code: code, name });
function upload(agent, id, requestId = `replace-${++requestNo}`, registration = true) {
  let r = agent.post(`/api/v1/punches/sessions/${id}/frames`)
    .field('request_id', requestId).field('lat', POS.lat).field('lng', POS.lng).field('accuracy_m', POS.accuracy_m);
  for (const name of registration ? ['front', 'left', 'right', 'blink'] : ['front', 'front2', 'front3']) r = r.attach(name, JPEG, { filename: `${name}.jpg`, contentType: 'image/jpeg' });
  return r;
}
function analyzeFrames(pictures, { requestId }, embedding = NEW, live = 0.95) {
  return { model_version: MODEL_VERSION, ms: 10, frames: requestId.endsWith(':0') ? [frame(0, embedding, live), frame(25, embedding, live)]
    : requestId.endsWith(':1') ? [frame(-25, embedding, live), frame(0, embedding, live)]
      : pictures.map(() => frame(0, embedding, live)) };
}
async function template(employeeId, embedding = OLD, kind = 'REGISTERED') {
  return prisma.employeeFace.create({ data: { employee_id: employeeId, embedding: embeddingToBytes(embedding), model_version: MODEL_VERSION, kind, consent_at: new Date() } });
}
async function currentTemplates(employeeId = f.employees.A) {
  return prisma.employeeFace.findMany({ where: { employee_id: employeeId, deleted_at: null } });
}
async function assertPreserved(authorizationId) {
  const current = await currentTemplates();
  expect(current).toHaveLength(2);
  expect(current.every((t) => t.embedding.equals(embeddingToBytes(OLD)))).toBe(true);
  expect((await prisma.faceRegistrationAuthorization.findUnique({ where: { id: authorizationId } })).status).toBe('APPROVED');
  expect(await prisma.punch.count()).toBe(0);
}

beforeAll(async () => {
  f = await buildFixture();
  beta = await prisma.site.create({ data: { code: 'REREG-BETA', name: 'Beta', state: 'Andhra Pradesh', lat: POS.lat, lng: POS.lng,
    radius_m: 400, login: 'rereg-beta', password_hash: await hashPassword('beta-pass-1') } });
  const role = await prisma.role.create({ data: { name: 'Face reader', permissions: ['people.read'] } });
  await prisma.appUser.create({ data: { email: 'reader@test.in', name: 'Reader', password_hash: await hashPassword('test-password-1'), role_id: role.id } });
  setFaceClient(face);
});
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await prisma.$transaction([prisma.$executeRawUnsafe("SET LOCAL ajpwer.retention = 'on'"), prisma.$executeRawUnsafe('TRUNCATE punch CASCADE')]);
  await prisma.faceException.deleteMany({});
  await prisma.punchAttempt.deleteMany({});
  await prisma.punchSession.deleteMany({});
  await prisma.faceRegistrationAuthorization.deleteMany({});
  await prisma.employeeFace.deleteMany({});
  await prisma.loginAttempt.deleteMany({});
  await prisma.employee.updateMany({ where: { id: { in: [f.employees.A, f.employees.B, f.employees.C] } }, data: { status: 'ACTIVE' } });
  await template(f.employees.A);
  await template(f.employees.A, OLD, 'ROLLING');
  invalidateFaceCache();
  face.analyze.mockReset();
  face.analyze.mockImplementation(async (...args) => analyzeFrames(...args));
  hr = await signInHR();
  reader = await signInHR('reader@test.in');
  alphaTablet = await signInSite('site-alpha', 'site-pass-1');
  betaTablet = await signInSite('rereg-beta', 'beta-pass-1');
});
afterEach(() => vi.useRealTimers());
afterAll(async () => { setFaceClient(null); await prisma.$disconnect(); });

describe('HR permits one replacement without deleting the working face first', () => {
  it('suggests HR review after four actual approved failed-try days without authorizing replacement automatically', async () => {
    const dates = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    for (const [index, date] of dates.entries()) {
      vi.setSystemTime(new Date(`${date}T09:00:00+05:30`));
      const fx = await prisma.faceException.create({ data: { site_id: f.siteId, occurred_at: new Date(`${date}T08:00:00+05:30`),
        claimed_employee_id: f.employees.A, claimed_name: 'Person A', kind: 'FAILED_TRIES', direction: 'IN', reason: 'Face scan reached the failed try limit' } });
      const decision = await hr.post(`/api/v1/face-exceptions/${fx.id}/decide`).send({ decision: 'APPROVE', employee_id: f.employees.A, reason: 'Identity checked by HR' });
      expect(decision.status, JSON.stringify(decision.body)).toBe(200);
      const actualPunch = await prisma.punch.findUnique({ where: { id: decision.body.data.punch_id } });
      expect(actualPunch).toMatchObject({ method: 'EXCEPTION', source_ref: fx.id, employee_id: f.employees.A, work_date: toDbDate(date) });
      const view = await hr.get(endpoint());
      expect(view.body.data.manual_failure_streak).toEqual({ days: index + 1, latest_date: date, requires_review: index === 3, dates: dates.slice(0, index + 1) });
      expect(view.body.data.authorization).toBeNull();
    }
    expect(await prisma.faceRegistrationAuthorization.count()).toBe(0);
    expect(await currentTemplates()).toHaveLength(2);
    const successAt = new Date('2026-10-11T08:30:00+05:30');
    await prisma.punch.create({ data: { employee_id: f.employees.A, site_id: f.siteId, direction: 'OUT', method: 'FACE',
      punched_at: successAt, client_punched_at: successAt, work_date: toDbDate('2026-10-11') } });
    expect((await hr.get(endpoint())).body.data.manual_failure_streak).toEqual({ days: 0, latest_date: null, requires_review: false, dates: [] });
  });
  it('requires HR write permission, bounds the reason and sets seven-day expiry server-side', async () => {
    expect((await request(app).get(endpoint())).status).toBe(401);
    expect((await alphaTablet.get(endpoint())).status).toBe(401);
    expect((await reader.get(endpoint())).status).toBe(200);
    expect((await reader.post(`${endpoint()}/authorize`).send({ reason: 'Face failed' })).status).toBe(403);
    expect((await alphaTablet.post(`${endpoint()}/authorize`).send({ reason: 'Face failed' })).status).toBe(401);
    expect((await hr.post(`${endpoint()}/authorize`).send({ reason: '  ' })).status).toBe(422);
    expect((await hr.post(`${endpoint()}/authorize`).send({ reason: 'x'.repeat(301) })).status).toBe(422);
    expect((await hr.post(`${endpoint()}/authorize`).send({ reason: 'Face failed', expires_at: '2099-01-01' })).status).toBe(422);
    const r = await grant();
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({ status: 'APPROVED', usable: true, approved_by: 'hr@test.in' });
    expect(new Date(r.body.data.expires_at).getTime() - new Date(r.body.data.approved_at).getTime()).toBe(7 * 86400_000);
    await assertPreserved(r.body.data.id);
    const view = await hr.get(endpoint());
    expect(view.body.data).toMatchObject({ face_registered: true, authorization: { id: r.body.data.id }, manual_failure_streak: { days: 0, requires_review: false } });
    expect(JSON.stringify(view.body)).not.toMatch(/embedding|crop/);
    const duplicate = await grant();
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.data.id).toBe(r.body.data.id);
    expect(duplicate.body.data.expires_at).toBe(r.body.data.expires_at);
  });
  it('does not require a failure streak, but rejects first-registration and inactive employees', async () => {
    expect((await grant(f.employees.B)).body.error.code).toBe('FACE_NOT_REGISTERED');
    for (const status of ['ONBOARDING', 'NOTICE', 'EXITED']) {
      await prisma.employee.update({ where: { id: f.employees.A }, data: { status } });
      expect((await grant()).body.error.code).toBe('FACE_REGISTRATION_NOT_ACTIVE');
    }
    expect(await prisma.faceRegistrationAuthorization.count()).toBe(0);
  });
  it('offers an approved employee from any site and atomically replaces registered and rolling templates', async () => {
    expect((await start()).body.error.code).toBe('ALREADY_REGISTERED');
    const authorization = (await grant()).body.data;
    const picker = await betaTablet.get('/api/v1/tablet/employees?for=register&q=Person');
    expect(picker.body.data.find((p) => p.code === 'T001')).toMatchObject({ allow_reregistration: true });
    expect(picker.body.data.find((p) => p.code === 'T002')).toMatchObject({ allow_reregistration: false });
    expect(JSON.stringify(picker.body)).not.toMatch(/approved_by|reason|expires_at|authorization/);
    const session = await start(betaTablet);
    expect(session.body.data.re_registration).toBe(true);
    expect((await prisma.punchSession.findUnique({ where: { id: session.body.data.session_id } })).face_registration_authorization_id).toBe(authorization.id);
    const r = await upload(betaTablet, session.body.data.session_id, 'replace-replay');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ outcome: 'REGISTERED', status: 'DONE', re_registration: true });
    const current = await currentTemplates();
    expect(current).toHaveLength(3);
    expect(current.every((t) => t.site_id === beta.id && t.kind === 'REGISTERED' && t.embedding.equals(embeddingToBytes(NEW)))).toBe(true);
    const deleted = await prisma.employeeFace.findMany({ where: { employee_id: f.employees.A, deleted_at: { not: null } } });
    expect(deleted).toHaveLength(2);
    expect(deleted.every((t) => t.embedding.length === 0)).toBe(true);
    expect((await prisma.faceRegistrationAuthorization.findUnique({ where: { id: authorization.id } }))).toMatchObject({ status: 'USED', used_site_id: beta.id });
    expect(await prisma.punch.count()).toBe(0);
    const replay = await upload(betaTablet, session.body.data.session_id, 'replace-replay');
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(replay.body.data).toEqual(r.body.data);
    expect(await currentTemplates()).toHaveLength(3);
    expect((await start()).body.error.code).toBe('ALREADY_REGISTERED');
    expect((await alphaTablet.get('/api/v1/tablet/employees?for=register&q=T001')).body.data).toEqual([]);
  });
  it('revokes only the exact approval, permits retry and never lets a stale revoke cancel a newer grant', async () => {
    const first = (await grant()).body.data;
    const session = await start();
    const revoked = await hr.post(`${endpoint()}/revoke`).send({ authorization_id: first.id });
    expect(revoked.body.data).toMatchObject({ status: 'REVOKED', usable: false });
    expect((await hr.post(`${endpoint()}/revoke`).send({ authorization_id: first.id })).status).toBe(200);
    expect((await upload(alphaTablet, session.body.data.session_id)).body.error.code).toBe('FACE_AUTHORIZATION_REVOKED');
    expect(face.analyze).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(NOW.getTime() + 1000));
    const next = (await grant()).body.data;
    expect(next.id).not.toBe(first.id);
    expect((await hr.post(`${endpoint()}/revoke`).send({ authorization_id: first.id })).status).toBe(200);
    expect((await hr.get(endpoint())).body.data.authorization).toMatchObject({ id: next.id, usable: true });
    expect((await upload(alphaTablet, session.body.data.session_id)).body.error.code).toBe('FACE_AUTHORIZATION_REVOKED');
    await assertPreserved(next.id);
  });
  it('expires before analysis, hides the picker and binds a new approval to a new session only', async () => {
    const authorization = (await grant()).body.data;
    const session = await start();
    vi.setSystemTime(new Date(authorization.expires_at));
    // The approval expires after seven days; authentication cookies expire
    // sooner. Refresh them so this checks the bound grant rather than login.
    hr = await signInHR();
    alphaTablet = await signInSite('site-alpha', 'site-pass-1');
    expect((await hr.get(endpoint())).body.data.authorization.usable).toBe(false);
    expect((await alphaTablet.get('/api/v1/tablet/employees?for=register&q=T001')).body.data).toEqual([]);
    expect((await upload(alphaTablet, session.body.data.session_id)).body.error.code).toBe('FACE_AUTHORIZATION_EXPIRED');
    expect(face.analyze).not.toHaveBeenCalled();
    await assertPreserved(authorization.id);
    const next = (await grant()).body.data;
    expect(next.id).not.toBe(authorization.id);
    expect((await upload(alphaTablet, session.body.data.session_id)).body.error.code).toBe('FACE_AUTHORIZATION_REVOKED');
    expect((await start()).status).toBe(201);
  });
});

describe('Unsuccessful or concurrent captures preserve the existing registration', () => {
  it('keeps the old face and approval after service errors and liveness failures; registration cannot create manual attendance', async () => {
    const authorization = (await grant()).body.data;
    const session = await start();
    face.analyze.mockRejectedValueOnce(new FaceServiceUnavailable('Service down'));
    expect((await upload(alphaTablet, session.body.data.session_id)).status).toBe(503);
    await assertPreserved(authorization.id);
    face.analyze.mockImplementation(async (...args) => analyzeFrames(...args, NEW, 0));
    for (let i = 0; i < env.FACE_MAX_TRIES; i++) expect((await upload(alphaTablet, session.body.data.session_id)).body.data.outcome).toBe('NOT_LIVE');
    const row = await prisma.punchSession.findUnique({ where: { id: session.body.data.session_id } });
    expect(row.status).toBe('BLOCKED');
    const manual = await alphaTablet.post(`/api/v1/punches/sessions/${row.id}/manual`).send({ ...POS, employee_code: 'T001', name: 'Person A' });
    expect(manual.status).toBe(409);
    expect(manual.body.error.code).toBe('REGISTRATION_NOT_ATTENDANCE');
    expect(await prisma.faceException.count()).toBe(0);
    await assertPreserved(authorization.id);
  });
  it('refuses another person’s duplicate face without consuming the approval', async () => {
    await template(f.employees.B, NEW);
    invalidateFaceCache();
    const authorization = (await grant()).body.data;
    const session = await start();
    const r = await upload(alphaTablet, session.body.data.session_id);
    expect(r.body.data.outcome).toBe('DUPLICATE_FACE');
    await assertPreserved(authorization.id);
  });
  it('checks the fresh gallery inside the final transaction instead of trusting a cached duplicate check', async () => {
    await loadGallery();
    const authorization = (await grant()).body.data;
    const session = await start();
    const analyze = face.analyze.getMockImplementation();
    face.analyze.mockImplementation(async (...args) => {
      if (args[1].requestId.endsWith(':1')) await template(f.employees.B, NEW);
      return analyze(...args);
    });
    expect((await upload(alphaTablet, session.body.data.session_id)).body.data.outcome).toBe('DUPLICATE_FACE');
    await assertPreserved(authorization.id);
  });
  it('re-checks HR revocation after face analysis and before writing any templates', async () => {
    const authorization = (await grant()).body.data;
    const session = await start();
    const analyze = face.analyze.getMockImplementation();
    face.analyze.mockImplementation(async (...args) => {
      if (args[1].requestId.endsWith(':1')) expect((await hr.post(`${endpoint()}/revoke`).send({ authorization_id: authorization.id })).status).toBe(200);
      return analyze(...args);
    });
    const r = await upload(alphaTablet, session.body.data.session_id);
    expect(r.body.error.code).toBe('FACE_AUTHORIZATION_REVOKED');
    expect(await currentTemplates()).toHaveLength(2);
    expect(await prisma.punch.count()).toBe(0);
    expect((await prisma.faceRegistrationAuthorization.findUnique({ where: { id: authorization.id } })).status).toBe('REVOKED');
  });
  it('re-checks expiry and employee status immediately before replacement', async () => {
    const authorization = (await grant()).body.data;
    const session = await start();
    const analyze = face.analyze.getMockImplementation();
    face.analyze.mockImplementation(async (...args) => {
      if (args[1].requestId.endsWith(':1')) vi.setSystemTime(new Date(authorization.expires_at));
      return analyze(...args);
    });
    expect((await upload(alphaTablet, session.body.data.session_id)).body.error.code).toBe('FACE_AUTHORIZATION_EXPIRED');
    await assertPreserved(authorization.id);
    vi.setSystemTime(new Date(NOW.getTime() + 1000));
    face.analyze.mockImplementation(async (...args) => {
      if (args[1].requestId.endsWith(':1')) await prisma.employee.update({ where: { id: f.employees.A }, data: { status: 'NOTICE' } });
      return analyze(...args);
    });
    expect((await upload(alphaTablet, session.body.data.session_id)).body.error.code).toBe('FACE_REGISTRATION_NOT_ACTIVE');
    await assertPreserved(authorization.id);
  });
  it('lets only one of two concurrent sessions consume the same approval', async () => {
    const authorization = (await grant()).body.data;
    const first = await start(alphaTablet), second = await start(betaTablet);
    const replies = await Promise.all([upload(alphaTablet, first.body.data.session_id), upload(betaTablet, second.body.data.session_id)]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(replies.find((r) => r.status === 409).body.error.code).toBe('FACE_AUTHORIZATION_USED');
    expect(await currentTemplates()).toHaveLength(3);
    expect((await prisma.faceRegistrationAuthorization.findUnique({ where: { id: authorization.id } })).status).toBe('USED');
    expect(await prisma.punch.count()).toBe(0);
  });
  it('serializes enrollment across employees so two concurrent first registrations cannot save the same face', async () => {
    const b = await start(alphaTablet, 'T002', 'Person B'), c = await start(betaTablet, 'T003', 'Person C');
    const results = await Promise.all([upload(alphaTablet, b.body.data.session_id), upload(betaTablet, c.body.data.session_id)]);
    expect(results.map((r) => r.body.data.outcome).sort()).toEqual(['DUPLICATE_FACE', 'REGISTERED']);
    expect((await currentTemplates(f.employees.B)).length + (await currentTemplates(f.employees.C)).length).toBe(3);
  });
  it('returns the same committed result for concurrent identical uploads without a second replacement', async () => {
    await grant();
    const session = await start();
    const results = await Promise.all([upload(alphaTablet, session.body.data.session_id, 'concurrent-replay'), upload(alphaTablet, session.body.data.session_id, 'concurrent-replay')]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[0].body.data).toEqual(results[1].body.data);
    expect(await currentTemplates()).toHaveLength(3);
    expect(await prisma.punchAttempt.count({ where: { session_id: session.body.data.session_id, request_id: 'concurrent-replay' } })).toBe(1);
  });
  it('does not let a slower failed upload reopen a session that another upload has completed', async () => {
    await grant();
    const session = await start();
    let release;
    let announce;
    const waiting = new Promise((resolve) => { announce = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    face.analyze.mockImplementation(async (...args) => {
      if (args[1].requestId === 'slow-failure:0') { announce(); await gate; }
      return analyzeFrames(...args, NEW, args[1].requestId.startsWith('slow-failure:') ? 0 : 0.95);
    });
    const slow = upload(alphaTablet, session.body.data.session_id, 'slow-failure').then((r) => r);
    await waiting;
    const success = await upload(alphaTablet, session.body.data.session_id, 'fast-success');
    expect(success.body.data.outcome).toBe('REGISTERED');
    release();
    expect((await slow).body.error.code).toBe('SESSION_STATE');
    expect((await prisma.punchSession.findUnique({ where: { id: session.body.data.session_id } })).status).toBe('DONE');
    expect(await currentTemplates()).toHaveLength(3);
  });
  it('can confirm an outstanding attendance punch but never learns the retired face after replacement', async () => {
    face.analyze.mockImplementation(async (...args) => analyzeFrames(...args, OLD));
    const punchSession = await alphaTablet.post('/api/v1/punches/sessions').send(POS);
    const identified = await upload(alphaTablet, punchSession.body.data.session_id, 'old-punch', false);
    expect(identified.body.data.outcome).toBe('IDENTIFIED');
    vi.setSystemTime(new Date(NOW.getTime() + 1000));
    await grant();
    const registerSession = await start();
    face.analyze.mockImplementation(async (...args) => analyzeFrames(...args));
    expect((await upload(alphaTablet, registerSession.body.data.session_id)).body.data.outcome).toBe('REGISTERED');
    const confirm = await alphaTablet.post(`/api/v1/punches/sessions/${punchSession.body.data.session_id}/confirm`).send({ ...POS, confirm_token: identified.body.data.confirm_token });
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(201);
    const current = await currentTemplates();
    expect(current).toHaveLength(3);
    expect(current.every((t) => t.embedding.equals(embeddingToBytes(NEW)))).toBe(true);
    expect(await prisma.punch.count()).toBe(1);
  });
});
