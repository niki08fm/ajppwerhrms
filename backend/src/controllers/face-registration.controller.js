import { z } from 'zod';
import { prisma } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { auditReq } from '../utils/audit.js';
import { AppError, notFound } from '../utils/errors.js';
import { hasCurrentTemplate } from '../services/face.service.js';
import { getManualFaceFailureStreak } from '../services/face-failure-streak.service.js';
import { FACE_AUTHORIZATION_DAYS, faceAuthorizationDto, liveAuthorizationWhere, lockRegistrationEmployee, requireRegistrationActive } from '../services/face-registration.service.js';

const authorizeSchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict();
const revokeSchema = z.object({ authorization_id: z.string().uuid() }).strict();

export const getFaceRegistration = asyncHandler(async (req, res) => {
  const employee = await prisma.employee.findFirst({ where: { id: req.params.id, deleted_at: null }, select: { id: true, status: true } });
  if (!employee) throw notFound('Employee');
  const now = new Date();
  const [face_registered, authorization, manual_failure_streak] = await Promise.all([
    hasCurrentTemplate(employee.id),
    prisma.faceRegistrationAuthorization.findFirst({ where: { employee_id: employee.id }, orderBy: [{ approved_at: 'desc' }, { id: 'desc' }] }),
    getManualFaceFailureStreak(prisma, employee.id, now),
  ]);
  res.json({ data: { face_registered, authorization: faceAuthorizationDto(authorization, now, employee.status === 'ACTIVE'), manual_failure_streak } });
});

export const authorizeFaceRegistration = asyncHandler(async (req, res) => {
  const b = authorizeSchema.parse(req.body);
  const result = await prisma.$transaction(async (tx) => {
    const employee = await lockRegistrationEmployee(tx, req.params.id);
    requireRegistrationActive(employee);
    if (!(await hasCurrentTemplate(employee.id, tx))) throw new AppError('FACE_NOT_REGISTERED', 'This employee can use Register face for their first registration without a replacement approval.', 409);
    const now = new Date();
    const existing = await tx.faceRegistrationAuthorization.findFirst({ where: { employee_id: employee.id, ...liveAuthorizationWhere(now) } });
    if (existing) return { row: existing, created: false };
    const expired = await tx.faceRegistrationAuthorization.findFirst({ where: { employee_id: employee.id, status: 'APPROVED' } });
    if (expired) {
      await tx.faceRegistrationAuthorization.update({ where: { id: expired.id }, data: { status: 'REVOKED', revoked_at: now, revoked_by: req.admin.email } });
      await auditReq(req, { action: 'face.registration_authorization.expired_replaced', entity_type: 'employee', entity_id: employee.id, detail: { authorization_id: expired.id, expired_at: expired.expires_at } }, tx);
    }
    const row = await tx.faceRegistrationAuthorization.create({ data: { employee_id: employee.id, reason: b.reason, approved_by: req.admin.email, approved_at: now, expires_at: new Date(now.getTime() + FACE_AUTHORIZATION_DAYS * 86400_000) } });
    await auditReq(req, { action: 'face.registration_authorization.approve', entity_type: 'employee', entity_id: employee.id,
      detail: { authorization_id: row.id, reason: row.reason, approved_at: row.approved_at, expires_at: row.expires_at } }, tx);
    return { row, created: true };
  });
  res.status(result.created ? 201 : 200).json({ data: faceAuthorizationDto(result.row) });
});

export const revokeFaceRegistration = asyncHandler(async (req, res) => {
  const b = revokeSchema.parse(req.body);
  const row = await prisma.$transaction(async (tx) => {
    const employee = await lockRegistrationEmployee(tx, req.params.id);
    const current = await tx.faceRegistrationAuthorization.findFirst({ where: { id: b.authorization_id, employee_id: employee.id } });
    if (!current) throw notFound('Face registration approval');
    if (current.status === 'USED') throw new AppError('FACE_AUTHORIZATION_USED', 'This approval has already been used.', 409);
    if (current.status === 'REVOKED') return current;
    const changed = await tx.faceRegistrationAuthorization.update({ where: { id: current.id }, data: { status: 'REVOKED', revoked_by: req.admin.email, revoked_at: new Date() } });
    await auditReq(req, { action: 'face.registration_authorization.revoke', entity_type: 'employee', entity_id: employee.id, detail: { authorization_id: changed.id, reason: changed.reason, revoked_at: changed.revoked_at } }, tx);
    return changed;
  });
  res.json({ data: faceAuthorizationDto(row) });
});
