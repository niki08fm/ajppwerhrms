import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { Writable } from 'node:stream';
import { SITE_PASSWORD_ALPHABET, generateSitePassword } from '@ajpwer/shared';
import { prisma } from '../../src/config/db.js';
import { logger, REDACT_PATHS } from '../../src/config/logger.js';
import { createGeoSearch, geoSearch } from '../../src/services/geo.service.js';
import { app, buildFixture } from './fixture.js';

let f;

// Site A of the prompt: 17.4448, 78.3498, radius 200 m.
const CENTRE = { lat: 17.4448, lng: 78.3498 };
const INSIDE = { lat: 17.4449, lng: 78.3499, accuracy_m: 12 };
const OUTSIDE = { lat: 17.4479, lng: 78.3498, accuracy_m: 12 }; // ≈ 345 m north

const base = (over = {}) => ({ code: 'SITEA', name: 'Site A', state: 'Telangana', ...CENTRE, radius_m: 200, login: 'Site-A-Tab', ...over });

async function createSite(over = {}) {
  const r = await f.agent.post('/api/v1/sites').send(base(over));
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.data;
}

const signIn = (agent, login, password, pos = INSIDE) => agent.post('/api/v1/auth/site-login').send({ login, password, ...pos });

beforeAll(async () => {
  f = await buildFixture();
});
beforeEach(async () => {
  await prisma.loginAttempt.deleteMany({});
  await prisma.site.deleteMany({ where: { id: { not: f.siteId } } });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('Create and edit a site: validation', () => {
  it('radius defaults to 200 m and must be 50–2000 m', async () => {
    const { radius_m, ...noRadius } = base();
    const ok = await f.agent.post('/api/v1/sites').send({ ...noRadius, password: 'abcd1234' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.radius_m).toBe(200);
    for (const bad of [49, 2001]) {
      const r = await f.agent.post('/api/v1/sites').send(base({ code: 'SITEB', name: 'Site B', login: 'site-b', radius_m: bad }));
      expect(r.status).toBe(422);
      expect(r.body.error.field).toBe('radius_m');
    }
    const edit = await f.agent.patch(`/api/v1/sites/${ok.body.data.id}`).send({ radius_m: 2500 });
    expect(edit.status).toBe(422);
    expect((await f.agent.patch(`/api/v1/sites/${ok.body.data.id}`).send({ radius_m: 50 })).body.data.radius_m).toBe(50);
    expect((await f.agent.patch(`/api/v1/sites/${ok.body.data.id}`).send({ radius_m: 2000 })).body.data.radius_m).toBe(2000);
  });

  it('name is required and unique, ignoring case', async () => {
    await createSite();
    const dup = await f.agent.post('/api/v1/sites').send(base({ code: 'SITEB', name: 'site a', login: 'site-b' }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.field).toBe('name');
    const blank = await f.agent.post('/api/v1/sites').send(base({ code: 'SITEB', name: '  ', login: 'site-b' }));
    expect(blank.status).toBe(422);
    // Renaming another site onto it is refused too.
    const other = await createSite({ code: 'SITEB', name: 'Site B', login: 'site-b' });
    expect((await f.agent.patch(`/api/v1/sites/${other.id}`).send({ name: 'SITE A' })).status).toBe(409);
  });

  it('login ID: 4–32 letters, numbers or dashes, stored lower-case, unique ignoring case', async () => {
    const s = await createSite();
    expect(s.login).toBe('site-a-tab');
    const dup = await f.agent.post('/api/v1/sites').send(base({ code: 'SITEB', name: 'Site B', login: 'SITE-A-TAB' }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.field).toBe('login');
    for (const bad of ['abc', 'a'.repeat(33), 'site a', 'site_a', 'site@a']) {
      const r = await f.agent.post('/api/v1/sites').send(base({ code: 'SITEB', name: 'Site B', login: bad }));
      expect(r.status, bad).toBe(422);
      expect(r.body.error.field).toBe('login');
    }
  });

  it('password: at least 8 characters with a letter and a number, or generated', async () => {
    for (const bad of ['abc123', 'abcdefgh', '12345678']) {
      const r = await f.agent.post('/api/v1/sites').send(base({ password: bad }));
      expect(r.status, bad).toBe(422);
      expect(r.body.error.field).toBe('password');
    }
    const typed = await f.agent.post('/api/v1/sites').send(base({ password: 'goodpass9' }));
    expect(typed.status).toBe(201);
    expect(typed.body.data.credentials.password).toBe('goodpass9');
    const gen = await f.agent.post('/api/v1/sites').send(base({ code: 'SITEB', name: 'Site B', login: 'site-b' }));
    const pw = gen.body.data.credentials.password;
    expect(pw).toHaveLength(12);
    expect(pw).toMatch(/[A-Za-z]/);
    expect(pw).toMatch(/[0-9]/);
    expect(gen.body.data.credentials.note).toBe("Write this down or share it with the site in-charge now. It won't be shown again.");
  });

  it('the generator never uses look-alike characters', () => {
    for (const c of '0O1lIo') expect(SITE_PASSWORD_ALPHABET).not.toContain(c);
    for (let i = 0; i < 200; i++) {
      const pw = generateSitePassword();
      expect(pw).toMatch(/^[A-HJ-NP-Za-km-np-z2-9]{12}$/);
      expect(pw).toMatch(/[0-9]/);
    }
  });

  it('only HR with sites.manage can create or reset', async () => {
    await prisma.role.updateMany({ data: { permissions: { set: ['attendance.read'] } } });
    const { invalidatePrincipal } = await import('../../src/middleware/auth.js');
    invalidatePrincipal();
    try {
      expect((await f.agent.post('/api/v1/sites').send(base())).status).toBe(403);
      expect((await f.agent.post(`/api/v1/sites/${f.siteId}/password`).send({})).status).toBe(403);
    } finally {
      const { PERMISSIONS } = await import('@ajpwer/shared');
      await prisma.role.updateMany({ data: { permissions: { set: [...PERMISSIONS] } } });
      invalidatePrincipal();
    }
  });

  it('moving the centre or changing the radius is audited and applies from the next sign-in', async () => {
    const s = await createSite({ password: 'goodpass9' });
    const r = await f.agent.patch(`/api/v1/sites/${s.id}`).send({ lat: 17.45, lng: 78.35, radius_m: 300, address: 'Plot 4, Gachibowli' });
    expect(r.status).toBe(200);
    const log = await prisma.auditLog.findFirst({ where: { action: 'site.geofence_change', entity_id: s.id } });
    expect(log.detail.radius_m).toEqual({ from: 200, to: 300 });
    expect(log.detail.lat).toEqual({ from: 17.4448, to: 17.45 });
    // The old centre is now 620 m away: sign-in there is refused with the new radius in the message.
    const t = await signIn(request.agent(app), 'site-a-tab', 'goodpass9', INSIDE);
    expect(t.status).toBe(403);
    expect(t.body.error.message).toMatch(/Sign in from inside the site \(within 300 m\)/);
  });
});

describe('The password is never given out again, nor logged', () => {
  it('only the create and reset replies carry it; lists, detail, the audit log and logs never do', async () => {
    const spies = ['info', 'warn', 'error', 'debug'].map((m) => vi.spyOn(logger, m));
    const s = await createSite({ password: 'secretPass42' });
    const reset = await f.agent.post(`/api/v1/sites/${s.id}/password`).send({});
    const generated = reset.body.data.password;
    await signIn(request.agent(app), 'site-a-tab', 'secretPass42');
    await signIn(request.agent(app), 'site-a-tab', generated);
    const list = await f.agent.get('/api/v1/sites');
    const day = await f.agent.get(`/api/v1/sites/${s.id}/day`);
    const patched = await f.agent.patch(`/api/v1/sites/${s.id}`).send({ address: 'Gate 2' });
    for (const body of [list.body, day.body, patched.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain('secretPass42');
      expect(text).not.toContain(generated);
      expect(text).not.toContain('password');
      expect(text).not.toContain('$argon2');
    }
    const audits = JSON.stringify(await prisma.auditLog.findMany({ where: { entity_id: s.id } }));
    expect(audits).not.toContain('secretPass42');
    expect(audits).not.toContain(generated);
    expect(audits).not.toContain('$argon2');
    for (const spy of spies) {
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).not.toContain('secretPass42');
      expect(logged).not.toContain(generated);
      spy.mockRestore();
    }
    // And if a request body ever reaches a log line, the logger itself blanks the password.
    let out = '';
    const sink = new Writable({ write: (c, _e, cb) => ((out += c), cb()) });
    const l = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, sink);
    l.info({ req: { body: { login: 'x', password: 'secretPass42' } }, password: 'secretPass42', site: { password: 'secretPass42' } }, 'x');
    expect(out).not.toContain('secretPass42');
  });
});

describe('Reset and disable sign every tablet out', () => {
  it('reset: the old token stops working on its next request, and the old password no longer signs in', async () => {
    const s = await createSite({ password: 'firstPass1' });
    const tablet = request.agent(app);
    expect((await signIn(tablet, 'SITE-A-TAB', 'firstPass1')).status).toBe(200);
    expect((await tablet.get('/api/v1/tablet/summary')).status).toBe(200);
    const detail = (await f.agent.get('/api/v1/sites')).body.data.find((x) => x.id === s.id);
    expect(detail.tablet_signed_in).toBe(true);
    expect(detail.last_login_at).toBeTruthy();

    const r = await f.agent.post(`/api/v1/sites/${s.id}/password`).send({ password: 'secondPass2' });
    expect(r.status).toBe(200);
    expect(r.body.data.password).toBe('secondPass2');
    expect((await tablet.get('/api/v1/tablet/summary')).status).toBe(401);
    expect((await f.agent.get('/api/v1/sites')).body.data.find((x) => x.id === s.id).tablet_signed_in).toBe(false);
    expect((await signIn(request.agent(app), 'site-a-tab', 'firstPass1')).body.error.code).toBe('WRONG_PASSWORD');
    expect((await signIn(request.agent(app), 'site-a-tab', 'secondPass2')).status).toBe(200);
    const log = await prisma.auditLog.findFirst({ where: { action: 'site.password_reset', entity_id: s.id } });
    expect(log.actor).toBe('hr@test.in');
    expect(log.at).toBeTruthy();
    // A reset follows the same password rules.
    expect((await f.agent.post(`/api/v1/sites/${s.id}/password`).send({ password: 'short1' })).status).toBe(422);
  });

  it('disable: signs tablets out and refuses sign-in; enable lets the same password work again', async () => {
    const s = await createSite({ password: 'firstPass1' });
    const tablet = request.agent(app);
    await signIn(tablet, 'site-a-tab', 'firstPass1');
    expect((await tablet.get('/api/v1/tablet/summary')).status).toBe(200);
    const off = await f.agent.post(`/api/v1/sites/${s.id}/login-enabled`).send({ enabled: false });
    expect(off.body.data.login_enabled).toBe(false);
    expect((await tablet.get('/api/v1/tablet/summary')).status).toBe(401);
    const refused = await signIn(request.agent(app), 'site-a-tab', 'firstPass1');
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('LOGIN_DISABLED');
    await f.agent.post(`/api/v1/sites/${s.id}/login-enabled`).send({ enabled: true });
    expect((await signIn(request.agent(app), 'site-a-tab', 'firstPass1')).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: { in: ['site.login_disable', 'site.login_enable'] }, entity_id: s.id } })).toBe(2);
  });

  it('there is no way for a tablet to change or reset its own password', async () => {
    await createSite({ password: 'firstPass1' });
    const tablet = request.agent(app);
    await signIn(tablet, 'site-a-tab', 'firstPass1');
    const s = await prisma.site.findUnique({ where: { login: 'site-a-tab' } });
    expect((await tablet.post(`/api/v1/sites/${s.id}/password`).send({ password: 'mine12345' })).status).toBe(401);
    expect((await tablet.post('/api/v1/auth/site-password').send({ password: 'mine12345' })).status).toBe(404);
  });
});

describe('Tablet sign-in, check by check', () => {
  beforeEach(async () => {
    await createSite({ password: 'rightPass1' });
  });

  it('unknown login ID', async () => {
    const r = await signIn(request.agent(app), 'no-such-site', 'rightPass1');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('LOGIN_NOT_FOUND');
  });

  it('wrong password', async () => {
    const r = await signIn(request.agent(app), 'site-a-tab', 'wrongPass1');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('WRONG_PASSWORD');
    expect(r.body.error.message).toContain('Ask HR to reset it');
  });

  it('locked out after five failures in fifteen minutes, even with the right password', async () => {
    for (let i = 0; i < 5; i++) expect((await signIn(request.agent(app), 'site-a-tab', 'wrongPass1')).status).toBe(401);
    const r = await signIn(request.agent(app), 'site-a-tab', 'rightPass1');
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('RATE_LIMITED');
  });

  it('poor GPS accuracy', async () => {
    const r = await signIn(request.agent(app), 'site-a-tab', 'rightPass1', { ...INSIDE, accuracy_m: 120 });
    expect(r.status).toBe(403);
    expect(r.body.error.field).toBe('GPS_ACCURACY');
    expect(r.body.error.message).toContain('accurate to 120 m');
  });

  it('outside the geofence: says how far, from which site, and the limit', async () => {
    const r = await signIn(request.agent(app), 'site-a-tab', 'rightPass1', OUTSIDE);
    expect(r.status).toBe(403);
    expect(r.body.error.field).toBe('OUTSIDE_GEOFENCE');
    expect(r.body.error.message).toMatch(/^You are 3\d\d m from Site A\. Sign in from inside the site \(within 200 m\)\.$/);
    const log = await prisma.auditLog.findFirst({ where: { action: 'geofence.rejected' }, orderBy: { at: 'desc' } });
    expect(log.detail.check).toBe('OUTSIDE_GEOFENCE');
  });

  it('inside the geofence: signed in, with siteId and tokenVersion in the cookie; punches re-check the fence', async () => {
    const tablet = request.agent(app);
    const r = await signIn(tablet, 'site-a-tab', 'rightPass1');
    expect(r.status).toBe(200);
    expect(r.body.data.name).toBe('Site A');
    const cookie = r.headers['set-cookie'].find((c) => c.startsWith('ajpwer_site='));
    expect(cookie).toMatch(/HttpOnly/i);
    const payload = JSON.parse(Buffer.from(cookie.split('=')[1].split(';')[0].split('.')[1], 'base64url').toString());
    expect(payload).toMatchObject({ sid: expect.any(String), tv: 1, typ: 'site' });
    const far = await tablet.post('/api/v1/punches/sessions').send(OUTSIDE);
    expect(far.status).toBe(403);
    expect(far.body.error.message).toMatch(/Punch from inside the site \(within 200 m\)/);
  });
});

describe('Place search proxy', () => {
  const nominatim = [{ display_name: 'Gachibowli, Hyderabad, Telangana, India', lat: '17.4400802', lon: '78.3489168', type: 'suburb' }];

  it('spaces calls to Nominatim by the interval (1 s in production), and caches answers for 24 hours', async () => {
    let clock = 0;
    const calls = [];
    const fetchImpl = vi.fn(async (url, opts) => {
      calls.push({ at: Date.now(), url, ua: opts.headers['User-Agent'] });
      return { ok: true, json: async () => nominatim };
    });
    // Real waiting with a short interval; the cache runs on a controllable clock.
    const geo = createGeoSearch({ fetchImpl, now: () => Date.now() + clock, minIntervalMs: 60, userAgent: 'AJPWER-Workforce/1.0', email: 'it@ajpwer.in' });
    await Promise.all([geo.search('Gachibowli'), geo.search('Madhapur'), geo.search('Kondapur')]);
    expect(calls).toHaveLength(3);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(55);
    expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(55);
    expect(calls[0].ua).toBe('AJPWER-Workforce/1.0 (it@ajpwer.in)');
    expect(calls[0].url).toContain('email=it%40ajpwer.in');

    const again = await geo.search('  gachibowli ');
    expect(again.cached).toBe(true);
    expect(again.results[0]).toEqual({ name: 'Gachibowli, Hyderabad, Telangana, India', lat: 17.44008, lng: 78.348917, type: 'suburb' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    clock += 24 * 3600_000 + 1;
    expect((await geo.search('Gachibowli')).cached).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('defaults to one call a second', async () => {
    const at = [];
    const geo = createGeoSearch({ fetchImpl: async () => (at.push(Date.now()), { ok: true, json: async () => [] }) });
    await Promise.all([geo.search('first place'), geo.search('second place')]);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(990);
  });

  it('refuses rather than queueing a long line, and turns an outage into a plain message', async () => {
    let clock = 0;
    const geo = createGeoSearch({ fetchImpl: async () => ({ ok: true, json: async () => [] }), now: () => clock, sleep: async () => undefined, maxWaitMs: 2000 });
    const results = await Promise.allSettled(['aaa', 'bbb', 'ccc', 'ddd', 'eee'].map((q) => geo.search(q)));
    expect(results.filter((r) => r.status === 'rejected').map((r) => r.reason.code)).toEqual(['RATE_LIMITED', 'RATE_LIMITED']);
    const down = createGeoSearch({ fetchImpl: async () => ({ ok: false, status: 503 }), sleep: async () => undefined });
    await expect(down.search('Gachibowli')).rejects.toMatchObject({ code: 'GEO_UNAVAILABLE' });
  });

  describe('GET /geo/search', () => {
    let fetchMock;
    beforeEach(() => {
      geoSearch.clear();
      fetchMock = vi.fn(async () => ({ ok: true, json: async () => nominatim }));
      vi.stubGlobal('fetch', fetchMock);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('proxies to Nominatim with our User-Agent, and a repeat is served from the cache', async () => {
      const r = await f.agent.get('/api/v1/geo/search').query({ q: 'Gachibowli Hyderabad' });
      expect(r.status).toBe(200);
      expect(r.body.data[0].lat).toBe(17.44008);
      expect(fetchMock.mock.calls[0][0]).toContain('nominatim');
      expect(fetchMock.mock.calls[0][1].headers['User-Agent']).toMatch(/^AJPWER-Workforce/);
      const again = await f.agent.get('/api/v1/geo/search').query({ q: 'gachibowli  hyderabad' });
      expect(again.body.meta.cached).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('needs HR, and at least three characters', async () => {
      expect((await request(app).get('/api/v1/geo/search').query({ q: 'Hyderabad' })).status).toBe(401);
      expect((await f.agent.get('/api/v1/geo/search').query({ q: 'ab' })).status).toBe(422);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
