import { bestMatches, vectorNorm } from '@ajpwer/face/recognition';
import { prisma } from '../config/db.js';

/**
 * Face matching over stored embeddings (never photographs). The matching itself
 * lives in face/ (@ajpwer/face/recognition); this service loads who is enrolled from
 * the database and caches it. Below the threshold nothing is marked present:
 * the attempt goes to the exception queue for a human.
 */

let cache = null;
const CACHE_MS = 60_000;

export function invalidateFaceCache() {
  cache = null;
}

function toVec(buf) {
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}

async function enrolled() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const rows = await prisma.employeeFace.findMany({
    where: { deleted_at: null, employee: { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE', 'ONBOARDING'] } } },
    select: { employee_id: true, embedding: true },
  });
  const out = rows
    .filter((r) => r.embedding.length >= 256)
    .map((r) => {
      const vec = toVec(r.embedding);
      return { employee_id: r.employee_id, vec, norm: vectorNorm(vec) };
    });
  cache = { at: Date.now(), rows: out };
  return out;
}

export async function matchFace(embedding) {
  return bestMatches(embedding, await enrolled());
}
