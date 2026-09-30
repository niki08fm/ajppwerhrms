import { describe, expect, it, vi } from 'vitest';
import {
  buildGallery,
  checkDuplicate,
  checkSingleFrame,
  createFaceClient,
  createPunchSession,
  decidePunch,
  decideRegistration,
  embeddingToBytes,
  FaceServiceBadImage,
  FaceServiceBusy,
  FaceServiceUnavailable,
  matchGallery,
  messageFor,
  MODEL_VERSION,
  rollingToDelete,
  shouldLearn,
} from '@ajpwer/face';
import { computeDay, resolvePolicies } from '../../src/calculations/index.js';
import { ATTENDANCE } from './fixtures.js';

const unit = (...xs) => {
  const v = Array.from({ length: 128 }, (_, i) => xs[i] ?? 0);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const A = unit(1);
const B = unit(0, 1);
const mix = (a, b, t) => a.map((x, i) => Math.cos(t) * x + Math.sin(t) * b[i]);

const frame = (embedding, yaw = 0, live = 0.95, extra = {}) => ({ faces: 1, yaw, embedding, live: { score: live }, quality: { brightness: 120, sharpness: 200, face_px: 150 }, ...extra });
const scan = (emb, dir = 'LEFT', opts = {}) => ({ frames: [frame(emb, 0, opts.live), frame(opts.turnEmb ?? emb, opts.turn ?? (dir === 'LEFT' ? 25 : -25), opts.live)] });
const gallery = buildGallery([
  { employee_id: 'a', model_version: MODEL_VERSION, embedding: embeddingToBytes(A) },
  { employee_id: 'b', model_version: MODEL_VERSION, embedding: embeddingToBytes(B) },
  { employee_id: 'old', model_version: 'faceapi-v1', embedding: embeddingToBytes(unit(0, 0, 1)) },
]);

describe('Gallery', () => {
  it('ignores templates from other models and wrong sizes', () => {
    const g = buildGallery([...[{ employee_id: 'x', model_version: MODEL_VERSION, embedding: [1, 2, 3] }], { employee_id: 'a', model_version: MODEL_VERSION, embedding: A }]);
    expect(g.people).toBe(1);
    expect(gallery.people).toBe(2);
    expect(gallery.byEmployee.has('old')).toBe(false);
  });

  it('each person scores their best template; best and second are different people', () => {
    const g = buildGallery([
      { employee_id: 'a', model_version: MODEL_VERSION, embedding: A },
      { employee_id: 'a', model_version: MODEL_VERSION, embedding: unit(0, 0, 0, 1) },
      { employee_id: 'b', model_version: MODEL_VERSION, embedding: B },
    ]);
    const m = matchGallery(g, unit(0, 0, 0, 1));
    expect(m.best).toEqual({ employee_id: 'a', score: expect.closeTo(1, 5) });
    expect(m.second.employee_id).toBe('b');
    expect(matchGallery(g, A, { exclude: 'a' }).best.employee_id).toBe('b');
  });
});

describe('decidePunch', () => {
  const challenge = { direction: 'LEFT' };

  it('identifies a clear, live face that turned as asked', () => {
    const d = decidePunch({ analysis: scan(A), challenge, gallery });
    expect(d).toMatchObject({ outcome: 'IDENTIFIED', employee_id: 'a', countsAsTry: false });
    expect(d.score).toBeCloseTo(1, 3);
  });

  it('below the match minimum, or not clear of the next person, is NO_MATCH and a try', () => {
    expect(decidePunch({ analysis: scan(mix(A, unit(0, 0, 0, 0, 1), 1.3)), challenge, gallery })).toMatchObject({ outcome: 'NO_MATCH', countsAsTry: true });
    // Halfway between A and B: both ≈ 0.707, no margin.
    expect(decidePunch({ analysis: scan(mix(A, B, Math.PI / 4)), challenge, gallery })).toMatchObject({ outcome: 'NO_MATCH', countsAsTry: true });
    // Slightly nearer A than B, by more than the margin.
    expect(decidePunch({ analysis: scan(mix(A, B, 0.6)), challenge, gallery })).toMatchObject({ outcome: 'IDENTIFIED', employee_id: 'a' });
  });

  it('a photo (low live score) is NOT_LIVE, a try', () => {
    expect(decidePunch({ analysis: scan(A, 'LEFT', { live: 0.3 }), challenge, gallery })).toMatchObject({ outcome: 'NOT_LIVE', countsAsTry: true });
  });

  it('turning the wrong way, too little, or a different face in the turned frame is CHALLENGE_FAILED', () => {
    expect(decidePunch({ analysis: scan(A, 'RIGHT'), challenge, gallery }).outcome).toBe('CHALLENGE_FAILED');
    expect(decidePunch({ analysis: scan(A, 'LEFT', { turn: 8 }), challenge, gallery }).outcome).toBe('CHALLENGE_FAILED');
    expect(decidePunch({ analysis: scan(A, 'LEFT', { turnEmb: B }), challenge, gallery }).outcome).toBe('CHALLENGE_FAILED');
    expect(decidePunch({ analysis: scan(A, 'RIGHT'), challenge: { direction: 'RIGHT' }, gallery }).outcome).toBe('IDENTIFIED');
  });

  it('no face, two faces, and poor pictures are not tries', () => {
    const none = { frames: [{ faces: 0 }, frame(A, 25)] };
    const two = { frames: [frame(A), { faces: 2 }] };
    const dark = { frames: [frame(A, 0, 0.95, { quality: { brightness: 12, sharpness: 200, face_px: 150 } }), frame(A, 25)] };
    const small = { frames: [frame(A, 0, 0.95, { quality: { brightness: 120, sharpness: 200, face_px: 40 } }), frame(A, 25)] };
    expect(decidePunch({ analysis: none, challenge, gallery })).toMatchObject({ outcome: 'NO_FACE', countsAsTry: false });
    expect(decidePunch({ analysis: two, challenge, gallery })).toMatchObject({ outcome: 'MULTIPLE_FACES', countsAsTry: false });
    expect(decidePunch({ analysis: dark, challenge, gallery })).toMatchObject({ outcome: 'POOR_QUALITY', code: 'TOO_DARK', countsAsTry: false });
    expect(decidePunch({ analysis: small, challenge, gallery })).toMatchObject({ outcome: 'POOR_QUALITY', code: 'TOO_FAR' });
  });

  it('thresholds come from config', () => {
    expect(decidePunch({ analysis: scan(A, 'LEFT', { live: 0.6 }), challenge, gallery, config: { liveMin: 0.5 } }).outcome).toBe('IDENTIFIED');
  });
});

describe('decideRegistration and single-frame enrolment', () => {
  it('refuses a face already registered to someone else, but not the person themselves', () => {
    expect(decideRegistration({ analysis: scan(A), challenge: { direction: 'LEFT' }, gallery, employeeId: 'new' })).toMatchObject({ outcome: 'DUPLICATE_FACE', duplicate_of: 'a' });
    expect(decideRegistration({ analysis: scan(A), challenge: { direction: 'LEFT' }, gallery, employeeId: 'a' }).outcome).toBe('REGISTERED');
    expect(decideRegistration({ analysis: scan(unit(0, 0, 0, 0, 0, 1)), challenge: { direction: 'LEFT' }, gallery, employeeId: 'new' }).outcome).toBe('REGISTERED');
  });

  it('single frame: usable and live', () => {
    expect(checkSingleFrame(frame(A)).outcome).toBe('OK');
    expect(checkSingleFrame(frame(A, 0, 0.2)).outcome).toBe('NOT_LIVE');
    expect(checkSingleFrame({ faces: 0 }).outcome).toBe('NO_FACE');
  });
});

describe('checkDuplicate', () => {
  const now = new Date('2026-10-01T10:00:00Z');
  const ago = (min) => new Date(now.getTime() - min * 60_000);

  it('any punch within two minutes of the last is a repeat', () => {
    expect(checkDuplicate({ direction: 'OUT', siteId: 's1', now, last: { direction: 'IN', site_id: 's1', punched_at: ago(1) } }).code).toBe('REPEAT');
  });

  it('an IN while an IN is open is refused, here or elsewhere', () => {
    expect(checkDuplicate({ direction: 'IN', siteId: 's1', now, last: { direction: 'IN', site_id: 's1', punched_at: ago(60) } }).code).toBe('ALREADY_IN_HERE');
    expect(checkDuplicate({ direction: 'IN', siteId: 's1', now, last: { direction: 'IN', site_id: 's2', site_name: 'Beta', punched_at: ago(60) } })).toMatchObject({ code: 'ALREADY_IN_ELSEWHERE', site: 'Beta' });
  });

  it('an IN after an OUT, or after an IN left open past the shift window, is fine', () => {
    expect(checkDuplicate({ direction: 'IN', siteId: 's1', now, last: { direction: 'OUT', site_id: 's1', punched_at: ago(60) } })).toBeNull();
    expect(checkDuplicate({ direction: 'IN', siteId: 's1', now, last: { direction: 'IN', site_id: 's1', punched_at: ago(17 * 60) } })).toBeNull();
    expect(checkDuplicate({ direction: 'IN', siteId: 's1', now, last: null })).toBeNull();
  });
});

describe('Rolling templates', () => {
  it('keeps the newest rolling ones up to the limit and never touches registered ones', () => {
    const t = (id, kind, day) => ({ id, kind, created_at: new Date(`2026-10-${String(day).padStart(2, '0')}T00:00:00Z`) });
    const all = [t('r0', 'REGISTERED', 1), t('a', 'ROLLING', 2), t('b', 'ROLLING', 3), t('c', 'ROLLING', 4), t('d', 'ROLLING', 5)];
    expect(rollingToDelete(all, 2).sort()).toEqual(['a', 'b']);
    expect(rollingToDelete(all, 5)).toEqual([]);
    expect(rollingToDelete(all, 0).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('learns only from confident, live punches', () => {
    expect(shouldLearn({ score: 0.8, live_score: 0.9 })).toBe(true);
    expect(shouldLearn({ score: 0.45, live_score: 0.9 })).toBe(false);
    expect(shouldLearn({ score: 0.8, live_score: 0.5 })).toBe(false);
  });
});

describe('Punch session', () => {
  const clock = (start) => {
    let t = new Date(start).getTime();
    return { now: () => new Date(t), add: (s) => (t += s * 1000) };
  };

  it('counts tries, blocks at the limit, and "not me" is a try', () => {
    const c = clock('2026-10-01T10:00:00Z');
    let s = createPunchSession(null, { now: c.now, config: { maxTries: 3 } });
    expect(s.status).toBe('ACTIVE');
    s.recordTry('NO_MATCH');
    s.identify({ employee_id: 'a', score: 0.9, live_score: 0.9, direction: 'IN' });
    expect(s.status).toBe('IDENTIFIED');
    s = createPunchSession(s.state, { now: c.now, config: { maxTries: 3 } });
    expect(s.notMe()).toBe(false);
    expect(s.triesLeft).toBe(1);
    expect(s.recordTry('NOT_LIVE')).toBe(true);
    expect(s.status).toBe('BLOCKED');
    expect(() => s.identify({ employee_id: 'a' })).toThrow(/BLOCKED/);
  });

  it('the challenge and the confirmation expire', () => {
    const c = clock('2026-10-01T10:00:00Z');
    const s = createPunchSession(null, { now: c.now, random: () => 0.9 });
    expect(s.state.challenge.direction).toBe('RIGHT');
    c.add(59);
    expect(s.challengeExpired()).toBe(false);
    c.add(2);
    expect(s.challengeExpired()).toBe(true);
    s.renewChallenge();
    s.identify({ employee_id: 'a', score: 0.9, live_score: 0.9, direction: 'IN' });
    c.add(61);
    expect(s.confirmExpired()).toBe(true);
    s.cancelIdentification();
    expect(s.status).toBe('ACTIVE');
    expect(s.state.tries).toBe(0);
  });

  it('state is plain data: it survives being stored and read back', () => {
    const s = createPunchSession(null);
    const back = createPunchSession(JSON.parse(JSON.stringify(s.state)));
    expect(back.state).toEqual(s.state);
  });
});

describe('Face service client', () => {
  const json = (status, body) => ({ status, ok: status < 400, json: async () => body });

  it('sends the frames with the token and request id', async () => {
    const fetchImpl = vi.fn(async () => json(200, { frames: [] }));
    const c = createFaceClient({ url: 'http://127.0.0.1:8100/', token: 'secret', fetchImpl });
    await c.analyze([Buffer.from([1]), Buffer.from([2])], { requestId: 'req-12345678' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8100/analyze');
    expect(init.headers['X-Face-Token']).toBe('secret');
    expect(init.body.get('request_id')).toBe('req-12345678');
    expect(init.body.getAll('frames')).toHaveLength(2);
  });

  it('busy and timeouts are FaceServiceBusy; a refused connection is unavailable; a bad image is its own error', async () => {
    const busy = createFaceClient({ url: 'http://x', token: 't', fetchImpl: async () => json(503, { error: 'busy' }) });
    await expect(busy.analyze([Buffer.from([1])], { requestId: 'r-12345678' })).rejects.toBeInstanceOf(FaceServiceBusy);
    const slow = createFaceClient({ url: 'http://x', token: 't', fetchImpl: async () => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })) });
    await expect(slow.analyze([Buffer.from([1])], { requestId: 'r-12345678' })).rejects.toBeInstanceOf(FaceServiceBusy);
    const down = createFaceClient({ url: 'http://x', token: 't', fetchImpl: async () => Promise.reject(new TypeError('fetch failed')) });
    await expect(down.analyze([Buffer.from([1])], { requestId: 'r-12345678' })).rejects.toBeInstanceOf(FaceServiceUnavailable);
    const bad = createFaceClient({ url: 'http://x', token: 't', fetchImpl: async () => json(422, { error: 'bad_image', message: 'no' }) });
    await expect(bad.analyze([Buffer.from([1])], { requestId: 'r-12345678' })).rejects.toBeInstanceOf(FaceServiceBadImage);
  });
});

describe('Messages', () => {
  it('fills in names and times, in plain words', () => {
    expect(messageFor('PUNCHED_IN', { time: '08:04', name: 'Ravi' })).toBe('Punched in at 08:04. Have a good day, Ravi.');
    expect(messageFor('OFFLINE')).toBe('No network. Punch is not possible right now. Tell your site in-charge.');
    expect(messageFor('BLOCKED', { tries: 5 })).toMatch(/after 5 tries/);
  });
});

describe('Travel minutes in the day', () => {
  it('count as worked time and come out of the break between the two sites', () => {
    const at = (h, m) => Date.UTC(2026, 9, 1, h, m) - 330 * 60_000;
    const punches = [
      { id: '1', at: at(9, 0), direction: 'IN', site_id: 'a' },
      { id: '2', at: at(12, 0), direction: 'OUT', site_id: 'a' },
      { id: '3', at: at(12, 40), direction: 'IN', site_id: 'b' },
      { id: '4', at: at(17, 0), direction: 'OUT', site_id: 'b' },
    ];
    const base = { date: '2026-10-01', joined_on: '2025-01-01', last_day: null, is_holiday: false, is_weekly_off: false, leave: null, punches, policies: resolvePolicies([ATTENDANCE], '2026-10-01'), shift_start_min: 540 };
    const without = computeDay(base);
    const withTravel = computeDay({ ...base, travel_min: 40 });
    expect(without.worked_min).toBe(7 * 60 + 20);
    expect(without.break_min).toBe(40);
    expect(withTravel.worked_min).toBe(8 * 60);
    expect(withTravel.break_min).toBe(0);
    expect(withTravel.travel_min).toBe(40);
    expect(withTravel.flags).toContain('TRAVEL');
    // A day without punches has no travel, whatever is passed.
    expect(computeDay({ ...base, punches: [], travel_min: 40 }).worked_min).toBe(0);
  });
});
