import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatINR, formatMinutes, formatLongDate, formatYearMonth, type Paise } from '@ajpwer/shared';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const inr = (p: Paise | null | undefined, paise = false) => formatINR(p ?? null, { paise });
export const mins = formatMinutes;
export const longDate = (d: string | null | undefined) => (d ? formatLongDate(d) : '—');
export const monthLabel = formatYearMonth;

export function hhmm(minOfDay: number | null | undefined): string {
  if (minOfDay === null || minOfDay === undefined) return '—';
  const m = ((minOfDay % 1440) + 1440) % 1440;
  const s = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return minOfDay >= 1440 ? `${s} (+1)` : s;
}

/** A timestamp shown in IST as 2026-09-30 08:04. */
export function istTime(iso: string | Date | null | undefined, withDate = false): string {
  if (!iso) return '—';
  const d = new Date(new Date(iso).getTime() + 330 * 60_000);
  const t = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return withDate ? `${d.toISOString().slice(0, 10)} ${t}` : t;
}

export function pct(n: number | null | undefined, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
}

/** Rupees typed by a person → paise. */
export function toPaise(v: string | number): number {
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export const toRupeesInput = (p: number | null | undefined) => (p === null || p === undefined ? '' : String(p / 100));

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
