import type { z } from 'zod';

/** Parse a body/query with a shared Zod schema. Throws ZodError, which the error handler shapes. */
export function body<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}

export function param(req: { params: Record<string, string> }, name: string): string {
  return req.params[name];
}
