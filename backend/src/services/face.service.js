import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { buildGallery, createFaceClient, embeddingToBytes, MODEL_VERSION, rollingToDelete, shouldLearn } from '@ajpwer/face';
import { env } from '../config/env.js';
import { prisma } from '../config/db.js';

/**
 * Face v2 on the backend (face/INTEGRATION.md). The Python face service only
 * analyses frames; everything else lives here: the templates and the gallery
 * cache, the thresholds, and learning rolling templates from confident punches.
 * Templates are embeddings, never photographs.
 */

export const snapshotDir = path.resolve(env.UPLOAD_DIR, 'snapshots');

/** Thresholds from .env, in the shape face/src expects. */
export function faceConfig() {
  return {
    matchMin: env.FACE_MATCH_MIN,
    matchMargin: env.FACE_MATCH_MARGIN,
    liveMin: env.FACE_LIVE_MIN,
    registerLiveMin: env.FACE_REGISTER_LIVE_MIN,
    turnMinDeg: env.FACE_TURN_MIN_DEG,
    samePersonMin: env.FACE_SAME_PERSON_MIN,
    duplicateMin: env.FACE_DUPLICATE_MIN,
    learnMin: env.FACE_LEARN_MIN,
    rollingMax: env.FACE_ROLLING_MAX,
    maxTries: env.FACE_MAX_TRIES,
    challengeSeconds: env.FACE_CHALLENGE_SECONDS,
    confirmSeconds: env.FACE_CONFIRM_SECONDS,
  };
}

// ─── The face service client (replaceable in tests) ─────────────────────────

let client = null;

export function faceClient() {
  client ??= createFaceClient({ url: env.FACE_SERVICE_URL, token: env.FACE_SERVICE_TOKEN, timeoutMs: env.FACE_SERVICE_TIMEOUT_MS });
  return client;
}

/** Tests put a mock here; pass null to go back to the real service. */
export function setFaceClient(c) {
  client = c;
}

// ─── Gallery ─────────────────────────────────────────────────────────────────

let cache = null;
const CACHE_MS = 60_000;

export function invalidateFaceCache() {
  cache = null;
}

const ACTIVE_STATUSES = ['ACTIVE', 'NOTICE'];

/** Every current-model template of people who can punch, grouped by person. Cached for a minute. */
export async function loadGallery() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.gallery;
  const rows = await prisma.employeeFace.findMany({
    where: { deleted_at: null, model_version: MODEL_VERSION, employee: { deleted_at: null, status: { in: ACTIVE_STATUSES } } },
    select: { employee_id: true, embedding: true, model_version: true },
  });
  const gallery = buildGallery(rows);
  cache = { at: Date.now(), gallery };
  return gallery;
}

/** Has this person a face v2 template? Until they do, their punches go through the manual request. */
export async function hasCurrentTemplate(employeeId, db = prisma) {
  return (await db.employeeFace.count({ where: { employee_id: employeeId, deleted_at: null, model_version: MODEL_VERSION } })) > 0;
}

// ─── Templates ───────────────────────────────────────────────────────────────

/** A registration (tablet or HR). HR re-enrolling replaces every earlier template for the person. */
export async function saveRegisteredTemplate(tx, { employeeId, embedding, siteId = null, liveScore = null, replace = false }) {
  if (replace) await tx.employeeFace.updateMany({ where: { employee_id: employeeId, deleted_at: null }, data: { deleted_at: new Date(), embedding: Buffer.alloc(0) } });
  const t = await tx.employeeFace.create({
    data: { employee_id: employeeId, embedding: embeddingToBytes(embedding), model_version: MODEL_VERSION, kind: 'REGISTERED', site_id: siteId, live_score: liveScore, consent_at: new Date() },
  });
  invalidateFaceCache();
  return t;
}

/**
 * After a confirmed punch that was sure enough and live, keep its embedding as a
 * rolling template (faces change: beards, weight, age) and trim the oldest beyond
 * FACE_ROLLING_MAX. Registered templates are never trimmed. Returns what it did.
 */
export async function learnFromPunch(tx, { employeeId, embedding, score, liveScore, siteId }) {
  const cfg = faceConfig();
  if (!embedding || cfg.rollingMax === 0 || !shouldLearn({ score, live_score: liveScore }, cfg)) return { learned: false, trimmed: 0 };
  await tx.employeeFace.create({
    data: { employee_id: employeeId, embedding: embeddingToBytes(embedding), model_version: MODEL_VERSION, kind: 'ROLLING', site_id: siteId, score, live_score: liveScore, consent_at: new Date() },
  });
  const all = await tx.employeeFace.findMany({
    where: { employee_id: employeeId, deleted_at: null, model_version: MODEL_VERSION },
    select: { id: true, kind: true, created_at: true },
  });
  const drop = rollingToDelete(all, cfg.rollingMax);
  if (drop.length) await tx.employeeFace.updateMany({ where: { id: { in: drop } }, data: { deleted_at: new Date(), embedding: Buffer.alloc(0) } });
  invalidateFaceCache();
  return { learned: true, trimmed: drop.length };
}

// ─── Crops ───────────────────────────────────────────────────────────────────

/** The aligned 112×112 face crop the service returns, kept for a manual request. Deleted with gate snapshots. */
export function saveCrop(base64Jpeg) {
  if (!base64Jpeg) return null;
  mkdirSync(snapshotDir, { recursive: true });
  const key = `crop-${randomUUID()}.jpg`;
  writeFileSync(path.join(snapshotDir, key), Buffer.from(base64Jpeg, 'base64'));
  return key;
}

export { MODEL_VERSION };
