import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import type { ErrorCode } from '@ajpwer/shared';
import { logger } from './logger';

/** Every error the API returns has a machine code and a message written for a person. */
export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status = 400,
    public field: string | null = null,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} was not found.`, 404);
export const forbidden = (message = 'You do not have permission to do this. Ask the HR administrator.') =>
  new AppError('FORBIDDEN', message, 403);

/** Wrap an async handler so rejected promises reach the error handler. */
export const ah =
  (fn: (...args: Parameters<RequestHandler>) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

function fromZod(err: ZodError): AppError {
  const first = err.issues[0];
  const field = first?.path.join('.') || null;
  let message = first?.message ?? 'The request is not valid.';
  if (first?.code === 'unrecognized_keys') message = `Unknown field${first.keys.length > 1 ? 's' : ''}: ${first.keys.join(', ')}.`;
  return new AppError('VALIDATION', message, 422, field, err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
}

function fromPrisma(err: unknown): AppError | null {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      const target = (err.meta?.target as string[] | undefined)?.join(', ');
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

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let e: AppError;
  if (err instanceof AppError) e = err;
  else if (err instanceof ZodError) e = fromZod(err);
  else if ((err as { type?: string })?.type === 'entity.parse.failed') e = new AppError('VALIDATION', 'The request body is not valid JSON.', 400);
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
