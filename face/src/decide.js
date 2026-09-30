import { dot, matchGallery, normalise, toEmbedding } from './gallery.js';

/**
 * Decisions on one upload of two frames — [0] looking straight, [1] turned as the
 * challenge asked. Pure: the face service's analysis in, a decision out.
 *
 * Not a try (the person did nothing wrong, or the tablet should have caught it):
 *   no face, several faces, poor light/size/focus.
 * A try (counts towards the limit): not a live face, the head turn not seen, no match.
 */
export const FACE_DEFAULTS = {
  matchMin: 0.4, // SFace cosine; OpenCV suggests 0.363
  matchMargin: 0.05, // best person must beat the next person by this much
  liveMin: 0.7, // average of MiniFASNetV2 and V1SE "real", over both frames
  turnMinDeg: 15, // head turn between the two frames, in the asked direction
  samePersonMin: 0.3, // straight and turned frame must be the same face
  duplicateMin: 0.5, // registration: already this close to someone else → refused
  learnMin: 0.55, // a confirmed punch this sure (and live) adds a rolling template
  rollingMax: 5, // rolling templates kept per person (registered ones are never trimmed)
  minFacePx: 80,
  minBrightness: 40,
  maxBrightness: 230,
  minSharpness: 15,
  maxTries: 5,
  challengeSeconds: 60,
  confirmSeconds: 60,
};

/** +1 when the person should turn to their own left (yaw rises), −1 for right. */
export const turnSign = (direction) => (direction === 'LEFT' ? 1 : -1);

function frameProblem(f, cfg) {
  if (!f || f.faces === 0) return 'NO_FACE';
  if (f.faces > 1) return 'MULTIPLE_FACES';
  if (!f.embedding || !f.live) return 'NO_FACE';
  const q = f.quality ?? {};
  if (q.face_px !== undefined && q.face_px < cfg.minFacePx) return 'TOO_FAR';
  if (q.brightness !== undefined && q.brightness < cfg.minBrightness) return 'TOO_DARK';
  if (q.brightness !== undefined && q.brightness > cfg.maxBrightness) return 'TOO_BRIGHT';
  if (q.sharpness !== undefined && q.sharpness < cfg.minSharpness) return 'BLURRY';
  return null;
}

/** One straight frame (HR enrolment, where HR watches instead of a head turn): usable and live. */
export function checkSingleFrame(frame, config = {}) {
  const cfg = { ...FACE_DEFAULTS, ...config };
  const base = { yaw_front: frame?.yaw ?? null, live_score: null, embedding: null };
  const p = frameProblem(frame, cfg);
  if (p) return { ...base, outcome: p === 'MULTIPLE_FACES' || p === 'NO_FACE' ? p : 'POOR_QUALITY', code: p };
  const live = Math.round(frame.live.score * 10000) / 10000;
  if (live < cfg.liveMin) return { ...base, live_score: live, outcome: 'NOT_LIVE', code: 'NOT_LIVE' };
  return { ...base, live_score: live, outcome: 'OK', code: null, embedding: Array.from(frame.embedding) };
}

/** Common checks for punch and registration: both frames usable, live, and the turn seen. */
export function checkFrames(analysis, challenge, config = {}) {
  const cfg = { ...FACE_DEFAULTS, ...config };
  const [front, turn] = analysis?.frames ?? [];
  const base = { yaw_front: front?.yaw ?? null, yaw_turn: turn?.yaw ?? null, live_score: null, embedding: null };
  for (const f of [front, turn]) {
    const p = frameProblem(f, cfg);
    if (p) return { ...base, outcome: p === 'MULTIPLE_FACES' || p === 'NO_FACE' ? p : 'POOR_QUALITY', code: p, countsAsTry: false };
  }
  const live = (front.live.score + turn.live.score) / 2;
  const withLive = { ...base, live_score: Math.round(live * 10000) / 10000 };
  if (live < cfg.liveMin) return { ...withLive, outcome: 'NOT_LIVE', code: 'NOT_LIVE', countsAsTry: true };
  const turned = (turn.yaw - front.yaw) * turnSign(challenge.direction);
  const same = dot(normalise(toEmbedding(front.embedding)), normalise(toEmbedding(turn.embedding)));
  if (turned < cfg.turnMinDeg || same < cfg.samePersonMin) {
    return { ...withLive, outcome: 'CHALLENGE_FAILED', code: 'CHALLENGE_FAILED', countsAsTry: true, turned_deg: Math.round(turned * 10) / 10, same_person: same };
  }
  return { ...withLive, outcome: 'OK', code: null, countsAsTry: false, embedding: Array.from(front.embedding) };
}

/**
 * Who is this? IDENTIFIED only when the best person clears matchMin and beats the
 * next person by matchMargin; otherwise NO_MATCH, which counts as a try.
 */
export function decidePunch({ analysis, challenge, gallery, config = {} }) {
  const cfg = { ...FACE_DEFAULTS, ...config };
  const frames = checkFrames(analysis, challenge, cfg);
  if (frames.outcome !== 'OK') return { ...frames, employee_id: null, score: null, second_score: null };
  const { best, second } = matchGallery(gallery, frames.embedding);
  const score = best ? round4(best.score) : null;
  const second_score = second ? round4(second.score) : null;
  const clear = best && best.score >= cfg.matchMin && (!second || best.score - second.score >= cfg.matchMargin);
  if (!clear) return { ...frames, outcome: 'NO_MATCH', code: 'NO_MATCH', countsAsTry: true, employee_id: best?.employee_id ?? null, score, second_score };
  return { ...frames, outcome: 'IDENTIFIED', code: 'IDENTIFIED', countsAsTry: false, employee_id: best.employee_id, score, second_score };
}

/**
 * Registering a face: the same live and turn checks, and the face must not already
 * belong to someone else (DUPLICATE_FACE, refused). HR can override from the profile.
 */
export function decideRegistration({ analysis, challenge, gallery, employeeId, config = {} }) {
  const cfg = { ...FACE_DEFAULTS, ...config };
  const frames = checkFrames(analysis, challenge, cfg);
  if (frames.outcome !== 'OK') return { ...frames, duplicate_of: null, score: null };
  const { best } = matchGallery(gallery, frames.embedding, { exclude: employeeId });
  if (best && best.score >= cfg.duplicateMin) {
    return { ...frames, outcome: 'DUPLICATE_FACE', code: 'DUPLICATE_FACE', countsAsTry: false, duplicate_of: best.employee_id, score: round4(best.score) };
  }
  return { ...frames, outcome: 'REGISTERED', code: 'REGISTERED', countsAsTry: false, duplicate_of: null, score: best ? round4(best.score) : null };
}

/** An open IN closed within this window belongs to the same shift (matches the attendance engine). */
export const OPEN_SHIFT_MAX_MIN = 16 * 60;

/**
 * Would this punch duplicate one already made? `last` is the person's latest punch
 * ({ direction, site_id, site_name, punched_at: Date }) or null.
 *   REPEAT               any punch within repeatSeconds of the last one (a second scan by accident)
 *   ALREADY_IN_HERE      an IN while an IN at this site is still open
 *   ALREADY_IN_ELSEWHERE an IN while an IN at another site is still open (use Change site)
 */
export function checkDuplicate({ direction, siteId, last, now, repeatSeconds = 120, openShiftMaxMin = OPEN_SHIFT_MAX_MIN }) {
  if (!last) return null;
  const ageMs = now.getTime() - last.punched_at.getTime();
  if (ageMs <= repeatSeconds * 1000) return { code: 'REPEAT', at: last.punched_at };
  const open = last.direction === 'IN' && ageMs <= openShiftMaxMin * 60_000;
  if (direction === 'IN' && open) {
    return last.site_id === siteId ? { code: 'ALREADY_IN_HERE', at: last.punched_at } : { code: 'ALREADY_IN_ELSEWHERE', at: last.punched_at, site: last.site_name ?? null };
  }
  return null;
}

/** Should a confirmed punch teach the gallery a new rolling template? */
export function shouldLearn({ score, live_score }, config = {}) {
  const cfg = { ...FACE_DEFAULTS, ...config };
  return score !== null && score >= cfg.learnMin && live_score !== null && live_score >= cfg.liveMin;
}

/**
 * Rolling templates to delete so a person keeps at most `max`: the oldest go first.
 * Registered templates are never returned.
 */
export function rollingToDelete(templates, max = FACE_DEFAULTS.rollingMax) {
  const rolling = templates.filter((t) => t.kind === 'ROLLING').sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || String(b.id).localeCompare(String(a.id)));
  return rolling.slice(Math.max(0, max)).map((t) => t.id);
}

const round4 = (x) => Math.round(x * 10000) / 10000;
