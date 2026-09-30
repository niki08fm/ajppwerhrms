/** A Postgres `date` column round-trips through Prisma as UTC midnight. */
export function toDbDate(d) {
  return new Date(`${d}T00:00:00.000Z`);
}

export function fromDbDate(d) {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

export const n = (v) => (v === null || v === undefined ? 0 : Number(v));
