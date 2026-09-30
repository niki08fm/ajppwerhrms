import { prisma } from '../config/db.js';

/** Insert-only. Revoked UPDATE/DELETE and a trigger guarantee nothing rewrites it. */
export async function audit(db, e) {
  await db.auditLog.create({
    data: {
      actor: e.actor,
      action: e.action,
      entity_type: e.entity_type,
      entity_id: e.entity_id ?? null,
      detail: JSON.parse(JSON.stringify(e.detail ?? {})),
      ip: e.ip ?? null,
    },
  });
}

/** Actor and IP from a request, for audit entries. */
export function who(req) {
  const actor = req.admin ? req.admin.email : req.site ? `site:${req.site.code}` : 'anonymous';
  return { actor, ip: req.ip ?? null };
}

export function auditReq(req, e, db = prisma) {
  return audit(db, { ...e, ...who(req) });
}

/** Old/new pairs for only the fields that changed. */
export function diff(before, after) {
  const out = {};
  for (const k of Object.keys(after)) {
    const a = before[k];
    const b = after[k];
    const norm = (v) => (typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString() : v);
    if (JSON.stringify(norm(a)) !== JSON.stringify(norm(b))) out[k] = { from: norm(a), to: norm(b) };
  }
  return out;
}
