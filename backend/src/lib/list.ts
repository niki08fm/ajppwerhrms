import type { Request } from 'express';
import { listQuerySchema, type ListResponse } from '@ajpwer/shared';
import { AppError } from './errors';

/**
 * The list contract (spec §15): server-side everything, keyset pagination
 * (never OFFSET), page size 50/100/200, row count always returned.
 *
 *   where (sort_key, id) < (:last_sort, :last_id) order by sort_key desc, id desc limit 50
 */

export interface SortSpec {
  /** Public sort key, as it appears in ?sort= */
  key: string;
  /** Prisma field (possibly nested path like "department.name" is not supported — keep to scalar columns) */
  field: string;
  type: 'string' | 'number' | 'date' | 'bigint';
  /** The column can be null (sorted last) */
  nullable?: boolean;
}

export interface ParsedList {
  q: string | null;
  filter: Record<string, string | string[]>;
  sort: SortSpec;
  dir: 'asc' | 'desc';
  limit: number;
  cursor: { v: unknown; id: string } | null;
}

export function parseList(req: Request, sorts: SortSpec[], defaultSort: string): ParsedList {
  const parsed = listQuerySchema.parse(req.query);
  const raw = parsed.sort ?? defaultSort;
  const dir: 'asc' | 'desc' = raw.startsWith('-') ? 'desc' : 'asc';
  const key = raw.replace(/^-/, '');
  const sort = sorts.find((s) => s.key === key);
  if (!sort) throw new AppError('VALIDATION', `Cannot sort by "${key}". Sortable: ${sorts.map((s) => s.key).join(', ')}.`, 422, 'sort');
  let cursor: ParsedList['cursor'] = null;
  if (parsed.cursor) {
    try {
      cursor = JSON.parse(Buffer.from(parsed.cursor, 'base64url').toString('utf8'));
    } catch {
      throw new AppError('VALIDATION', 'The page cursor is not valid. Reload the list.', 422, 'cursor');
    }
  }
  const q = parsed.q?.trim() || null;
  return { q, filter: parsed.filter ?? {}, sort, dir, limit: parsed.limit ?? 50, cursor };
}

function decodeValue(v: unknown, type: SortSpec['type']): unknown {
  if (v === null || v === undefined) return null;
  if (type === 'date') return new Date(v as string);
  if (type === 'bigint') return BigInt(v as string);
  return v;
}

/** Prisma where-clause for "rows after the cursor" in the current sort order. */
export function keysetWhere(p: ParsedList): Record<string, unknown> | undefined {
  if (!p.cursor) return undefined;
  const op = p.dir === 'desc' ? 'lt' : 'gt';
  const v = decodeValue(p.cursor.v, p.sort.type);
  if (v === null) {
    // Nulls sort last; after a null only other nulls with a later id remain.
    return { AND: [{ [p.sort.field]: null }, { id: { [op]: p.cursor.id } }] };
  }
  const or: Record<string, unknown>[] = [{ [p.sort.field]: { [op]: v } }, { AND: [{ [p.sort.field]: v }, { id: { [op]: p.cursor.id } }] }];
  if (p.sort.nullable) or.push({ [p.sort.field]: null });
  return { OR: or };
}

export function keysetOrder(p: ParsedList): Record<string, unknown>[] {
  const first = p.sort.nullable ? { [p.sort.field]: { sort: p.dir, nulls: 'last' } } : { [p.sort.field]: p.dir };
  return [first, { id: p.dir }];
}

function encodeValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (v && typeof v === 'object' && 'toString' in v) return String(v);
  return v;
}

/** Fetch limit+1 rows, then call this to build the response. */
export function page<T extends { id: string }>(rows: T[], p: ParsedList, total: number, map?: (r: T) => unknown): ListResponse<unknown> {
  const hasMore = rows.length > p.limit;
  const slice = hasMore ? rows.slice(0, p.limit) : rows;
  const last = slice[slice.length - 1];
  const nextCursor =
    hasMore && last
      ? Buffer.from(JSON.stringify({ v: encodeValue((last as Record<string, unknown>)[p.sort.field]), id: last.id })).toString('base64url')
      : null;
  return { data: map ? slice.map(map) : slice, meta: { total, nextCursor } };
}

export function filterValues(f: Record<string, string | string[]>, key: string): string[] {
  const v = f[key];
  if (v === undefined || v === '') return [];
  return (Array.isArray(v) ? v : String(v).split(',')).map((s) => s.trim()).filter(Boolean);
}

export function filterOne(f: Record<string, string | string[]>, key: string): string | null {
  return filterValues(f, key)[0] ?? null;
}

/** CSV with a BOM so Excel opens Indian text and ₹ correctly. */
export function toCSV(rows: Record<string, unknown>[], columns: { key: string; label: string }[]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(r[c.key])).join(',')).join('\r\n');
  return '﻿' + head + '\r\n' + body + (rows.length ? '\r\n' : '');
}

/** Rupees with two decimals for exports — accountants' tools, not display. */
export const rupeesOut = (paise: number | bigint | null | undefined) => (paise === null || paise === undefined ? '' : (Number(paise) / 100).toFixed(2));
