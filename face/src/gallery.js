/**
 * The gallery: every usable face template, grouped by person. Only templates made
 * by the current model are comparable; older ones ("faceapi-v1") are ignored, so
 * a person with only old templates is simply not in the gallery until they
 * register again. Embeddings are 128 numbers of length 1: similarity = dot product.
 */
export const MODEL_VERSION = 'sface-2021dec';
export const EMBEDDING_SIZE = 128;

/** Float32 bytes from the database (or an array) → Float32Array. */
export function toEmbedding(v) {
  if (v instanceof Float32Array) return v;
  if (Array.isArray(v)) return Float32Array.from(v);
  const buf = Buffer.from(v);
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

export function embeddingToBytes(v) {
  const f = Float32Array.from(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

export function normalise(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (!n) return Float32Array.from(v);
  return Float32Array.from(v, (x) => x / n);
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** templates: [{ employee_id, model_version, embedding }] */
export function buildGallery(templates, modelVersion = MODEL_VERSION) {
  const byEmployee = new Map();
  let count = 0;
  for (const t of templates) {
    if (t.model_version !== modelVersion) continue;
    const e = toEmbedding(t.embedding);
    if (e.length !== EMBEDDING_SIZE) continue;
    const list = byEmployee.get(t.employee_id) ?? [];
    list.push(normalise(e));
    byEmployee.set(t.employee_id, list);
    count++;
  }
  return { modelVersion, byEmployee, templates: count, people: byEmployee.size };
}

/** Best and second-best person for a probe; each person scores their best template. */
export function matchGallery(gallery, probe, { exclude } = {}) {
  const p = normalise(toEmbedding(probe));
  let best = null;
  let second = null;
  for (const [employee_id, list] of gallery.byEmployee) {
    if (exclude && employee_id === exclude) continue;
    let score = -1;
    for (const t of list) score = Math.max(score, dot(p, t));
    if (!best || score > best.score) {
      second = best;
      best = { employee_id, score };
    } else if (!second || score > second.score) {
      second = { employee_id, score };
    }
  }
  return { best, second };
}

export function hasTemplate(gallery, employeeId) {
  return gallery.byEmployee.has(employeeId);
}
