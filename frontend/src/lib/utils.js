import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatINR, formatMinutes, formatLongDate, formatYearMonth } from '@ajpwer/shared';

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export const inr = (p, paise = false) => formatINR(p ?? null, { paise });
export const mins = formatMinutes;
export const longDate = (d) => (d ? formatLongDate(d) : '—');
export const monthLabel = formatYearMonth;

export function hhmm(minOfDay) {
  if (minOfDay === null || minOfDay === undefined) return '—';
  const m = ((minOfDay % 1440) + 1440) % 1440;
  const s = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return minOfDay >= 1440 ? `${s} (+1)` : s;
}

/** A timestamp shown in IST as 2026-09-30 08:04. */
export function istTime(iso, withDate = false) {
  if (!iso) return '—';
  const d = new Date(new Date(iso).getTime() + 330 * 60_000);
  const t = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return withDate ? `${d.toISOString().slice(0, 10)} ${t}` : t;
}

export function pct(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

export function plural(n, one, many = `${one}s`) {
  return `${n.toLocaleString('en-IN')} ${n === 1 ? one : many}`;
}

/** Rupees typed by a person → paise. */
export function toPaise(v) {
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export const toRupeesInput = (p) => (p === null || p === undefined ? '' : String(p / 100));

export const initials = (name) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
