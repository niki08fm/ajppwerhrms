/**
 * Face matching on the server, over stored embeddings (never photographs).
 * Cosine similarity of the probe against every enrolled person; the caller
 * decides what counts as a match (FACE_MATCH_THRESHOLD) and sends anything
 * below it to the exception queue for a human. Pure: no I/O, no model files.
 */

export interface EnrolledFace {
  employee_id: string;
  vec: ArrayLike<number>;
  /** Precomputed length of vec, so a search does not recompute it */
  norm: number;
}

export interface FaceMatch {
  employee_id: string;
  /** Cosine similarity, 0–1 */
  score: number;
}

export interface MatchResult {
  best: FaceMatch | null;
  /** The runner-up, so a near tie can be treated as uncertain */
  second: FaceMatch | null;
}

export function vectorNorm(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

/** The closest and second-closest enrolled faces to a probe embedding. */
export function bestMatches(probe: ArrayLike<number>, enrolled: EnrolledFace[]): MatchResult {
  const probeNorm = vectorNorm(probe);
  if (probeNorm === 0) return { best: null, second: null };
  let best: FaceMatch | null = null;
  let second: FaceMatch | null = null;
  for (const e of enrolled) {
    if (e.vec.length !== probe.length || e.norm === 0) continue;
    let dot = 0;
    for (let i = 0; i < probe.length; i++) dot += probe[i] * e.vec[i];
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
