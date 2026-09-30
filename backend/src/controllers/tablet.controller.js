import jwt from 'jsonwebtoken';
import { mkdirSync, writeFileSync, existsSync, createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { faceExceptionCreateSchema, istDate, punchCreateSchema, punchIdentifySchema } from '@ajpwer/shared';
import { assignWorkDate, inferDirection, OVERNIGHT_MAX_GAP_MIN } from '../calculations/index.js';
import { audit } from '../utils/audit.js';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { env } from '../config/env.js';
import { AppError, notFound } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { checkGeofence } from '../utils/geo.js';
import { prisma } from '../config/db.js';
import { matchFace } from '../services/face.service.js';
import { attendanceFrozen } from '../services/attendance.service.js';
import { bumpAggregate } from '../services/aggregates.service.js';

const snapshotDir = path.resolve(env.UPLOAD_DIR, 'snapshots');

/** Re-check the geofence on every call — a tablet signed in inside the fence and carried outside must stop working. */
async function fence(req, pos) {
  const site = req.site;
  const check = checkGeofence(site, pos, env.GPS_MAX_ACCURACY_M, 'Punch');
  if (!check.ok) {
    await audit(prisma, {
      actor: `site:${site.code}`,
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

function saveSnapshot(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  mkdirSync(snapshotDir, { recursive: true });
  const key = `${randomUUID()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  writeFileSync(path.join(snapshotDir, key), Buffer.from(m[2], 'base64'));
  return key;
}

async function lastPunch(employeeId, before) {
  return prisma.punch.findFirst({ where: { employee_id: employeeId, punched_at: { lt: before } }, orderBy: { punched_at: 'desc' }, include: { site: { select: { id: true, name: true } } } });
}

/** A site token can read that site's own day summary — and nothing about salaries or other sites. */
export const getSummary = asyncHandler(async (req, res) => {
  const site = req.site;
  const today = istDate(new Date());
  const punches = await prisma.punch.findMany({
    where: { work_date: toDbDate(today), site_id: site.id },
    select: { employee_id: true },
    distinct: ['employee_id'],
  });
  // On site now: the person's most recent punch anywhere is an IN, here.
  const latest = await prisma.$queryRaw`
      SELECT DISTINCT ON (p.employee_id) p.employee_id, e.name, e.code, p.punched_at, p.site_id, p.direction
      FROM punch p JOIN employee e ON e.id = p.employee_id
      WHERE p.work_date >= ${toDbDate(today)}::date - 1
      ORDER BY p.employee_id, p.punched_at DESC`;
  const onSite = latest
    .filter((r) => r.site_id === site.id && r.direction === 'IN')
    .map((r) => ({ id: r.employee_id, name: r.name, code: r.code, since: r.punched_at }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ data: { site: { id: site.id, code: site.code, name: site.name }, date: today, punched_in_today: punches.length, on_site_now: onSite } });
});

/** Step 1 of a punch: match the face server-side and infer the direction. */
export const identify = asyncHandler(async (req, res) => {
  const b = punchIdentifySchema.parse(req.body);
  const check = await fence(req, b);
  const m = await matchFace(b.embedding);
  const threshold = env.FACE_MATCH_THRESHOLD;
  if (!m.best || m.best.score < threshold) {
    return res.json({ data: { matched: false, best_match_id: m.best?.employee_id ?? null, score: m.best?.score ?? null, threshold, distance_m: check.distance_m } });
  }
  const e = await prisma.employee.findUniqueOrThrow({ where: { id: m.best.employee_id }, select: { id: true, name: true, code: true, designation: true } });
  const now = new Date();
  const last = await lastPunch(e.id, now);
  const recent = last && now.getTime() - last.punched_at.getTime() <= OVERNIGHT_MAX_GAP_MIN * 60_000 ? last : null;
  const direction = inferDirection(recent);
  const crossSite = recent && recent.direction === 'IN' && recent.site_id !== req.site.id ? { from: recent.site.name } : null;
  const token = jwt.sign({ eid: e.id, sid: req.site.id, score: m.best.score, typ: 'match' }, env.SITE_JWT_SECRET, { expiresIn: '3m' });
  res.json({
    data: {
      matched: true,
      employee: e,
      score: m.best.score,
      direction,
      cross_site: crossSite,
      note: crossSite ? `Last punch was IN at ${crossSite.from}. Punching out here is fine — both sites are recorded and the day is paid by hours.` : null,
      match_token: token,
      distance_m: check.distance_m,
    },
  });
});

/**
 * Step 2: write the punch. Server timestamp for live punches; the original time
 * for offline-queued ones, with both times stored and late arrivals flagged.
 * Idempotent on (employee, site, client timestamp).
 */
export const createPunch = asyncHandler(async (req, res) => {
  const b = punchCreateSchema.parse(req.body);
  const site = req.site;
  const check = await fence(req, b);
  const serverNow = new Date();
  const clientAt = new Date(b.client_punched_at);

  let employeeId;
  let score;
  if (b.match_token) {
    let payload;
    try {
      payload = jwt.verify(b.match_token, env.SITE_JWT_SECRET);
    } catch {
      throw new AppError('VALIDATION', 'The face match has expired. Scan again.', 422, 'match_token');
    }
    if (payload.typ !== 'match' || payload.sid !== site.id || (b.employee_id && payload.eid !== b.employee_id)) {
      throw new AppError('FORBIDDEN', 'This face match was not made at this site.', 403);
    }
    employeeId = payload.eid;
    score = payload.score;
  } else {
    // Queued offline: match now; below threshold becomes an exception at the original time.
    const m = await matchFace(b.embedding);
    if (!m.best || m.best.score < env.FACE_MATCH_THRESHOLD) {
      const fx = await prisma.faceException.create({
        data: {
          site_id: site.id,
          occurred_at: clientAt,
          best_match_id: m.best?.employee_id ?? null,
          score: m.best?.score ?? null,
          reason: 'Queued offline punch did not match confidently on sync',
          direction: b.direction,
          distance_m: check.distance_m,
          snapshot_key: saveSnapshot(b.snapshot),
        },
      });
      return res.status(202).json({ data: { exception_id: fx.id, matched: false } });
    }
    employeeId = m.best.employee_id;
    score = m.best.score;
  }

  // Deduplicate a retry on (employee, site, client timestamp).
  const dup = await prisma.punch.findUnique({ where: { employee_id_site_id_client_punched_at: { employee_id: employeeId, site_id: site.id, client_punched_at: clientAt } } });
  if (dup) return res.status(200).json({ data: { ...dup, work_date: fromDbDate(dup.work_date), duplicate: true } });

  const punchedAt = b.queued ? clientAt : serverNow;
  const flags = [];
  const lateMin = (serverNow.getTime() - clientAt.getTime()) / 60_000;
  if (b.queued && lateMin > env.LATE_SYNC_FLAG_MIN) flags.push(`Arrived ${Math.round(lateMin)} min after it was taken (offline queue)`);
  if (!b.queued && Math.abs(lateMin) > env.CLOCK_SKEW_FLAG_MIN) flags.push(`Tablet clock differs from server by ${Math.round(Math.abs(lateMin))} min`);

  const last = await lastPunch(employeeId, punchedAt);
  const work_date = assignWorkDate(punchedAt, b.direction, last ? { direction: last.direction, work_date: fromDbDate(last.work_date), at: last.punched_at.getTime() } : null);

  const frozen = await attendanceFrozen(prisma, work_date.slice(0, 7));
  if (frozen.frozen) flags.push('Arrived after the month was submitted for payroll');

  const p = await prisma.punch.create({
    data: {
      employee_id: employeeId,
      site_id: site.id,
      direction: b.direction,
      punched_at: punchedAt,
      client_punched_at: clientAt,
      work_date: toDbDate(work_date),
      method: 'FACE',
      match_score: score,
      distance_m: check.distance_m,
      device_id: b.device_id,
      flagged: flags.length > 0,
      flag_reason: flags.join('; ') || null,
    },
  });
  await bumpAggregate(work_date, site.id).catch(() => undefined);
  const e = await prisma.employee.findUnique({ where: { id: employeeId }, select: { name: true, code: true } });
  res.status(201).json({ data: { id: p.id, employee: e, direction: p.direction, punched_at: p.punched_at, work_date, flagged: p.flagged, flag_reason: p.flag_reason } });
});

/** When the camera cannot identify someone, nothing is marked present: the attempt is queued for HR. */
export const raiseFaceException = asyncHandler(async (req, res) => {
  const b = faceExceptionCreateSchema.parse(req.body);
  const site = req.site;
  const check = await fence(req, b);
  const fx = await prisma.faceException.create({
    data: {
      site_id: site.id,
      occurred_at: new Date(b.occurred_at),
      claimed_employee_id: b.claimed_employee_id ?? null,
      best_match_id: b.best_match_id ?? null,
      score: b.score ?? null,
      reason: b.reason,
      direction: b.direction ?? null,
      distance_m: check.distance_m,
      snapshot_key: saveSnapshot(b.snapshot),
    },
  });
  await audit(prisma, { actor: `site:${site.code}`, ip: req.ip ?? null, action: 'face_exception.raise', entity_type: 'face_exception', entity_id: fx.id, detail: { reason: b.reason } });
  res.status(201).json({ data: { id: fx.id } });
});

/** Gate snapshot for review (admin only). Deleted automatically after 30 days. */
export const getSnapshot = asyncHandler(async (req, res) => {
  const fx = await prisma.faceException.findUnique({ where: { id: req.params.id } });
  if (!fx?.snapshot_key) throw notFound('That snapshot');
  const file = path.join(snapshotDir, path.basename(fx.snapshot_key));
  if (!existsSync(file)) throw notFound('That snapshot (it may have passed its 30-day retention)');
  res.setHeader('Cache-Control', 'private, max-age=300');
  createReadStream(file).pipe(res);
});
