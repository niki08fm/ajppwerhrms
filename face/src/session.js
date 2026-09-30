import { FACE_DEFAULTS } from './decide.js';

/**
 * One person's attempt at a tablet, as plain data the backend stores between
 * requests. Tries count only real failures (not live, turn not seen, no match,
 * "This is not me"); at maxTries the session is BLOCKED and the tablet shows the
 * employee ID / name form, which becomes a manual request for HR.
 *
 *   ACTIVE ──identify──▶ IDENTIFIED ──confirm──▶ DONE
 *     ▲  │                   │
 *     │  └─ failed try ──┐   └─ not me (a try)
 *     └──────────────────┴──▶ … at maxTries ──▶ BLOCKED ──manual request──▶ DONE
 */
export function createPunchSession(state, { config = {}, now = () => new Date(), random = Math.random } = {}) {
  const cfg = { ...FACE_DEFAULTS, ...config };
  const at = () => now();
  const iso = (d) => d.toISOString();
  const later = (s) => iso(new Date(at().getTime() + s * 1000));

  const newChallenge = () => ({ direction: random() < 0.5 ? 'LEFT' : 'RIGHT', expires_at: later(cfg.challengeSeconds) });

  const s = state
    ? structuredClone(state)
    : { status: 'ACTIVE', tries: 0, max_tries: cfg.maxTries, challenge: newChallenge(), identified: null, failures: [], created_at: iso(at()) };

  const api = {
    get state() {
      return structuredClone(s);
    },
    get status() {
      return s.status;
    },
    get triesLeft() {
      return Math.max(0, s.max_tries - s.tries);
    },
    challengeExpired() {
      return new Date(s.challenge.expires_at) <= at();
    },
    /** A fresh head-turn direction and clock, after any failure or expiry. */
    renewChallenge() {
      s.challenge = newChallenge();
      return s.challenge;
    },
    /** A real failure. Returns true when this try blocks the session. */
    recordTry(reason) {
      assertStatus(s, ['ACTIVE', 'IDENTIFIED']);
      s.tries += 1;
      s.failures.push({ reason, at: iso(at()) });
      s.identified = null;
      if (s.tries >= s.max_tries) {
        s.status = 'BLOCKED';
        return true;
      }
      s.status = 'ACTIVE';
      s.challenge = newChallenge();
      return false;
    },
    identify({ employee_id, score, live_score, direction }) {
      assertStatus(s, ['ACTIVE']);
      s.status = 'IDENTIFIED';
      s.identified = { employee_id, score, live_score, direction, expires_at: later(cfg.confirmSeconds) };
    },
    confirmExpired() {
      return !s.identified || new Date(s.identified.expires_at) <= at();
    },
    /** The confirmation ran out of time: scan again, without it counting as a try. */
    cancelIdentification() {
      assertStatus(s, ['IDENTIFIED']);
      s.status = 'ACTIVE';
      s.identified = null;
      s.challenge = newChallenge();
    },
    /** Keep server-only details with the identification (token hash, embedding, request id). */
    annotate(fields) {
      assertStatus(s, ['IDENTIFIED']);
      Object.assign(s.identified, fields);
    },
    /** "This is not me": a try, and the person scans again. */
    notMe() {
      assertStatus(s, ['IDENTIFIED']);
      return api.recordTry('NOT_ME');
    },
    finish(result) {
      s.status = 'DONE';
      s.result = result;
    },
  };
  return api;
}

function assertStatus(s, allowed) {
  if (!allowed.includes(s.status)) {
    const e = new Error(`Session is ${s.status}`);
    e.code = 'SESSION_STATE';
    e.status = s.status;
    throw e;
  }
}
