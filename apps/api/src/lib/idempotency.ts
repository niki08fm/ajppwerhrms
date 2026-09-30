import type { NextFunction, Request, Response } from 'express';
import { prisma } from './prisma';

/**
 * Idempotency-Key support for POST /punches, run and mark-paid: a repeat with
 * the same key returns the original result rather than acting twice.
 */
export function idempotent(scope: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header('Idempotency-Key');
    if (!key) return next();
    const fullScope = `${scope}:${req.admin?.id ?? req.site?.id ?? 'anon'}`;
    const existing = await prisma.idempotencyKey.findUnique({ where: { scope_key: { scope: fullScope, key } } });
    if (existing) {
      res.setHeader('Idempotent-Replay', 'true');
      return res.status(existing.status_code).json(existing.response);
    }
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode < 500) {
        prisma.idempotencyKey
          .create({ data: { scope: fullScope, key, status_code: res.statusCode, response: JSON.parse(JSON.stringify(body ?? null)) } })
          .catch(() => undefined);
      }
      return originalJson(body);
    };
    next();
  };
}
