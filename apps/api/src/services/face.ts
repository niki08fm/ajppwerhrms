import { prisma } from '../lib/prisma';

/**
 * Face matching over stored embeddings (never photographs). Cosine similarity
 * against every enrolled, active person. Below the threshold nothing is marked
 * present: the attempt goes to the exception queue for a human.
 */

interface Enrolled {
  employee_id: string;
  vec: Float32Array;
  norm: number;
}

let cache: { at: number; rows: Enrolled[] } | null = null;
const CACHE_MS = 60_000;

export function invalidateFaceCache() {
  cache = null;
}

function toVec(buf: Buffer): Float32Array {
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}

function norm(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

async function enrolled(): Promise<Enrolled[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const rows = await prisma.employeeFace.findMany({
    where: { deleted_at: null, employee: { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE', 'ONBOARDING'] } } },
    select: { employee_id: true, embedding: true },
  });
  const out = rows
    .filter((r) => r.embedding.length >= 256)
    .map((r) => {
      const vec = toVec(r.embedding);
      return { employee_id: r.employee_id, vec, norm: norm(vec) };
    });
  cache = { at: Date.now(), rows: out };
  return out;
}

export interface MatchResult {
  best: { employee_id: string; score: number } | null;
  second: { employee_id: string; score: number } | null;
}

export async function matchFace(embedding: number[]): Promise<MatchResult> {
  const probeNorm = norm(embedding);
  if (probeNorm === 0) return { best: null, second: null };
  const list = await enrolled();
  let best: MatchResult['best'] = null;
  let second: MatchResult['second'] = null;
  for (const e of list) {
    if (e.vec.length !== embedding.length || e.norm === 0) continue;
    let dot = 0;
    for (let i = 0; i < embedding.length; i++) dot += embedding[i] * e.vec[i];
    const score = Math.max(0, Math.min(1, dot / (probeNorm * e.norm)));
    if (!best || score > best.score) {
      second = best;
      best = { employee_id: e.employee_id, score };
    } else if (!second || score > second.score) {
      second = { employee_id: e.employee_id, score };
    }
  }
  return { best, second };
}
