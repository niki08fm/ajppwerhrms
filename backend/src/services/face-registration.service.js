import { hasCurrentTemplate } from './face.service.js';
import { AppError, notFound } from '../utils/errors.js';

export const FACE_AUTHORIZATION_DAYS = 7;

export async function lockRegistrationEmployee(db, id) {
  await db.$queryRaw`SELECT id FROM employee WHERE id = ${id}::uuid FOR UPDATE`;
  const employee = await db.employee.findFirst({ where: { id, deleted_at: null }, select: { id: true, status: true, name: true, code: true } });
  if (!employee) throw notFound('Employee');
  return employee;
}

export function requireRegistrationActive(employee) {
  if (!employee || employee.status !== 'ACTIVE') throw new AppError('FACE_REGISTRATION_NOT_ACTIVE', 'Face registration is available only for an active employee.', 409);
}

export const liveAuthorizationWhere = (now = new Date()) => ({ status: 'APPROVED', expires_at: { gt: now } });

export function faceAuthorizationDto(row, now = new Date(), active = true) {
  if (!row) return null;
  return { id: row.id, status: row.status, reason: row.reason, approved_by: row.approved_by,
    approved_at: row.approved_at, expires_at: row.expires_at, used_at: row.used_at, used_site_id: row.used_site_id,
    revoked_by: row.revoked_by, revoked_at: row.revoked_at,
    usable: active && row.status === 'APPROVED' && row.expires_at.getTime() > now.getTime() };
}

/** Bound grants cannot be replaced by a later approval, even while captures are in flight. */
export async function requireRegistrationPermission(db, employeeId, authorizationId, now = new Date()) {
  const employee = await db.employee.findFirst({ where: { id: employeeId, deleted_at: null }, select: { id: true, status: true } });
  requireRegistrationActive(employee);
  if (!authorizationId) {
    if (await hasCurrentTemplate(employeeId, db)) throw new AppError('ALREADY_REGISTERED', 'Your face is already registered. Use Punch at any site.', 409, 'employee_code');
    return null;
  }
  const row = await db.faceRegistrationAuthorization.findFirst({ where: { id: authorizationId, employee_id: employeeId } });
  if (!row) throw new AppError('FACE_AUTHORIZATION_REVOKED', 'HR approval is no longer available. Ask HR before registering again.', 409);
  if (row.status === 'USED') throw new AppError('FACE_AUTHORIZATION_USED', 'This approval has already been used. Use Punch at any site.', 409);
  if (row.status === 'REVOKED') throw new AppError('FACE_AUTHORIZATION_REVOKED', 'HR cancelled this approval. Ask HR before registering again.', 409);
  if (row.expires_at.getTime() <= now.getTime()) throw new AppError('FACE_AUTHORIZATION_EXPIRED', 'HR approval has expired. Ask HR for a new approval.', 409);
  return row;
}
