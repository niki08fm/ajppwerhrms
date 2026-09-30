import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/errors.js';

/** Turns any thrown error into the API's error shape: { error: { code, message, field } }. */

function fromZod(err) {
  const first = err.issues[0];
  const field = first?.path.join('.') || null;
  let message = first?.message ?? 'The request is not valid.';
  if (first?.code === 'unrecognized_keys') message = `Unknown field${first.keys.length > 1 ? 's' : ''}: ${first.keys.join(', ')}.`;
  return new AppError(
    'VALIDATION',
    message,
    422,
    field,
    err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  );
}

function fromPrisma(err) {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = err.meta?.target?.join(', ');
      if (target?.includes('client_punched_at')) return new AppError('DUPLICATE_PUNCH', 'This punch was already recorded.', 409);
      return new AppError('CONFLICT', `A record with the same ${target ?? 'value'} already exists.`, 409, target ?? null);
    }
    if (err.code === 'P2025') return new AppError('NOT_FOUND', 'The record was not found.', 404);
    if (err.code === 'P2003') return new AppError('CONFLICT', 'This record is referenced elsewhere and cannot be changed that way.', 409);
  }
  const msg = err instanceof Error ? err.message : '';
  if (msg.includes('employee_salary_no_overlap') || msg.includes('23P01')) {
    return new AppError('SALARY_OVERLAP', 'Two salary records for this person would overlap in date.', 409);
  }
  if (msg.includes('cannot be changed') && msg.includes('period')) {
    return new AppError('PERIOD_LOCKED', 'This payroll month is locked. Unlock it to make changes.', 409);
  }
  if (msg.includes('append-only') || msg.includes('insert-only')) {
    return new AppError('FORBIDDEN', 'This record cannot be changed: corrections are added as separate records.', 403);
  }
  return null;
}

export const errorHandler = (err, req, res, _next) => {
  let e;
  if (err instanceof AppError) e = err;
  else if (err instanceof ZodError) e = fromZod(err);
  else if (err?.type === 'entity.parse.failed') e = new AppError('VALIDATION', 'The request body is not valid JSON.', 400);
  else {
    const p = fromPrisma(err);
    if (p) e = p;
    else {
      logger.error({ err, path: req.path }, 'unhandled error');
      e = new AppError('INTERNAL', 'The server could not complete this request. It has been logged; try again, and if it keeps failing tell the administrator.', 500);
    }
  }
  res.status(e.status).json({ error: { code: e.code, message: e.message, field: e.field, ...(e.details ? { details: e.details } : {}) } });
};
