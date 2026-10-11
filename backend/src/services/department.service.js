import { z } from 'zod';
import { audit, diff } from '../utils/audit.js';
import { AppError, notFound } from '../utils/errors.js';

const fields = {
  name: z.string().trim().min(1, 'Enter a department name.').max(80),
  colour: z.enum(['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5']),
};
export const departmentCreate = z.object({ ...fields, colour: fields.colour.default('chart-1') }).strict();
export const departmentPatch = z.object(fields).partial().strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Change the department name or colour.' });

/**
 * Department names are globally unique in the schema, but HR treats case-only
 * differences as the same name. Serialize this small setup namespace so create,
 * restore and rename cannot race around a case-insensitive duplicate check.
 */
async function lockNames(tx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(20261011, 17)`;
}

async function view(db, d) {
  const [headcount, assigned_count] = await Promise.all([
    db.employee.count({ where: { department_id: d.id, deleted_at: null, status: { in: ['ACTIVE', 'NOTICE'] } } }),
    db.employee.count({ where: { department_id: d.id } }),
  ]);
  return { id: d.id, name: d.name, colour: d.colour, headcount, assigned_count, can_delete: assigned_count === 0 };
}

export async function listDepartmentSettings(db) {
  const [rows, active] = await Promise.all([
    db.department.findMany({ where: { deleted_at: null }, orderBy: { name: 'asc' }, include: { _count: { select: { employees: true } } } }),
    db.employee.groupBy({ by: ['department_id'], where: { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE'] } }, _count: { _all: true } }),
  ]);
  const activeBy = new Map(active.map((e) => [e.department_id, e._count._all]));
  return rows.map((d) => ({ id: d.id, name: d.name, colour: d.colour, headcount: activeBy.get(d.id) ?? 0,
    assigned_count: d._count.employees, can_delete: d._count.employees === 0 }));
}

function duplicate(name) {
  return new AppError('CONFLICT', `A department called "${name}" already exists. Choose a different name.`, 409, 'name');
}

export async function addDepartment(db, body, actor) {
  const b = departmentCreate.parse(body);
  return db.$transaction(async (tx) => {
    await lockNames(tx);
    const matches = await tx.$queryRaw`SELECT id, name, deleted_at FROM department
      WHERE lower(btrim(name)) = lower(${b.name}) ORDER BY created_at, id`;
    if (matches.some((d) => !d.deleted_at)) throw duplicate(b.name);
    // Older versions used soft deletion. Restoring that name is deliberate and
    // preserves any employee references rather than discarding hidden history.
    // Legacy case-sensitive uniqueness could leave several archived case
    // variants. Prefer an exact stored name so restoration cannot collide with
    // a different archived row's global unique name.
    const old = matches.find((d) => d.name === b.name) ?? matches[0];
    const d = old ? await tx.department.update({ where: { id: old.id }, data: { ...b, deleted_at: null } })
      : await tx.department.create({ data: b });
    await audit(tx, { ...actor, action: old ? 'department.restore' : 'department.create', entity_type: 'department', entity_id: d.id,
      detail: old ? { name: b.name, colour: b.colour, restored: true } : b });
    return view(tx, d);
  });
}

export async function changeDepartment(db, id, body, actor) {
  const b = departmentPatch.parse(body);
  return db.$transaction(async (tx) => {
    await lockNames(tx);
    const before = await tx.department.findFirst({ where: { id, deleted_at: null } });
    if (!before) throw notFound('That department');
    if (b.name !== undefined) {
      const [other] = await tx.$queryRaw`SELECT id FROM department
        WHERE id <> ${id}::uuid AND lower(btrim(name)) = lower(${b.name}) LIMIT 1`;
      // A global @unique name includes tombstones. A rename does not silently
      // take over a different department's identity: reuse it through Add.
      if (other) throw duplicate(b.name);
    }
    const d = await tx.department.update({ where: { id }, data: b });
    const changes = diff(before, b);
    if (Object.keys(changes).length) await audit(tx, { ...actor, action: 'department.update', entity_type: 'department', entity_id: id, detail: { changes } });
    return view(tx, d);
  });
}

const inUse = (count) => new AppError('DEPARTMENT_IN_USE',
  'This department is linked to existing employee records. Move those records to another department before deleting it.',
  409, null, { assigned_count: count });

export async function removeDepartment(db, id, actor) {
  try {
    return await db.$transaction(async (tx) => {
      await lockNames(tx);
      const d = await tx.department.findFirst({ where: { id, deleted_at: null } });
      if (!d) throw notFound('That department');
      const count = await tx.employee.count({ where: { department_id: id } });
      if (count) throw inUse(count);
      // Physical deletion of a completely unreferenced setup row frees its
      // name. The FK's RESTRICT check also catches concurrent assignments after
      // the count, so a deleted ID can never accept a stale employee selection.
      await tx.department.delete({ where: { id } });
      await audit(tx, { ...actor, action: 'department.delete', entity_type: 'department', entity_id: id,
        detail: { name: d.name, colour: d.colour, assigned_count: 0 } });
      return { id, deleted: true };
    });
  } catch (error) {
    if (error?.code === 'P2003') throw inUse(await db.employee.count({ where: { department_id: id } }));
    throw error;
  }
}

/**
 * Validate inside the employee write transaction. KEY SHARE keeps a concurrent
 * physical deletion from winning after validation; the FK remains the final
 * safeguard. Legacy soft-deleted rows are not selectable for new assignments.
 */
export async function assertDepartmentAssignable(tx, id) {
  const rows = await tx.$queryRaw`SELECT id, name FROM department WHERE id = ${id}::uuid AND deleted_at IS NULL FOR KEY SHARE`;
  if (!rows.length) throw new AppError('DEPARTMENT_UNAVAILABLE', 'That department is no longer available. Reload and choose another department.', 409, 'department_id');
  return rows[0];
}
