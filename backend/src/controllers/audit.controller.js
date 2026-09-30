import { asyncHandler } from '../utils/asyncHandler.js';
import { filterOne, filterValues, keysetOrder, keysetWhere, page, parseList, toCSV } from '../utils/list.js';
import { auditReq } from '../utils/audit.js';
import { prisma } from '../config/db.js';

const SORTS = [{ key: 'at', field: 'at', type: 'date' }];

function where(q, f) {
  const and = [];
  const from = filterOne(f, 'from');
  if (from) and.push({ at: { gte: new Date(`${from}T00:00:00+05:30`) } });
  const to = filterOne(f, 'to');
  if (to) and.push({ at: { lte: new Date(`${to}T23:59:59.999+05:30`) } });
  const actor = filterValues(f, 'actor');
  if (actor.length) and.push({ actor: { in: actor } });
  const action = filterValues(f, 'action');
  if (action.length) and.push({ OR: action.map((a) => ({ action: { startsWith: a } })) });
  const entity = filterValues(f, 'entity');
  if (entity.length) and.push({ entity_type: { in: entity } });
  const entityId = filterOne(f, 'entity_id');
  if (entityId) and.push({ OR: [{ entity_id: entityId }, { detail: { path: ['employee_id'], equals: entityId } }] });
  if (q) and.push({ OR: [{ action: { contains: q, mode: 'insensitive' } }, { actor: { contains: q, mode: 'insensitive' } }, { entity_id: q }] });
  return { AND: and };
}

export const listAuditLog = asyncHandler(async (req, res) => {
  const p = parseList(req, SORTS, '-at');
  const w = where(p.q, p.filter);
  const [rows, total] = await Promise.all([prisma.auditLog.findMany({ where: { AND: [w, keysetWhere(p) ?? {}] }, orderBy: keysetOrder(p), take: p.limit + 1 }), prisma.auditLog.count({ where: w })]);
  res.json(page(rows, p, total));
});

export const getFacets = asyncHandler(async (_req, res) => {
  const [actors, entities, actions] = await Promise.all([
    prisma.auditLog.groupBy({ by: ['actor'], _count: true, orderBy: { _count: { actor: 'desc' } }, take: 50 }),
    prisma.auditLog.groupBy({ by: ['entity_type'], _count: true }),
    prisma.$queryRaw`SELECT split_part(action, '.', 1) AS prefix, COUNT(*) AS count FROM audit_log GROUP BY 1 ORDER BY 2 DESC`,
  ]);
  res.json({ data: { actors: actors.map((a) => a.actor), entities: entities.map((e) => e.entity_type), actions: actions.map((a) => a.prefix) } });
});

export const exportAuditLog = asyncHandler(async (req, res) => {
  const p = parseList(req, SORTS, '-at');
  const rows = await prisma.auditLog.findMany({ where: where(p.q, p.filter), orderBy: { at: 'desc' }, take: 50_000 });
  await auditReq(req, { action: 'export.audit', entity_type: 'audit_log', detail: { rows: rows.length, filter: p.filter } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log.csv"`);
  res.send(
    toCSV(
      rows.map((r) => ({ at: r.at.toISOString(), actor: r.actor, action: r.action, entity_type: r.entity_type, entity_id: r.entity_id, ip: r.ip, detail: JSON.stringify(r.detail) })),
      [
        { key: 'at', label: 'Time (UTC)' },
        { key: 'actor', label: 'Actor' },
        { key: 'action', label: 'Action' },
        { key: 'entity_type', label: 'Entity' },
        { key: 'entity_id', label: 'Entity id' },
        { key: 'ip', label: 'IP' },
        { key: 'detail', label: 'Detail' },
      ],
    ),
  );
});
