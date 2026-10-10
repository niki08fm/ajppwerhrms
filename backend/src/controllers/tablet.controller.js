import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import {
  punchChangeSiteSchema,
  punchConfirmSchema,
  punchFramesSchema,
  punchManualSchema,
  punchNotMeSchema,
  punchSessionStartSchema,
} from '@ajpwer/shared';
import {
  checkDuplicate,
  buildGallery,
  createPunchSession,
  decideGuidedRegistration,
  decidePunch,
  FaceServiceBadImage,
  FaceServiceBusy,
  FaceServiceUnavailable,
  embeddingToBytes,
  hasTemplate,
  messageFor,
} from '@ajpwer/face';
import { assignWorkDate, inferDirection, OVERNIGHT_MAX_GAP_MIN } from '../calculations/index.js';
import { audit } from '../utils/audit.js';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { env } from '../config/env.js';
import { AppError, notFound } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { checkGeofence } from '../utils/geo.js';
import { prisma } from '../config/db.js';
import { faceClient, faceConfig, hasCurrentTemplate, invalidateFaceCache, MODEL_VERSION, learnFromPunch, loadGallery, saveCrop, snapshotDir } from '../services/face.service.js';
import { attendanceFrozen } from '../services/attendance.service.js';
import { bumpAggregate } from '../services/aggregates.service.js';
import { currentSitePeople } from '../services/site-workspace.service.js';
import { liveAuthorizationWhere, lockRegistrationEmployee, requireRegistrationActive, requireRegistrationPermission } from '../services/face-registration.service.js';

/**
 * Tablet punches, face v2 (face/INTEGRATION.md §3). The browser only guides and
 * captures; the backend owns every decision: tries, the head-turn challenge,
 * who it is, the confirm token, the punch, face exceptions and the attempt log.
 */

const siteActor = (req) => `site:${req.site.code}`;
const hash = (t) => createHash('sha256').update(t).digest('hex');
const hhmm = (d) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(11, 16);
const MAX_CROPS = 5;

/** Re-check the geofence on every call — a tablet signed in inside the fence and carried outside must stop working. */
async function fence(req, pos) {
  const site = req.site;
  const check = checkGeofence(site, pos, env.GPS_MAX_ACCURACY_M, 'Punch');
  if (!check.ok) {
    await audit(prisma, {
      actor: siteActor(req),
      ip: req.ip ?? null,
      action: 'geofence.rejected',
      entity_type: 'site',
      entity_id: site.id,
      detail: { stage: 'punch', check: check.code, distance_m: check.distance_m, accuracy_m: pos.accuracy_m, radius_m: site.radius_m },
    });
    throw new AppError('GEOFENCE_REJECTED', check.reason, 403, check.code);
  }
  return check;
}

async function lastPunch(employeeId, db = prisma) {
  return db.punch.findFirst({ where: { employee_id: employeeId }, orderBy: { punched_at: 'desc' }, include: { site: { select: { id: true, name: true } } } });
}

/** The direction the next punch takes: OUT while an IN from the same shift is open, IN otherwise. */
function nextDirection(last, now) {
  const recent = last && now.getTime() - last.punched_at.getTime() <= OVERNIGHT_MAX_GAP_MIN * 60_000 ? last : null;
  return inferDirection(recent);
}

/** A destination tablet cannot close another site's open shift as if it were an OUT here. */
function requireSourcePunchOut(last, siteId, now) {
  if (last?.direction === 'IN' && last.site_id !== siteId && now.getTime() - last.punched_at.getTime() <= OVERNIGHT_MAX_GAP_MIN * 60_000) {
    throw new AppError('CROSS_SITE_OPEN_SHIFT', `Still punched in at ${last.site?.name ?? 'the previous site'}. Punch out there before punching in here.`, 409);
  }
}

function duplicateOf(direction, last, siteId, now) {
  const dup = checkDuplicate({ direction, siteId, now, last: last ? { direction: last.direction, site_id: last.site_id, site_name: last.site?.name, punched_at: last.punched_at } : null });
  if (!dup) return null;
  return { code: dup.code, message: messageFor(dup.code, { time: hhmm(dup.at), site: dup.site }) };
}

async function loadSession(req) {
  const row = await prisma.punchSession.findUnique({ where: { id: req.params.id } });
  if (!row || row.site_id !== req.site.id) throw notFound('That punch session');
  return row;
}

/** A registration has four steps and a look at the photos, so its window is longer than a punch's. */
const sessionConfig = (purpose) => (purpose === 'REGISTER' ? { ...faceConfig(), challengeSeconds: env.FACE_REGISTER_SECONDS } : faceConfig());
const sessionOf = (row) => createPunchSession(row.state, { config: sessionConfig(row.purpose) });

function sessionReply(s, extra = {}) {
  const st = s.state;
  return {
    status: st.status,
    tries_left: s.triesLeft,
    challenge: st.status === 'ACTIVE' ? st.challenge : null,
    ...extra,
  };
}

async function saveSession(db, id, s, data = {}) {
  const st = s.state;
  return db.punchSession.update({
    where: { id },
    data: { state: st, status: st.status, tries: st.tries, ...(st.status === 'DONE' ? { closed_at: new Date() } : {}), ...data },
  });
}

function checkToken(s, token) {
  const id = s.state.identified;
  if (s.status !== 'IDENTIFIED' || !id || id.token_hash !== hash(token)) throw new AppError('CONFLICT', 'This confirmation is no longer valid. Scan again.', 409);
}

/** Crops of failed tries are only for a manual request: once a session ends any other way, they go. */
function dropCrops(keys) {
  for (const k of keys ?? []) {
    try {
      unlinkSync(path.join(snapshotDir, path.basename(k)));
    } catch {
      // already gone
    }
  }
}

const attemptNumbers = (d) => ({
  employee_id: d.employee_id ?? null,
  score: d.score ?? null,
  second_score: d.second_score ?? null,
  live_score: d.live_score ?? null,
  yaw_front: d.yaw_front ?? null,
  yaw_turn: d.yaw_turn ?? null,
});

/** Other active sites, for a separate transfer request. Names only. */
export const listOtherSites = asyncHandler(async (req, res) => {
  const sites = await prisma.site.findMany({ where: { deleted_at: null, is_active: true, id: { not: req.site.id } }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  res.json({ data: sites });
});

// ─── Sessions ────────────────────────────────────────────────────────────────

async function findEmployeeByCode(code, purpose = 'PUNCH') {
  return prisma.employee.findFirst({
    where: { code: { equals: code.trim(), mode: 'insensitive' }, deleted_at: null, status: purpose === 'REGISTER' ? 'ACTIVE' : { in: ['ACTIVE', 'NOTICE'] } },
    select: { id: true, code: true, name: true, designation: true },
  });
}

/**
 * People to pick from on the tablet, by what was typed (name or ID). Only name, ID and
 * designation leave the server, two typed characters are needed, and eight people at most.
 * `for=register` includes first registrations and employees with a live one-time HR approval.
 */
export const searchEmployees = asyncHandler(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.json({ data: [] });
  if (req.query.for === 'transfer') {
    const words = q.toLowerCase().split(/\s+/);
    const people = (await currentSitePeople(prisma, req.site.id))
      .filter((p) => words.every((w) => `${p.name} ${p.code}`.toLowerCase().includes(w)))
      .slice(0, 8).map(({ code, name, designation }) => ({ code, name, designation }));
    return res.json({ data: people });
  }
  const people = await prisma.employee.findMany({
    where: {
      deleted_at: null,
      status: req.query.for === 'register' ? 'ACTIVE' : { in: ['ACTIVE', 'NOTICE'] },
      AND: [
        { OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }] },
        ...(req.query.for === 'register' ? [{ OR: [
          { faces: { none: { deleted_at: null, model_version: MODEL_VERSION } } },
          { face_registration_authorizations: { some: liveAuthorizationWhere() } },
        ] }] : []),
      ],
    },
    select: { code: true, name: true, designation: true,
      ...(req.query.for === 'register' ? { faces: { where: { deleted_at: null, model_version: MODEL_VERSION }, select: { id: true }, take: 1 } } : {}) },
    orderBy: { name: 'asc' },
    take: 8,
  });
  res.json({ data: people.map(({ faces, ...person }) => ({ ...person, ...(req.query.for === 'register' ? { allow_reregistration: faces.length > 0 } : {}) })) });
});

/** The typed name matches when every word typed appears in the person's name. */
function nameMatches(typed, actual) {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  const name = actual.toLowerCase();
  return words.length > 0 && words.every((w) => name.includes(w));
}

/** Start a punch (or a face registration): a head-turn challenge and a fresh count of tries. */
export const startSession = asyncHandler(async (req, res) => {
  const b = punchSessionStartSchema.parse(req.body);
  await fence(req, b);
  let employee = null;
  if (b.purpose === 'REGISTER') {
    employee = await findEmployeeByCode(b.employee_code, 'REGISTER');
    if (!employee || !nameMatches(b.name, employee.name)) throw new AppError('UNKNOWN_EMPLOYEE', messageFor('UNKNOWN_EMPLOYEE'), 422, 'employee_code');
  }
  const s = createPunchSession(null, { config: sessionConfig(b.purpose) });
  const row = await prisma.$transaction(async (tx) => {
    let authorizationId = null;
    if (employee) {
      const active = await lockRegistrationEmployee(tx, employee.id);
      requireRegistrationActive(active);
      if (await hasCurrentTemplate(employee.id, tx)) {
        const grant = await tx.faceRegistrationAuthorization.findFirst({ where: { employee_id: employee.id, ...liveAuthorizationWhere() } });
        if (!grant) throw new AppError('ALREADY_REGISTERED', messageFor('ALREADY_REGISTERED'), 409, 'employee_code');
        authorizationId = grant.id;
      }
    }
    return tx.punchSession.create({ data: { site_id: req.site.id, purpose: b.purpose, employee_id: employee?.id ?? null,
      face_registration_authorization_id: authorizationId, state: s.state, status: s.status, tries: 0 } });
  });
  res.status(201).json({
    data: { session_id: row.id, purpose: b.purpose, re_registration: !!row.face_registration_authorization_id,
      employee: employee ? { name: employee.name, code: employee.code } : null, ...sessionReply(s) },
  });
});

/**
 * One upload: the straight frame and the turned frame. The same request_id always
 * gets the same reply (so a retry never counts twice or punches twice). "Busy" is
 * not a try: the tablet sends the same upload again.
 */
export const uploadFrames = asyncHandler(async (req, res) => {
  const b = punchFramesSchema.parse(req.body);
  const file = (name) => req.files?.[name]?.[0];
  const row = await loadSession(req);
  // A punch: three pictures looking straight. A registration: straight, left, right and eyes closed.
  const names = row.purpose === 'REGISTER' ? ['front', 'left', 'right', 'blink'] : ['front', 'front2', 'front3'];
  const pictures = names.map(file);
  if (pictures.some((f) => !f)) throw new AppError('VALIDATION', row.purpose === 'REGISTER' ? 'Send four pictures: front, left, right and blink.' : 'Send three pictures: front, front2 and front3.', 422);
  const prior = await prisma.punchAttempt.findUnique({ where: { session_id_request_id: { session_id: row.id, request_id: b.request_id } } });
  if (prior) {
    res.setHeader('Idempotent-Replay', 'true');
    // The tablet lost the reply to an identification: same answer, with a fresh confirm token.
    const again = sessionOf(row);
    if (prior.outcome === 'IDENTIFIED' && again.status === 'IDENTIFIED' && again.state.identified.request_id === b.request_id && !again.confirmExpired()) {
      const token = randomBytes(24).toString('hex');
      again.annotate({ token_hash: hash(token) });
      await saveSession(prisma, row.id, again);
      return res.json({ data: { ...prior.reply, confirm_token: token } });
    }
    return res.json({ data: prior.reply });
  }
  if (row.purpose === 'REGISTER') {
    try {
      await requireRegistrationPermission(prisma, row.employee_id, row.face_registration_authorization_id);
    } catch (error) {
      // Another identical upload can commit between the first replay lookup and
      // this permission check. Return its atomic reply instead of a USED error.
      const replay = await prisma.punchAttempt.findUnique({ where: { session_id_request_id: { session_id: row.id, request_id: b.request_id } } });
      if (!replay) throw error;
      res.setHeader('Idempotent-Replay', 'true');
      return res.json({ data: replay.reply });
    }
  }
  const check = await fence(req, b);
  const s = sessionOf(row);
  const logAttempt = (data) =>
    prisma.punchAttempt.create({
      data: { session_id: row.id, site_id: row.site_id, purpose: row.purpose, challenge: s.state.challenge?.direction ?? null, tries_after: s.state.tries, created_at: new Date(), ...data },
    });
  if (s.status !== 'ACTIVE') {
    return res.status(409).json({ error: { code: 'SESSION_STATE', message: 'This scan has finished. Start again.', field: null }, data: sessionReply(s) });
  }
  if (s.challengeExpired()) {
    if (row.purpose === 'REGISTER') {
      const reply = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM punch_session WHERE id = ${row.id}::uuid FOR UPDATE`;
        const prior = await tx.punchAttempt.findUnique({ where: { session_id_request_id: { session_id: row.id, request_id: b.request_id } } });
        if (prior) return prior.reply;
        const fresh = await tx.punchSession.findUnique({ where: { id: row.id } });
        if (fresh.status !== 'ACTIVE') throw new AppError('SESSION_STATE', 'This scan has finished. Start again.', 409);
        const current = sessionOf(fresh);
        current.renewChallenge();
        await saveSession(tx, row.id, current);
        const reply = sessionReply(current, { outcome: 'EXPIRED', code: 'CHALLENGE_EXPIRED', message: messageFor('CHALLENGE_EXPIRED') });
        await tx.punchAttempt.create({ data: { session_id: row.id, site_id: row.site_id, purpose: row.purpose,
          request_id: b.request_id, outcome: 'EXPIRED', code: 'CHALLENGE_EXPIRED', tries_after: current.state.tries, reply } });
        return reply;
      });
      return res.json({ data: reply });
    }
    s.renewChallenge();
    await saveSession(prisma, row.id, s);
    const reply = sessionReply(s, { outcome: 'EXPIRED', code: 'CHALLENGE_EXPIRED', message: messageFor('CHALLENGE_EXPIRED') });
    await logAttempt({ request_id: b.request_id, outcome: 'EXPIRED', code: 'CHALLENGE_EXPIRED', reply });
    return res.json({ data: reply });
  }

  const capturedAt = new Date().toISOString();
  let analysis;
  try {
    // The face service takes up to three pictures per request: a registration's four go as two pairs, in order.
    const size = row.purpose === 'REGISTER' ? 2 : 3;
    const parts = [];
    for (let i = 0; i < pictures.length; i += size) parts.push(await faceClient().analyze(pictures.slice(i, i + size).map((f) => f.buffer), { requestId: size === 3 ? b.request_id : `${b.request_id}:${i / size}` }));
    analysis = { model_version: parts[0].model_version, frames: parts.flatMap((x) => x.frames), ms: parts.reduce((a, x) => a + (x.ms ?? 0), 0) };
  } catch (e) {
    // Never a try. Logged under its own id so the retry with the same request_id is analysed afresh.
    const busy = e instanceof FaceServiceBusy;
    const bad = e instanceof FaceServiceBadImage;
    if (!busy && !bad && !(e instanceof FaceServiceUnavailable)) throw e;
    const code = busy ? 'BUSY' : bad ? 'NO_FACE' : 'SERVICE_DOWN';
    const reply = sessionReply(s, { outcome: busy ? 'BUSY' : bad ? 'NO_FACE' : 'SERVICE_DOWN', code, message: messageFor(code), retry_same_request: busy });
    await logAttempt({ request_id: `${b.request_id}:${code.toLowerCase()}:${randomUUID()}`, outcome: reply.outcome, code, reply });
    if (busy) return res.status(503).json({ error: { code: 'FACE_BUSY', message: reply.message, field: null }, data: reply });
    if (bad) return res.json({ data: reply });
    return res.status(503).json({ error: { code: 'FACE_UNAVAILABLE', message: reply.message, field: null }, data: reply });
  }

  const cfg = faceConfig();
  const gallery = await loadGallery();
  const frontFrame = analysis.frames?.[0];
  const quality = Object.fromEntries(names.map((n, i) => [n, analysis.frames?.[i]?.quality ?? null]));
  const common = { request_id: b.request_id, quality, service_ms: analysis.ms ?? null };

  // ── Registering a face ────────────────────────────────────────────────────
  if (row.purpose === 'REGISTER') {
    const d = decideGuidedRegistration({ analysis, gallery, employeeId: row.employee_id, config: cfg });
    // How the head moved and how the camera scored, kept with the attempt for HR.
    common.quality = { ...quality, yaws: d.yaws, turns: d.turns ?? null, live_best: d.live_best ?? null };
    if (d.outcome === 'REGISTERED') {
      const result = await prisma.$transaction(async (tx) => {
        const employee = await lockRegistrationEmployee(tx, row.employee_id);
        // Different employees must not register the same face concurrently. Employee
        // locks alone cannot serialize the shared gallery check.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(190511, 1)`;
        await tx.$queryRaw`SELECT id FROM punch_session WHERE id = ${row.id}::uuid FOR UPDATE`;
        const replay = await tx.punchAttempt.findUnique({ where: { session_id_request_id: { session_id: row.id, request_id: b.request_id } } });
        if (replay) return { reply: replay.reply, replayed: true };
        const freshSession = await tx.punchSession.findUnique({ where: { id: row.id } });
        if (freshSession.status !== 'ACTIVE') throw new AppError('SESSION_STATE', 'This scan has finished. Start again.', 409);
        const current = sessionOf(freshSession);
        await requireRegistrationPermission(tx, employee.id, row.face_registration_authorization_id);
        const freshRows = await tx.employeeFace.findMany({
          where: { deleted_at: null, model_version: MODEL_VERSION, employee: { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE'] } } },
          select: { employee_id: true, embedding: true, model_version: true },
        });
        const checked = decideGuidedRegistration({ analysis, gallery: buildGallery(freshRows), employeeId: employee.id, config: cfg });
        if (checked.outcome === 'DUPLICATE_FACE') {
          current.finish({ refused: 'DUPLICATE_FACE' });
          await saveSession(tx, row.id, current);
          await audit(tx, { actor: siteActor(req), ip: req.ip ?? null, action: 'face.register_refused', entity_type: 'employee', entity_id: employee.id,
            detail: { reason: 'DUPLICATE_FACE', resembles: checked.duplicate_of, score: checked.score, authorization_id: row.face_registration_authorization_id } });
          const refused = sessionReply(current, { outcome: 'DUPLICATE_FACE', code: 'DUPLICATE_FACE', message: messageFor('DUPLICATE_FACE') });
          await tx.punchAttempt.create({ data: { session_id: row.id, site_id: row.site_id, purpose: row.purpose, challenge: current.state.challenge?.direction ?? null,
            ...common, outcome: checked.outcome, code: checked.code, counts_as_try: false, tries_after: current.state.tries,
            ...attemptNumbers({ ...checked, employee_id: checked.duplicate_of }), reply: refused } });
          return { reply: refused, replayed: false };
        }
        // This is the first write to the existing templates: every failure before
        // this point leaves them usable and the approval available for another scan.
        if (row.face_registration_authorization_id) {
          await tx.employeeFace.updateMany({ where: { employee_id: employee.id, deleted_at: null }, data: { deleted_at: new Date(), embedding: Buffer.alloc(0) } });
        }
        for (const embedding of checked.embeddings) {
          await tx.employeeFace.create({ data: { employee_id: employee.id, embedding: embeddingToBytes(embedding), model_version: MODEL_VERSION,
            kind: 'REGISTERED', site_id: row.site_id, live_score: checked.live_score, consent_at: new Date() } });
        }
        if (row.face_registration_authorization_id) {
          await tx.faceRegistrationAuthorization.update({ where: { id: row.face_registration_authorization_id }, data: { status: 'USED', used_at: new Date(), used_site_id: row.site_id } });
        }
        current.finish({ registered: true });
        await saveSession(tx, row.id, current);
        await audit(tx, {
          actor: siteActor(req), ip: req.ip ?? null, action: row.face_registration_authorization_id ? 'face.reregister' : 'face.register',
          entity_type: 'employee', entity_id: employee.id,
          detail: { site_id: row.site_id, via: 'tablet', authorization_id: row.face_registration_authorization_id,
            pictures: 4, templates: checked.embeddings.length, turns: checked.turns, live_score: checked.live_score, live_best: checked.live_best },
        });
        const success = sessionReply(current, { outcome: 'REGISTERED', code: 'REGISTERED', re_registration: !!row.face_registration_authorization_id,
          message: messageFor('REGISTERED', { name: employee.name }) });
        // Template replacement, one-time consumption, session and idempotent reply
        // commit together so a lost HTTP response cannot force another registration.
        await tx.punchAttempt.create({ data: { session_id: row.id, site_id: row.site_id, purpose: row.purpose, challenge: current.state.challenge?.direction ?? null,
          ...common, outcome: checked.outcome, code: checked.code, counts_as_try: false, tries_after: current.state.tries,
          ...attemptNumbers({ ...checked, employee_id: employee.id }), reply: success } });
        return { reply: success, replayed: false };
      });
      invalidateFaceCache();
      if (result.replayed) res.setHeader('Idempotent-Replay', 'true');
      return res.json({ data: result.reply });
    }
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM punch_session WHERE id = ${row.id}::uuid FOR UPDATE`;
      const prior = await tx.punchAttempt.findUnique({ where: { session_id_request_id: { session_id: row.id, request_id: b.request_id } } });
      if (prior) return { reply: prior.reply, replayed: true };
      const fresh = await tx.punchSession.findUnique({ where: { id: row.id } });
      if (fresh.status !== 'ACTIVE') throw new AppError('SESSION_STATE', 'This scan has finished. Start again.', 409);
      const current = sessionOf(fresh);
      let reply;
      if (d.outcome === 'DUPLICATE_FACE') {
        current.finish({ refused: 'DUPLICATE_FACE' });
        await audit(tx, { actor: siteActor(req), ip: req.ip ?? null, action: 'face.register_refused', entity_type: 'employee', entity_id: row.employee_id,
          detail: { reason: 'DUPLICATE_FACE', resembles: d.duplicate_of, score: d.score, authorization_id: row.face_registration_authorization_id } });
        reply = sessionReply(current, { outcome: 'DUPLICATE_FACE', code: 'DUPLICATE_FACE', message: messageFor('DUPLICATE_FACE') });
      } else {
        if (d.countsAsTry) current.recordTry(d.outcome);
        else current.renewChallenge();
        reply = sessionReply(current, { outcome: d.outcome, code: d.code,
          message: current.status === 'BLOCKED' ? 'Registration could not be completed. Start again or ask HR for help.' : messageFor(d.code, { tries: current.state.tries }) });
      }
      await saveSession(tx, row.id, current);
      await tx.punchAttempt.create({ data: { session_id: row.id, site_id: row.site_id, purpose: row.purpose, challenge: current.state.challenge?.direction ?? null,
        ...common, outcome: d.outcome, code: d.code, counts_as_try: d.countsAsTry, tries_after: current.state.tries,
        ...attemptNumbers({ ...d, employee_id: d.duplicate_of ?? row.employee_id }), reply } });
      return { reply, replayed: false };
    });
    if (result.replayed) res.setHeader('Idempotent-Replay', 'true');
    return res.json({ data: result.reply });
  }

  // ── Punching ─────────────────────────────────────────────────────────────
  const d = decidePunch({ analysis, gallery, config: cfg });
  let reply;
  if (d.outcome === 'IDENTIFIED') {
    const now = new Date();
    const last = await lastPunch(d.employee_id);
    requireSourcePunchOut(last, row.site_id, now);
    const direction = nextDirection(last, now);
    const dup = duplicateOf(direction, last, row.site_id, now);
    const e = await prisma.employee.findFirst({ where: { id: d.employee_id, deleted_at: null, status: { in: ['ACTIVE', 'NOTICE'] } }, select: { id: true, name: true, code: true, designation: true } });
    if (!e) throw new AppError('EMPLOYEE_NOT_ACTIVE', 'This employee is not active for attendance. Ask HR to check their status.', 409);
    if (dup) {
      s.finish({ duplicate: dup.code });
      await saveSession(prisma, row.id, s, { employee_id: e.id });
      dropCrops(row.crop_keys);
      reply = sessionReply(s, { outcome: 'DUPLICATE', code: dup.code, message: dup.message, employee: { name: e.name, code: e.code } });
    } else {
      const token = randomBytes(24).toString('hex');
      s.identify({ employee_id: e.id, score: d.score, live_score: d.live_score, direction });
      // Kept server-side only: the embedding (to learn from on confirm) and the token's hash.
      s.annotate({ token_hash: hash(token), embedding: d.embedding, request_id: b.request_id, captured_at: capturedAt });
      await saveSession(prisma, row.id, s, { employee_id: e.id });
      const st = s.state;
      reply = {
        ...sessionReply(s),
        outcome: 'IDENTIFIED',
        code: 'IDENTIFIED',
        message: messageFor('IDENTIFIED'),
        employee: { name: e.name, code: e.code, designation: e.designation },
        direction,
        confirm_token: token,
        confirm_expires_at: st.identified.expires_at,
        can_change_site: direction === 'OUT',
        note: null,
        distance_m: check.distance_m,
      };
    }
  } else {
    let cropKey = null;
    if (d.countsAsTry) {
      if ((row.crop_keys?.length ?? 0) < MAX_CROPS) cropKey = saveCrop(frontFrame?.crop_jpeg);
      s.recordTry(d.outcome);
    } else s.renewChallenge();
    const notRegistered = d.outcome === 'NO_MATCH' && gallery.people === 0;
    await saveSession(prisma, row.id, s, cropKey ? { crop_keys: { push: cropKey } } : {});
    const code = s.status === 'BLOCKED' ? 'BLOCKED' : notRegistered ? 'NOT_REGISTERED' : d.code;
    reply = sessionReply(s, { outcome: d.outcome, code: d.code, message: messageFor(code, { tries: s.state.tries }) });
  }
  // The tablet never learns who the best (unconfirmed) match was; the log keeps it for tuning.
  await logAttempt({ ...common, outcome: d.outcome, code: d.code, counts_as_try: d.countsAsTry, tries_after: s.state.tries, ...attemptNumbers(d), reply: { ...reply, confirm_token: undefined } });
  res.json({ data: reply });
});

/** Write the punch the person confirmed. Idempotent: confirming twice returns the same punch. */
async function writePunch(tx, { row, s, siteId, direction, distance_m, deviceId }) {
  const id = s.state.identified;
  await tx.$queryRaw`SELECT id FROM employee WHERE id = ${id.employee_id}::uuid FOR UPDATE`;
  const active = await tx.employee.findFirst({ where: { id: id.employee_id, deleted_at: null, status: { in: ['ACTIVE', 'NOTICE'] } }, select: { id: true } });
  if (!active) throw new AppError('EMPLOYEE_NOT_ACTIVE', 'This employee is not active for attendance. Ask HR to check their status.', 409);
  const now = new Date();
  const last = await lastPunch(id.employee_id, tx);
  requireSourcePunchOut(last, siteId, now);
  const dup = duplicateOf(direction, last, siteId, now);
  if (dup) throw new AppError('DUPLICATE_PUNCH', dup.message, 409);
  const work_date = assignWorkDate(now, direction, last ? { direction: last.direction, work_date: fromDbDate(last.work_date), at: last.punched_at.getTime() } : null);
  const flags = [];
  const frozen = await attendanceFrozen(tx, work_date.slice(0, 7));
  if (frozen.frozen) flags.push('Arrived after the month was submitted for payroll');
  const p = await tx.punch.create({
    data: {
      employee_id: id.employee_id,
      site_id: siteId,
      direction,
      punched_at: now,
      client_punched_at: now,
      work_date: toDbDate(work_date),
      method: 'FACE',
      match_score: id.score,
      distance_m,
      device_id: deviceId,
      session_id: row.id,
      flagged: flags.length > 0,
      flag_reason: flags.join('; ') || null,
    },
  });
  // An outstanding identification can still confirm attendance after HR-authorized
  // replacement, but must never teach the gallery the face code it just retired.
  const latestReplacement = await tx.faceRegistrationAuthorization.findFirst({ where: { employee_id: id.employee_id, status: 'USED' }, orderBy: { used_at: 'desc' }, select: { used_at: true } });
  const captureTime = new Date(id.captured_at ?? row.state.created_at ?? row.created_at);
  const staleCapture = latestReplacement && latestReplacement.used_at.getTime() >= captureTime.getTime();
  const learned = staleCapture ? { learned: false, trimmed: 0 } : await learnFromPunch(tx, { employeeId: id.employee_id, embedding: id.embedding, score: id.score, liveScore: id.live_score, siteId });
  await tx.punchAttempt.updateMany({ where: { session_id: row.id, request_id: id.request_id }, data: { resolution: 'CONFIRMED' } });
  return { punch: p, work_date, learned };
}

/** Arriving at a named site the same day counts the travel; any other pending change for the person no longer can. */
async function settleSiteChanges(tx, punch, work_date) {
  const pending = await tx.siteChange.findMany({ where: { employee_id: punch.employee_id, status: 'PENDING' } });
  for (const c of pending) {
    const sameDay = fromDbDate(c.work_date) === work_date;
    if (punch.direction === 'IN' && sameDay && c.to_site_id === punch.site_id) {
      const minutes = Math.max(0, Math.floor((punch.punched_at.getTime() - c.left_at.getTime()) / 60_000));
      await tx.siteChange.update({ where: { id: c.id }, data: { status: 'COUNTED', in_punch_id: punch.id, arrived_at: punch.punched_at, travel_min: Math.min(minutes, env.FACE_TRAVEL_MAX_MIN) } });
    } else if (punch.direction === 'IN') {
      await tx.siteChange.update({ where: { id: c.id }, data: { status: 'NOT_COUNTED', in_punch_id: punch.id, arrived_at: punch.punched_at } });
    }
  }
}

export const confirmPunch = asyncHandler(async (req, res) => {
  const b = punchConfirmSchema.parse(req.body);
  const row = await loadSession(req);
  if (row.punch_id) return res.json({ data: await punchReply(row.punch_id, true) });
  const check = await fence(req, b);
  const s = sessionOf(row);
  checkToken(s, b.confirm_token);
  if (s.confirmExpired()) {
    const requestId = s.state.identified.request_id;
    s.cancelIdentification();
    await saveSession(prisma, row.id, s);
    await prisma.punchAttempt.updateMany({ where: { session_id: row.id, request_id: requestId }, data: { resolution: 'EXPIRED' } });
    return res.status(409).json({ error: { code: 'CONFIRM_EXPIRED', message: messageFor('CHALLENGE_EXPIRED'), field: null }, data: sessionReply(s) });
  }
  const direction = s.state.identified.direction;
  const result = await prisma.$transaction(async (tx) => {
    const r = await writePunch(tx, { row, s, siteId: req.site.id, direction, distance_m: check.distance_m, deviceId: b.device_id ?? null });
    await settleSiteChanges(tx, r.punch, r.work_date);
    s.finish({ punch_id: r.punch.id });
    await saveSession(tx, row.id, s, { punch_id: r.punch.id });
    return r;
  });
  dropCrops(row.crop_keys);
  await bumpAggregate(result.work_date, req.site.id).catch(() => undefined);
  res.status(201).json({ data: await punchReply(result.punch.id, false) });
});

async function punchReply(punchId, duplicate) {
  const p = await prisma.punch.findUnique({ where: { id: punchId }, include: { employee: { select: { name: true, code: true } } } });
  const code = p.direction === 'IN' ? 'PUNCHED_IN' : 'PUNCHED_OUT';
  return {
    id: p.id,
    employee: p.employee,
    direction: p.direction,
    punched_at: p.punched_at,
    work_date: fromDbDate(p.work_date),
    flagged: p.flagged,
    flag_reason: p.flag_reason,
    duplicate,
    message: messageFor(code, { time: hhmm(p.punched_at), name: p.employee.name.split(' ')[0] }),
  };
}

/** "This is not me": counts as a try; after the last try the ID/name form opens. */
export const notMe = asyncHandler(async (req, res) => {
  const b = punchNotMeSchema.parse(req.body);
  const row = await loadSession(req);
  const s = sessionOf(row);
  checkToken(s, b.confirm_token);
  const id = s.state.identified;
  const blocked = s.notMe();
  await saveSession(prisma, row.id, s);
  await prisma.punchAttempt.updateMany({ where: { session_id: row.id, request_id: id.request_id }, data: { resolution: 'NOT_ME' } });
  const reply = sessionReply(s, { outcome: 'NOT_ME', code: 'NOT_ME', message: messageFor(blocked ? 'BLOCKED' : 'NOT_ME', { tries: s.state.tries }) });
  await prisma.punchAttempt.create({
    data: {
      session_id: row.id,
      site_id: row.site_id,
      purpose: row.purpose,
      request_id: `not-me:${randomUUID()}`,
      created_at: new Date(),
      outcome: 'NOT_ME',
      code: 'NOT_ME',
      counts_as_try: true,
      tries_after: s.state.tries,
      employee_id: id.employee_id,
      score: id.score,
      live_score: id.live_score,
      reply,
    },
  });
  await audit(prisma, { actor: siteActor(req), ip: req.ip ?? null, action: 'punch.not_me', entity_type: 'punch_session', entity_id: row.id, detail: { shown: id.employee_id, score: id.score } });
  res.json({ data: reply });
});

/**
 * Leaving for another site: punch OUT here and name the site. The travel time
 * counts only if they punch IN at that site the same day; HR sees every one.
 */
export const changeSite = asyncHandler(async (req, res) => {
  const b = punchChangeSiteSchema.parse(req.body);
  const row = await loadSession(req);
  if (row.punch_id) return res.json({ data: await punchReply(row.punch_id, true) });
  const check = await fence(req, b);
  const s = sessionOf(row);
  checkToken(s, b.confirm_token);
  if (s.confirmExpired()) throw new AppError('CONFIRM_EXPIRED', messageFor('CHALLENGE_EXPIRED'), 409);
  if (s.state.identified.direction !== 'OUT') throw new AppError('VALIDATION', 'Change site is for leaving a site: punch in first.', 422);
  const to = await prisma.site.findFirst({ where: { id: b.to_site_id, deleted_at: null, is_active: true } });
  if (!to || to.id === req.site.id) throw new AppError('VALIDATION', 'Choose the site you are going to.', 422, 'to_site_id');
  const result = await prisma.$transaction(async (tx) => {
    const r = await writePunch(tx, { row, s, siteId: req.site.id, direction: 'OUT', distance_m: check.distance_m, deviceId: null });
    const change = await tx.siteChange.create({
      data: { employee_id: r.punch.employee_id, work_date: toDbDate(r.work_date), from_site_id: req.site.id, to_site_id: to.id, out_punch_id: r.punch.id, left_at: r.punch.punched_at },
    });
    await tx.punchAttempt.updateMany({ where: { session_id: row.id, request_id: s.state.identified.request_id }, data: { resolution: 'CHANGED_SITE' } });
    s.finish({ punch_id: r.punch.id, site_change_id: change.id });
    await saveSession(tx, row.id, s, { punch_id: r.punch.id });
    await audit(tx, { actor: siteActor(req), ip: req.ip ?? null, action: 'punch.change_site', entity_type: 'site_change', entity_id: change.id, detail: { employee_id: r.punch.employee_id, from: req.site.id, to: to.id } });
    return r;
  });
  dropCrops(row.crop_keys);
  await bumpAggregate(result.work_date, req.site.id).catch(() => undefined);
  const reply = await punchReply(result.punch.id, false);
  res.status(201).json({ data: { ...reply, message: messageFor('SITE_CHANGED', { time: hhmm(result.punch.punched_at), site: to.name }) } });
});

/**
 * After the try limit: the person types their employee ID and name, and HR gets a
 * manual request with the face crops of the failed tries. Nothing is marked present
 * until HR decides.
 */
export const manualRequest = asyncHandler(async (req, res) => {
  const b = punchManualSchema.parse(req.body);
  const row = await loadSession(req);
  if (row.purpose !== 'PUNCH') throw new AppError('REGISTRATION_NOT_ATTENDANCE', 'A face registration cannot create a manual attendance request. Use Punch instead.', 409);
  if (row.face_exception_id) return res.json({ data: { exception_id: row.face_exception_id, message: messageFor('MANUAL_SENT') } });
  if (row.status !== 'BLOCKED') throw new AppError('CONFLICT', 'The ID and name form opens after the face tries run out.', 409);
  const check = await fence(req, b);
  const e = await findEmployeeByCode(b.employee_code);
  if (!e) throw new AppError('UNKNOWN_EMPLOYEE', messageFor('UNKNOWN_EMPLOYEE'), 422, 'employee_code');
  const now = new Date();
  const last = await lastPunch(e.id);
  requireSourcePunchOut(last, req.site.id, now);
  const direction = nextDirection(last, now);
  const reasons = [`${row.tries} failed face tries`];
  if (!nameMatches(b.name, e.name)) reasons.push(`name typed "${b.name}" does not match`);
  if (!hasTemplate(await loadGallery(), e.id)) reasons.push('not registered with the new face system yet');
  const s = sessionOf(row);
  const fx = await prisma.$transaction(async (tx) => {
    const created = await tx.faceException.create({
      data: {
        site_id: row.site_id,
        occurred_at: now,
        claimed_employee_id: e.id,
        claimed_name: b.name,
        reason: reasons.join('; '),
        kind: 'FAILED_TRIES',
        direction,
        distance_m: check.distance_m,
        crop_keys: row.crop_keys ?? [],
        session_id: row.id,
      },
    });
    s.finish({ face_exception_id: created.id });
    await saveSession(tx, row.id, s, { face_exception_id: created.id, employee_id: e.id });
    await audit(tx, { actor: siteActor(req), ip: req.ip ?? null, action: 'face_exception.raise', entity_type: 'face_exception', entity_id: created.id, detail: { kind: 'FAILED_TRIES', claimed_employee_id: e.id } });
    return created;
  });
  res.status(201).json({ data: { exception_id: fx.id, message: messageFor('MANUAL_SENT') } });
});

// ─── HR: gate snapshots and crops ────────────────────────────────────────────

function sendImage(res, key) {
  const file = path.join(snapshotDir, path.basename(key));
  if (!existsSync(file)) throw notFound('That image (it may have passed its 30-day retention)');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.type('jpeg');
  createReadStream(file).pipe(res);
}

/** Gate snapshot for review (admin only). Deleted automatically after 30 days. */
export const getSnapshot = asyncHandler(async (req, res) => {
  const fx = await prisma.faceException.findUnique({ where: { id: req.params.id } });
  if (!fx?.snapshot_key) throw notFound('That snapshot');
  sendImage(res, fx.snapshot_key);
});

/** One face crop from a manual request's failed tries (admin only). Deleted with the gate snapshots. */
export const getCrop = asyncHandler(async (req, res) => {
  const fx = await prisma.faceException.findUnique({ where: { id: req.params.id } });
  const n = Number(req.params.n);
  const key = Number.isInteger(n) ? fx?.crop_keys?.[n] : null;
  if (!key) throw notFound('That face crop');
  sendImage(res, key);
});
