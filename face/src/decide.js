import { dot, matchGallery, normalise, toEmbedding } from './gallery.js';

/**
 * Decisions on one upload. A punch is three pictures of the person looking straight, a
 * moment apart; registration is four guided pictures. Pure: the face service's analysis in,
 * a decision out.
 *
 * Not a try (the person did nothing wrong, or the tablet should have caught it):
 *   no face, several faces, poor light/size/focus.
 * A try (counts towards the limit): not a live face, not one person, no match.
 */
export const FACE_DEFAULTS = {
  matchMin: 0.4, // SFace cosine; OpenCV suggests 0.363
  matchMargin: 0.05, // best person must beat the next person by this much
  liveMin: 0.5, // punch: the middle one of three pictures' MiniFASNetV2 and V1SE "real" scores
  registerLiveMin: 0.2, // guided registration: the best of the four pictures (the turns are the main proof)
  turnMinDeg: 15, // head turn between the two frames, in the asked direction
  samePersonMin: 0.3, // straight and turned frame must be the same face
  duplicateMin: 0.5, // registration: already this close to someone else → refused
  learnMin: 0.55, // a confirmed punch this sure (and live) adds a rolling template
  learnLiveMin: 0.7, // ...and only when clearly live: a borderline face must never teach the system
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

/**
 * Who is this? Three pictures of the person looking straight, a moment apart. All must be
 * usable and show one face; the person is judged live (not a photo or a screen) by the
 * middle of the three camera scores, which a single blurred picture cannot sway; and the three
 * face codes, averaged, must be one person. IDENTIFIED only when the best person clears
 * matchMin and beats the next person by matchMargin; otherwise NO_MATCH. Not live, not one
 * person and no match each count as a try.
 */
export function decidePunch({ analysis, gallery, config = {} }) {
  const cfg = { ...FACE_DEFAULTS, ...config };
  const frames = analysis?.frames ?? [];
  const base = { yaw_front: frames[0]?.yaw ?? null, yaw_turn: null, live_score: null, embedding: null, employee_id: null, score: null, second_score: null };
  if (frames.length < 2) return { ...base, outcome: 'NO_FACE', code: 'NO_FACE', countsAsTry: false };
  for (const f of frames) {
    const p = frameProblem(f, cfg);
    if (p) return { ...base, outcome: p === 'MULTIPLE_FACES' || p === 'NO_FACE' ? p : 'POOR_QUALITY', code: p, countsAsTry: false };
  }
  const scores = frames.map((f) => f.live.score).sort((x, y) => x - y);
  const live = scores[Math.floor(scores.length / 2)];
  const withLive = { ...base, live_score: round4(live) };
  if (live < cfg.liveMin) return { ...withLive, outcome: 'NOT_LIVE', code: 'NOT_LIVE', countsAsTry: true };
  const codes = frames.map((f) => normalise(toEmbedding(f.embedding)));
  if (codes.some((c) => dot(codes[0], c) < cfg.samePersonMin)) return { ...withLive, outcome: 'NOT_SAME_PERSON', code: 'NOT_SAME_PERSON', countsAsTry: true };
  const embedding = Array.from(normalise(codes[0].map((_, i) => codes.reduce((a, c) => a + c[i], 0) / codes.length)));
  const { best, second } = matchGallery(gallery, embedding);
  const score = best ? round4(best.score) : null;
  const second_score = second ? round4(second.score) : null;
  const clear = best && best.score >= cfg.matchMin && (!second || best.score - second.score >= cfg.matchMargin);
  const found = { ...withLive, embedding, score, second_score };
  if (!clear) return { ...found, outcome: 'NO_MATCH', code: 'NO_MATCH', countsAsTry: true, employee_id: best?.employee_id ?? null };
  return { ...found, outcome: 'IDENTIFIED', code: 'IDENTIFIED', countsAsTry: false, employee_id: best.employee_id };
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Guided registration from four pictures: straight, turned to the person's left, turned to
 * their right, and eyes closed. The proof of a live person is the turns — each measured
 * here, in its own direction, from the straight picture; a printed photo cannot turn. All
 * four must be one face and the same person. The camera's live-face score is a soft check:
 * only the best of the four must reach registerLiveMin, so a poor webcam does not refuse a
 * real person. The straight, left and right pictures become the person's face codes; the
 * closed-eyes picture only shows the eyes move.
 */
export function decideGuidedRegistration({ analysis, gallery, employeeId, config = {} }) {
  const cfg = { ...FACE_DEFAULTS, ...config };
  const [front, left, right, blink] = analysis?.frames ?? [];
  const yaws = { front: front?.yaw ?? null, left: left?.yaw ?? null, right: right?.yaw ?? null, blink: blink?.yaw ?? null };
  const base = { yaw_front: yaws.front, yaw_turn: null, yaws, live_score: null, embeddings: null, duplicate_of: null, score: null };
  for (const [step, f] of [
    ['front', front],
    ['left', left],
    ['right', right],
    ['blink', blink],
  ]) {
    const p = frameProblem(f, cfg);
    if (p) return { ...base, outcome: p === 'MULTIPLE_FACES' || p === 'NO_FACE' ? p : 'POOR_QUALITY', code: p, step, countsAsTry: false };
  }
  const scores = [front, left, right, blink].map((f) => f.live.score);
  const best = Math.max(...scores);
  const withLive = { ...base, live_score: round4(scores.reduce((a, b) => a + b, 0) / scores.length), live_best: round4(best) };
  if (best < cfg.registerLiveMin) return { ...withLive, outcome: 'NOT_LIVE', code: 'NOT_LIVE', countsAsTry: true };
  const turns = { left: round1((left.yaw - front.yaw) * turnSign('LEFT')), right: round1((right.yaw - front.yaw) * turnSign('RIGHT')) };
  if (turns.left < cfg.turnMinDeg) return { ...withLive, turns, outcome: 'CHALLENGE_FAILED', code: 'TURN_LEFT_NOT_SEEN', step: 'left', countsAsTry: true };
  if (turns.right < cfg.turnMinDeg) return { ...withLive, turns, outcome: 'CHALLENGE_FAILED', code: 'TURN_RIGHT_NOT_SEEN', step: 'right', countsAsTry: true };
  const f0 = normalise(toEmbedding(front.embedding));
  for (const [step, f] of [
    ['left', left],
    ['right', right],
    ['blink', blink],
  ]) {
    if (dot(f0, normalise(toEmbedding(f.embedding))) < cfg.samePersonMin) return { ...withLive, turns, outcome: 'CHALLENGE_FAILED', code: 'NOT_SAME_PERSON', step, countsAsTry: true };
  }
  const embeddings = [front, left, right].map((f) => Array.from(f.embedding));
  // Already someone else's face, from any of the three angles?
  let dup = null;
  for (const e of embeddings) {
    const { best: b } = matchGallery(gallery, e, { exclude: employeeId });
    if (b && b.score >= cfg.duplicateMin && (!dup || b.score > dup.score)) dup = b;
  }
  if (dup) return { ...withLive, turns, outcome: 'DUPLICATE_FACE', code: 'DUPLICATE_FACE', countsAsTry: false, duplicate_of: dup.employee_id, score: round4(dup.score) };
  return { ...withLive, turns, outcome: 'REGISTERED', code: 'REGISTERED', countsAsTry: false, embeddings };
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
  return score !== null && score >= cfg.learnMin && live_score !== null && live_score >= cfg.learnLiveMin;
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
