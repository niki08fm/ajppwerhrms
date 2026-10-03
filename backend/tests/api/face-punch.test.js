import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { embeddingToBytes, FaceServiceBusy, MODEL_VERSION } from '@ajpwer/face';
import { prisma } from '../../src/config/db.js';
import { hashPassword } from '../../src/services/auth.service.js';
import { invalidateFaceCache, setFaceClient, snapshotDir } from '../../src/services/face.service.js';
import { computeMonth1 } from '../../src/services/attendance.service.js';
import { app, buildFixture } from './fixture.js';

/**
 * Face v2 tablet punches with the face service mocked: the mock returns what the
 * Python service would (per-frame faces, yaw, live score, 128-number embedding).
 */

// ─── Fake faces ──────────────────────────────────────────────────────────────

function unitVector(seed) {
  let a = seed * 2654435761;
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const v = Array.from({ length: 128 }, () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()));
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}
const FACE = { A: unitVector(11), B: unitVector(23), C: unitVector(37), STRANGER: unitVector(99) };
const CROP = Buffer.from('fake-jpeg-crop').toString('base64');

function frame(embedding, { yaw = 0, live = 0.95, faces = 1, brightness = 120 } = {}) {
  return {
    faces,
    face: faces === 1 ? { box: [200, 120, 160, 160], score: 0.98, landmarks: [] } : null,
    yaw: faces === 1 ? yaw : null,
    quality: faces === 1 ? { brightness, sharpness: 220, face_px: 160 } : null,
    live: faces === 1 ? { v2: live, v1se: live, score: live } : null,
    embedding: faces === 1 ? embedding : null,
    crop_jpeg: faces === 1 ? CROP : null,
  };
}

/** A proper scan: three pictures of the person looking straight, a moment apart. */
function scanOf(embedding, opts = {}) {
  return { model_version: MODEL_VERSION, ms: 40, frames: [0, 2, -2].map((yaw, index) => ({ index, ...frame(embedding, { ...opts, yaw }) })) };
}

// ─── Mock face service ───────────────────────────────────────────────────────

const face = { analyze: vi.fn(), health: vi.fn() };
let next = null;
face.analyze.mockImplementation(async (_frames, { requestId }) => {
  if (typeof next === 'function') return next(requestId);
  return next;
});

// ─── Tablets ─────────────────────────────────────────────────────────────────

let f;
let sites;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const POS = { ALPHA: { lat: 16.5063, lng: 80.6481, accuracy_m: 12 }, BETA: { lat: 16.5731, lng: 80.7101, accuracy_m: 12 }, GAMMA: { lat: 16.6, lng: 80.8, accuracy_m: 12 } };
let clock;

function at(minutes) {
  clock = new Date(clock.getTime() + minutes * 60_000);
  vi.setSystemTime(clock);
}

async function tabletFor(code) {
  const agent = request.agent(app);
  const login = { ALPHA: ['site-alpha', 'site-pass-1'], BETA: ['site-beta', 'beta-pass-1'], GAMMA: ['site-gamma', 'gamma-pass-1'] }[code];
  const r = await agent.post('/api/v1/auth/site-login').send({ login: login[0], password: login[1], ...POS[code] });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  agent.pos = POS[code];
  return agent;
}

async function start(tablet, body = {}) {
  const r = await tablet.post('/api/v1/punches/sessions').send({ ...tablet.pos, ...body });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.data;
}

let rid = 0;
const newRequestId = () => `req-${Date.now()}-${++rid}`;

function upload(tablet, sessionId, requestId = newRequestId()) {
  return tablet
    .post(`/api/v1/punches/sessions/${sessionId}/frames`)
    .field('request_id', requestId)
    .field('lat', String(tablet.pos.lat))
    .field('lng', String(tablet.pos.lng))
    .field('accuracy_m', String(tablet.pos.accuracy_m))
    .attach('front', JPEG, { filename: 'front.jpg', contentType: 'image/jpeg' })
    .attach('front2', JPEG, { filename: 'front2.jpg', contentType: 'image/jpeg' })
    .attach('front3', JPEG, { filename: 'front3.jpg', contentType: 'image/jpeg' });
}

/** Scan a face at a tablet; returns the session and the frames reply. */
async function scan(tablet, embedding, opts = {}) {
  const s = opts.session ?? (await start(tablet));
  next = scanOf(embedding, opts);
  const r = await upload(tablet, s.session_id, opts.requestId);
  return { s, r, d: r.body.data };
}

/**
 * A guided registration: straight, turned to the person's left, to their right, eyes closed.
 * The backend sends them to the face service as two pairs; `who` swaps the face in a picture.
 */
function registrationOf(embedding, { yaw = {}, live = {}, who = {} } = {}) {
  const y = { front: 0, left: 25, right: -25, blink: 0, ...yaw };
  const one = (name, index) => ({ index, ...frame(who[name] ?? embedding, { yaw: y[name], live: live[name] ?? 0.95 }) });
  return (requestId) => ({
    model_version: MODEL_VERSION,
    ms: 20,
    frames: requestId.endsWith(':0') ? [one('front', 0), one('left', 1)] : [one('right', 0), one('blink', 1)],
  });
}

function uploadRegistration(tablet, sessionId) {
  const r = tablet
    .post(`/api/v1/punches/sessions/${sessionId}/frames`)
    .field('request_id', newRequestId())
    .field('lat', String(tablet.pos.lat))
    .field('lng', String(tablet.pos.lng))
    .field('accuracy_m', String(tablet.pos.accuracy_m));
  for (const n of ['front', 'left', 'right', 'blink']) r.attach(n, JPEG, { filename: `${n}.jpg`, contentType: 'image/jpeg' });
  return r;
}

const confirm = (tablet, s, d) => tablet.post(`/api/v1/punches/sessions/${s.session_id}/confirm`).send({ confirm_token: d.confirm_token, ...tablet.pos });

/** Scan and confirm: one punch. */
async function punch(tablet, embedding) {
  const { s, d } = await scan(tablet, embedding);
  expect(d.outcome, JSON.stringify(d)).toBe('IDENTIFIED');
  const c = await confirm(tablet, s, d);
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  return c.body.data;
}

async function register(employeeId, embedding) {
  await prisma.employeeFace.create({ data: { employee_id: employeeId, embedding: embeddingToBytes(embedding), model_version: MODEL_VERSION, kind: 'REGISTERED', consent_at: new Date() } });
  invalidateFaceCache();
}

beforeAll(async () => {
  f = await buildFixture();
  const beta = await prisma.site.create({ data: { code: 'BETA', name: 'Beta', state: 'Andhra Pradesh', ...pick(POS.BETA), radius_m: 400, login: 'site-beta', password_hash: await hashPassword('beta-pass-1') } });
  const gamma = await prisma.site.create({ data: { code: 'GAMMA', name: 'Gamma', state: 'Andhra Pradesh', ...pick(POS.GAMMA), radius_m: 400, login: 'site-gamma', password_hash: await hashPassword('gamma-pass-1') } });
  sites = { ALPHA: f.siteId, BETA: beta.id, GAMMA: gamma.id };
  setFaceClient(face);
});
const pick = (p) => ({ lat: p.lat, lng: p.lng });

beforeEach(async () => {
  // Every test starts on a fresh day, at 09:00 IST, with A and B registered and C only on the old model.
  clock = new Date(Date.UTC(2026, 9, 5 + (beforeEach.n = (beforeEach.n ?? 0) + 1), 3, 30));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  await prisma.employeeFace.deleteMany({});
  await prisma.loginAttempt.deleteMany({});
  await register(f.employees.A, FACE.A);
  await register(f.employees.B, FACE.B);
  await prisma.employeeFace.create({ data: { employee_id: f.employees.C, embedding: embeddingToBytes(FACE.C), model_version: 'faceapi-v1', consent_at: new Date() } });
  invalidateFaceCache();
  face.analyze.mockClear();
  next = null;
  f.agent = await hrAgent();
});

/** HR signs in at the test's clock (sessions last 8 hours). */
async function hrAgent() {
  const agent = request.agent(app);
  const r = await agent.post('/api/v1/auth/login').send({ email: 'hr@test.in', password: 'test-password-1' });
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return agent;
}
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  setFaceClient(null);
  await prisma.$disconnect();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Identify, then confirm', () => {
  it('identified → confirm IN; later identified → confirm OUT', async () => {
    const tablet = await tabletFor('ALPHA');
    const { s, d } = await scan(tablet, FACE.A);
    expect(d.outcome).toBe('IDENTIFIED');
    expect(d.employee.name).toBe('Person A');
    expect(d.direction).toBe('IN');
    expect(d.confirm_token).toMatch(/^[0-9a-f]{48}$/);
    expect(d.employee.id).toBeUndefined();
    // The frames went to the face service as two JPEGs with our request id.
    expect(face.analyze).toHaveBeenCalledTimes(1);
    expect(face.analyze.mock.calls[0][0]).toHaveLength(3);

    const c = await confirm(tablet, s, d);
    expect(c.status).toBe(201);
    expect(c.body.data.direction).toBe('IN');
    expect(c.body.data.message).toMatch(/^Punched in at \d\d:\d\d\. Have a good day, Person\.$/);
    const p = await prisma.punch.findUnique({ where: { id: c.body.data.id } });
    expect(p).toMatchObject({ method: 'FACE', session_id: s.session_id, site_id: sites.ALPHA });
    expect(Number(p.match_score)).toBeCloseTo(1, 3);

    at(8 * 60);
    const out = await punch(tablet, FACE.A);
    expect(out.direction).toBe('OUT');
    expect(out.message).toMatch(/^Punched out at/);
  });

  it('a person only on the old model is not identified: their punches go to the manual request', async () => {
    const tablet = await tabletFor('ALPHA');
    const { d } = await scan(tablet, FACE.C);
    expect(d.outcome).toBe('NO_MATCH');
    expect(d.tries_left).toBe(4);
  });

  it('a stranger, a lookalike too close to call and a photo are all failed tries', async () => {
    const tablet = await tabletFor('ALPHA');
    const s = await start(tablet);
    const closeToBoth = FACE.A.map((x, i) => x + FACE.B[i]);
    const n = Math.hypot(...closeToBoth);
    for (const [emb, opts, outcome] of [
      [FACE.STRANGER, {}, 'NO_MATCH'],
      [closeToBoth.map((x) => x / n), {}, 'NO_MATCH'],
      [FACE.A, { live: 0.2 }, 'NOT_LIVE'],
    ]) {
      next = scanOf(emb, opts);
      const r = await upload(tablet, s.session_id);
      expect(r.body.data.outcome).toBe(outcome);
    }
    const row = await prisma.punchSession.findUnique({ where: { id: s.session_id } });
    expect(row.tries).toBe(3);
    expect(row.crop_keys).toHaveLength(3);
  });

  it('no face, two faces and poor light are not tries', async () => {
    const tablet = await tabletFor('ALPHA');
    const s = await start(tablet);
    for (const opts of [{ faces: 0 }, { faces: 2 }, { brightness: 10 }]) {
      next = scanOf(FACE.A, opts);
      const r = await upload(tablet, s.session_id);
      expect(r.body.data.tries_left).toBe(5);
    }
  });
});

describe('Duplicates', () => {
  it('double punch-in is refused: two sessions identified before either confirmed', async () => {
    const t1 = await tabletFor('ALPHA');
    const t2 = await tabletFor('ALPHA');
    const one = await scan(t1, FACE.A);
    const two = await scan(t2, FACE.A);
    expect(one.d.direction).toBe('IN');
    expect(two.d.direction).toBe('IN');
    expect((await confirm(t1, one.s, one.d)).status).toBe(201);
    const refused = await confirm(t2, two.s, two.d);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('DUPLICATE_PUNCH');
    expect(await prisma.punch.count({ where: { employee_id: f.employees.A, work_date: new Date(clock.toISOString().slice(0, 10)) } })).toBe(1);
  });

  it('scanning again within two minutes does not punch again', async () => {
    const tablet = await tabletFor('ALPHA');
    await punch(tablet, FACE.A);
    at(1);
    const { d } = await scan(tablet, FACE.A);
    expect(d.outcome).toBe('DUPLICATE');
    expect(d.code).toBe('REPEAT');
    expect(d.message).toMatch(/already recorded at/);
  });
});

describe('Tries and the manual request', () => {
  it('"This is not me" counts a try and is logged against the shown person', async () => {
    const tablet = await tabletFor('ALPHA');
    const { s, d } = await scan(tablet, FACE.A);
    const r = await tablet.post(`/api/v1/punches/sessions/${s.session_id}/not-me`).send({ confirm_token: d.confirm_token });
    expect(r.status).toBe(200);
    expect(r.body.data.tries_left).toBe(4);
    expect(r.body.data.status).toBe('ACTIVE');
    expect(r.body.data.challenge.direction).toMatch(/LEFT|RIGHT/);
    // The old confirm token is dead.
    expect((await confirm(tablet, s, d)).status).toBe(409);
    const attempts = await prisma.punchAttempt.findMany({ where: { session_id: s.session_id }, orderBy: { created_at: 'asc' } });
    expect(attempts.map((a) => [a.outcome, a.resolution]).sort()).toEqual([
      ['IDENTIFIED', 'NOT_ME'],
      ['NOT_ME', null],
    ]);
    expect(attempts.find((a) => a.outcome === 'NOT_ME')).toMatchObject({ employee_id: f.employees.A, counts_as_try: true });
  });

  it('5 failed tries → blocked → ID and name → manual request with the crops, which HR approves', async () => {
    const tablet = await tabletFor('ALPHA');
    const s = await start(tablet);
    let last;
    for (let i = 0; i < 5; i++) {
      next = scanOf(FACE.STRANGER);
      last = (await upload(tablet, s.session_id)).body.data;
    }
    expect(last.status).toBe('BLOCKED');
    expect(last.tries_left).toBe(0);
    expect(last.message).toMatch(/Enter your employee ID and name/);
    // No more scans in a blocked session.
    expect((await upload(tablet, s.session_id)).status).toBe(409);

    expect((await tablet.post(`/api/v1/punches/sessions/${s.session_id}/manual`).send({ employee_code: 'NOPE', name: 'Nobody', ...tablet.pos })).status).toBe(422);
    const m = await tablet.post(`/api/v1/punches/sessions/${s.session_id}/manual`).send({ employee_code: 't003', name: 'person c', ...tablet.pos });
    expect(m.status).toBe(201);
    expect(m.body.data.message).toBe('Sent to HR. They will check it and add your punch.');
    const fx = await prisma.faceException.findUnique({ where: { id: m.body.data.exception_id } });
    expect(fx).toMatchObject({ kind: 'FAILED_TRIES', claimed_employee_id: f.employees.C, status: 'PENDING', direction: 'IN' });
    expect(fx.crop_keys).toHaveLength(5);
    expect(fx.reason).toMatch(/5 failed face tries; not registered with the new face system yet/);
    for (const k of fx.crop_keys) expect(existsSync(path.join(snapshotDir, k))).toBe(true);
    // Nothing is marked present until HR decides.
    expect(await prisma.punch.count({ where: { employee_id: f.employees.C, session_id: s.session_id } })).toBe(0);

    const list = await f.agent.get('/api/v1/face-exceptions');
    const row = list.body.data.find((x) => x.id === fx.id);
    expect(row.crops).toBe(5);
    expect(row.crop_keys).toBeUndefined();
    const img = await f.agent.get(`/api/v1/face-exceptions/${fx.id}/crops/0`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toMatch(/jpeg/);
    expect((await tablet.get(`/api/v1/face-exceptions/${fx.id}/crops/0`)).status).toBe(401);

    const ok = await f.agent.post(`/api/v1/face-exceptions/${fx.id}/decide`).send({ decision: 'APPROVE', employee_id: f.employees.C, reason: 'Known to the site in-charge' });
    expect(ok.status).toBe(200);
    expect((await prisma.punch.findUnique({ where: { id: ok.body.data.punch_id } })).method).toBe('EXCEPTION');
  });
});

describe('The face service is busy', () => {
  it('busy never counts as a try, and the retry with the same request id is analysed', async () => {
    const tablet = await tabletFor('ALPHA');
    const s = await start(tablet);
    next = () => {
      throw new FaceServiceBusy();
    };
    const busy = await upload(tablet, s.session_id, 'req-busy-0001');
    expect(busy.status).toBe(503);
    expect(busy.body.error.code).toBe('FACE_BUSY');
    expect(busy.body.data.tries_left).toBe(5);
    expect(busy.body.data.retry_same_request).toBe(true);

    next = scanOf(FACE.A);
    const retry = await upload(tablet, s.session_id, 'req-busy-0001');
    expect(retry.status).toBe(200);
    expect(retry.body.data.outcome).toBe('IDENTIFIED');
    expect(retry.body.data.tries_left).toBe(5);
    const log = await prisma.punchAttempt.findMany({ where: { session_id: s.session_id }, orderBy: { created_at: 'asc' } });
    expect(log.map((a) => [a.outcome, a.counts_as_try]).sort()).toEqual([
      ['BUSY', false],
      ['IDENTIFIED', false],
    ]);
  });
});

describe('The same request id never punches twice', () => {
  it('a retried upload gets the same answer (with a fresh token); a repeated confirm returns the same punch', async () => {
    const tablet = await tabletFor('ALPHA');
    const { s, d } = await scan(tablet, FACE.A, { requestId: 'req-same-0001' });
    const again = await upload(tablet, s.session_id, 'req-same-0001');
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(again.body.data.employee).toEqual(d.employee);
    expect(face.analyze).toHaveBeenCalledTimes(1);
    // The latest token is the one that works.
    expect((await confirm(tablet, s, d)).status).toBe(409);
    const first = await confirm(tablet, s, again.body.data);
    expect(first.status).toBe(201);
    const second = await confirm(tablet, s, again.body.data);
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.duplicate).toBe(true);
    await upload(tablet, s.session_id, 'req-same-0001');
    expect(await prisma.punch.count({ where: { session_id: s.session_id } })).toBe(1);
  });
});

describe('Challenge expiry', () => {
  it('an upload after the challenge expired is not analysed and not a try; a new challenge is issued', async () => {
    const tablet = await tabletFor('ALPHA');
    const s = await start(tablet);
    at(2);
    next = scanOf(FACE.A);
    const r = await upload(tablet, s.session_id);
    expect(r.body.data.outcome).toBe('EXPIRED');
    expect(r.body.data.message).toBe('That took too long. Try again.');
    expect(r.body.data.tries_left).toBe(5);
    expect(new Date(r.body.data.challenge.expires_at).getTime()).toBeGreaterThan(Date.now());
    expect(face.analyze).not.toHaveBeenCalled();
  });

  it('a confirmation left too long must scan again, without a try', async () => {
    const tablet = await tabletFor('ALPHA');
    const { s, d } = await scan(tablet, FACE.A);
    at(2);
    const r = await confirm(tablet, s, d);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('CONFIRM_EXPIRED');
    expect(r.body.data.tries_left).toBe(5);
    expect(await prisma.punch.count({ where: { session_id: s.session_id } })).toBe(0);
  });
});

describe('Register face on the tablet: four guided pictures', () => {
  it('registers with ID and name as three face codes; a second registration and a face already someone else’s are refused', async () => {
    const tablet = await tabletFor('ALPHA');
    const wrongName = await tablet.post('/api/v1/punches/sessions').send({ purpose: 'REGISTER', employee_code: 'T003', name: 'Someone Else', ...tablet.pos });
    expect(wrongName.status).toBe(422);

    // C tries to register with A's face: refused, nothing saved.
    const dupSession = await start(tablet, { purpose: 'REGISTER', employee_code: 'T003', name: 'Person C' });
    next = registrationOf(FACE.A);
    const dup = await uploadRegistration(tablet, dupSession.session_id);
    expect(dup.body.data.outcome).toBe('DUPLICATE_FACE');
    expect(dup.body.data.message).toBe('This face is already registered to another person. Ask HR.');
    expect(await prisma.employeeFace.count({ where: { employee_id: f.employees.C, model_version: MODEL_VERSION } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'face.register_refused', entity_id: f.employees.C } })).toBe(1);

    // Two pictures alone are not a registration.
    const ok = await start(tablet, { purpose: 'REGISTER', employee_code: 'T003', name: 'Person C' });
    expect(ok.employee).toEqual({ name: 'Person C', code: 'T003' });
    expect((await upload(tablet, ok.session_id)).status).toBe(422);

    // C with their own face: the four pictures are analysed as two pairs; straight, left and right are kept.
    face.analyze.mockClear();
    next = registrationOf(FACE.C);
    const reg = await uploadRegistration(tablet, ok.session_id);
    expect(reg.body.data.outcome, JSON.stringify(reg.body)).toBe('REGISTERED');
    expect(face.analyze).toHaveBeenCalledTimes(2);
    const kept = await prisma.employeeFace.findMany({ where: { employee_id: f.employees.C, model_version: MODEL_VERSION, deleted_at: null } });
    expect(kept).toHaveLength(3);
    expect(kept.every((t) => t.kind === 'REGISTERED' && t.site_id === sites.ALPHA)).toBe(true);
    const audit = await prisma.auditLog.findFirst({ where: { action: 'face.register', entity_id: f.employees.C } });
    expect(audit.detail).toMatchObject({ pictures: 4, templates: 3, turns: { left: 25, right: 25 } });
    expect((await scan(tablet, FACE.C)).d.outcome).toBe('IDENTIFIED');

    const again = await tablet.post('/api/v1/punches/sessions').send({ purpose: 'REGISTER', employee_code: 'T003', name: 'Person C', ...tablet.pos });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_REGISTERED');
  });

  it('the head turns prove a live person: each must be seen, the right way, by the same person', async () => {
    const tablet = await tabletFor('ALPHA');
    const s = await start(tablet, { purpose: 'REGISTER', employee_code: 'T003', name: 'Person C' });
    const tryWith = async (opts) => {
      next = registrationOf(FACE.C, opts);
      return (await uploadRegistration(tablet, s.session_id)).body.data;
    };
    expect(await tryWith({ yaw: { left: 6 } })).toMatchObject({ outcome: 'CHALLENGE_FAILED', code: 'TURN_LEFT_NOT_SEEN' });
    // Turned left when asked to turn right.
    expect(await tryWith({ yaw: { right: 20 } })).toMatchObject({ outcome: 'CHALLENGE_FAILED', code: 'TURN_RIGHT_NOT_SEEN' });
    expect(await tryWith({ who: { blink: FACE.STRANGER } })).toMatchObject({ outcome: 'CHALLENGE_FAILED', code: 'NOT_SAME_PERSON' });
    expect(await prisma.employeeFace.count({ where: { employee_id: f.employees.C, model_version: MODEL_VERSION } })).toBe(0);
    // A webcam that scores a real face low is still a real person once the turns are seen.
    const webcam = { front: 0.3, left: 0.12, right: 0.25, blink: 0.08 };
    expect(await tryWith({ live: webcam })).toMatchObject({ outcome: 'REGISTERED' });
  });

  it('a flat photo is refused: it scores as not live in every picture', async () => {
    const tablet = await tabletFor('ALPHA');
    const s = await start(tablet, { purpose: 'REGISTER', employee_code: 'T003', name: 'Person C' });
    next = registrationOf(FACE.C, { live: { front: 0.05, left: 0.04, right: 0.06, blink: 0.05 } });
    expect((await uploadRegistration(tablet, s.session_id)).body.data.outcome).toBe('NOT_LIVE');
    expect(await prisma.employeeFace.count({ where: { employee_id: f.employees.C, model_version: MODEL_VERSION } })).toBe(0);
  });
});

describe('Rolling templates', () => {
  it('confident punches teach new templates; only the newest rolling ones are kept, registered ones never go', async () => {
    const tablet = await tabletFor('ALPHA');
    for (let i = 0; i < 7; i++) {
      await punch(tablet, FACE.A);
      at(30);
    }
    const live = await prisma.employeeFace.findMany({ where: { employee_id: f.employees.A, deleted_at: null, model_version: MODEL_VERSION } });
    expect(live.filter((t) => t.kind === 'REGISTERED')).toHaveLength(1);
    expect(live.filter((t) => t.kind === 'ROLLING')).toHaveLength(5);
    const trimmed = await prisma.employeeFace.findMany({ where: { employee_id: f.employees.A, deleted_at: { not: null }, kind: 'ROLLING' } });
    expect(trimmed).toHaveLength(2);
    expect(trimmed.every((t) => t.embedding.length === 0)).toBe(true);
  });

  it('a punch that was only just recognised does not teach anything', async () => {
    const tablet = await tabletFor('ALPHA');
    // Similarity exactly 0.45 to A: above the match minimum, below the learning minimum.
    const dotAS = FACE.A.reduce((sum, x, i) => sum + x * FACE.STRANGER[i], 0);
    const ortho = FACE.STRANGER.map((x, i) => x - dotAS * FACE.A[i]);
    const on = Math.hypot(...ortho);
    const blurred = FACE.A.map((x, i) => 0.45 * x + Math.sqrt(1 - 0.45 ** 2) * (ortho[i] / on));
    await punch(tablet, blurred);
    expect(await prisma.employeeFace.count({ where: { employee_id: f.employees.A, kind: 'ROLLING' } })).toBe(0);
  });
});

describe('Change site with travel minutes', () => {
  it('travel counts when he punches in at the site he named, the same day; HR sees it and can change it', async () => {
    const alpha = await tabletFor('ALPHA');
    const beta = await tabletFor('BETA');
    await punch(alpha, FACE.B);
    at(3 * 60);
    const { s, d } = await scan(alpha, FACE.B);
    expect(d.direction).toBe('OUT');
    expect(d.can_change_site).toBe(true);
    const others = await alpha.get('/api/v1/tablet/sites');
    expect(others.body.data.map((x) => x.name)).toEqual(['Beta', 'Gamma']);
    const cs = await alpha.post(`/api/v1/punches/sessions/${s.session_id}/change-site`).send({ confirm_token: d.confirm_token, to_site_id: sites.BETA, ...alpha.pos });
    expect(cs.status).toBe(201);
    expect(cs.body.data.direction).toBe('OUT');
    expect(cs.body.data.message).toMatch(/Punch in at Beta when you arrive/);

    at(40);
    await punch(beta, FACE.B);
    const change = await prisma.siteChange.findFirst({ where: { employee_id: f.employees.B } });
    expect(change).toMatchObject({ status: 'COUNTED', travel_min: 40, from_site_id: sites.ALPHA, to_site_id: sites.BETA });

    at(4 * 60);
    await punch(beta, FACE.B);
    // The day counts 3 h + 40 min travel + 4 h.
    const ym = clock.toISOString().slice(0, 7);
    const date = new Date(clock.getTime() + 330 * 60_000).toISOString().slice(0, 10);
    const e = await prisma.employee.findUnique({ where: { id: f.employees.B } });
    const day = (await computeMonth1(prisma, e, ym)).result.days.find((x) => x.date === date);
    expect(day.travel_min).toBe(40);
    expect(day.worked_min).toBe(7 * 60 + 40);
    expect(day.flags).toContain('TRAVEL');

    const list = await f.agent.get('/api/v1/site-changes').query({ reviewed: 'false' });
    expect(list.body.meta.unreviewed).toBe(1);
    expect(list.body.data[0]).toMatchObject({ effective_travel_min: 40, from_site: { name: 'Alpha' }, to_site: { name: 'Beta' } });
    const hr = await f.agent.patch(`/api/v1/site-changes/${change.id}`).send({ travel_min: 30, reason: 'Bus takes 30 min' });
    expect(hr.body.data.effective_travel_min).toBe(30);
    expect((await computeMonth1(prisma, e, ym)).result.days.find((x) => x.date === date).worked_min).toBe(7 * 60 + 30);
  });

  it('no travel when he punches in at a different site than he named', async () => {
    const alpha = await tabletFor('ALPHA');
    const gamma = await tabletFor('GAMMA');
    await punch(alpha, FACE.B);
    at(60);
    const { s, d } = await scan(alpha, FACE.B);
    await alpha.post(`/api/v1/punches/sessions/${s.session_id}/change-site`).send({ confirm_token: d.confirm_token, to_site_id: sites.BETA, ...alpha.pos });
    at(30);
    await punch(gamma, FACE.B);
    const change = await prisma.siteChange.findFirst({ where: { employee_id: f.employees.B }, orderBy: { created_at: 'desc' } });
    expect(change.status).toBe('NOT_COUNTED');
    expect(change.travel_min).toBeNull();
  });

  it('no travel when he reaches the named site only the next day', async () => {
    const alpha = await tabletFor('ALPHA');
    await punch(alpha, FACE.B);
    at(60);
    const { s, d } = await scan(alpha, FACE.B);
    await alpha.post(`/api/v1/punches/sessions/${s.session_id}/change-site`).send({ confirm_token: d.confirm_token, to_site_id: sites.BETA, ...alpha.pos });
    at(24 * 60);
    await punch(await tabletFor('BETA'), FACE.B);
    const change = await prisma.siteChange.findFirst({ where: { employee_id: f.employees.B }, orderBy: { created_at: 'desc' } });
    expect(change.status).toBe('NOT_COUNTED');
  });
});

describe('The attempt log', () => {
  it('HR can export every attempt as CSV, without images or face codes', async () => {
    const tablet = await tabletFor('ALPHA');
    await punch(tablet, FACE.A);
    await scan(tablet, FACE.STRANGER);
    const date = new Date(clock.getTime() + 330 * 60_000).toISOString().slice(0, 10);
    const r = await f.agent.get('/api/v1/punch-attempts.csv').query({ from: date, to: date });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    const lines = r.text.trim().split('\r\n');
    expect(lines[0]).toContain('outcome');
    expect(lines[0]).toContain('live_score');
    expect(lines.some((l) => l.includes('IDENTIFIED') && l.includes('CONFIRMED') && l.includes('T001'))).toBe(true);
    expect(lines.some((l) => l.includes('NO_MATCH'))).toBe(true);
    expect(r.text).not.toContain('embedding');
    expect(r.text).not.toContain(CROP);
  });
});
