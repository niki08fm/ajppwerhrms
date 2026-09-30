import type { ISODate } from '@ajpwer/shared';

/** A Postgres `date` column round-trips through Prisma as UTC midnight. */
export function toDbDate(d: ISODate): Date {
  return new Date(`${d}T00:00:00.000Z`);
}

export function fromDbDate(d: Date): ISODate;
export function fromDbDate(d: Date | null | undefined): ISODate | null;
export function fromDbDate(d: Date | null | undefined): ISODate | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

export const n = (v: bigint | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));
