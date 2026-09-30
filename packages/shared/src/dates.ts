/**
 * Date helpers. A "date" in this system is a calendar date string YYYY-MM-DD.
 * All arithmetic goes through UTC-midnight Date objects so DST and the host
 * timezone can never shift a day. Never add 86_400_000 to a timestamp.
 *
 * Work dates are derived in Asia/Kolkata (UTC+05:30, no DST).
 */

export type ISODate = string; // YYYY-MM-DD
export type YearMonth = string; // YYYY-MM

export const IST_OFFSET_MIN = 330;

export const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;
export type DayName = (typeof DAY_NAMES)[number];

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YM_RE = /^(\d{4})-(\d{2})$/;

export function isISODate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function isYearMonth(s: string): boolean {
  const m = YM_RE.exec(s);
  return !!m && +m[2] >= 1 && +m[2] <= 12;
}

export function parseDate(s: ISODate): Date {
  const m = DATE_RE.exec(s);
  if (!m) throw new Error(`Invalid date: ${s}`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

export function formatDate(d: Date): ISODate {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

export function addDays(date: ISODate, n: number): ISODate {
  const d = parseDate(date);
  d.setUTCDate(d.getUTCDate() + n);
  return formatDate(d);
}

/** b − a in whole days. */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86_400_000);
}

export function compareDate(a: ISODate, b: ISODate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return a < b ? a : b;
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return a > b ? a : b;
}

export function dayName(date: ISODate): DayName {
  return DAY_NAMES[parseDate(date).getUTCDay()];
}

export function ymOf(date: ISODate): YearMonth {
  return date.slice(0, 7);
}

export function daysInMonth(ym: YearMonth): number {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function firstOfMonth(ym: YearMonth): ISODate {
  return `${ym}-01`;
}

export function lastOfMonth(ym: YearMonth): ISODate {
  return `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`;
}

export function monthDates(ym: YearMonth): ISODate[] {
  const n = daysInMonth(ym);
  const out: ISODate[] = [];
  for (let i = 1; i <= n; i++) out.push(`${ym}-${String(i).padStart(2, '0')}`);
  return out;
}

export function addMonths(ym: YearMonth, n: number): YearMonth {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthIndex(ym: YearMonth): number {
  return Number(ym.slice(5, 7));
}

/** "September 2026" */
export function formatYearMonth(ym: YearMonth): string {
  return `${MONTH_NAMES[monthIndex(ym) - 1]} ${ym.slice(0, 4)}`;
}

/** "30 September 2026" — for prose and letters. */
export function formatLongDate(date: ISODate): string {
  const d = parseDate(date);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Calendar date of an instant in Asia/Kolkata. */
export function istDate(instant: Date): ISODate {
  return formatDate(new Date(instant.getTime() + IST_OFFSET_MIN * 60_000));
}

/** Minutes since IST midnight for an instant (0–1439). */
export function istMinuteOfDay(instant: Date): number {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MIN * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** The UTC instant of IST midnight at the start of a date. */
export function istMidnight(date: ISODate): Date {
  return new Date(parseDate(date).getTime() - IST_OFFSET_MIN * 60_000);
}

/** Financial year (April–March) a date or month falls in, as its starting year. */
export function financialYearStart(dateOrYm: string): number {
  const y = Number(dateOrYm.slice(0, 4));
  const m = Number(dateOrYm.slice(5, 7));
  return m >= 4 ? y : y - 1;
}

/** "2026-27" */
export function financialYearLabel(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Months of the financial year starting April `startYear`. */
export function financialYearMonths(startYear: number): YearMonth[] {
  const out: YearMonth[] = [];
  for (let i = 0; i < 12; i++) out.push(addMonths(`${startYear}-04`, i));
  return out;
}

/**
 * ESI contribution periods run April–September and October–March. Returns the
 * first and last date of the block containing the date.
 */
export function esiContributionPeriod(date: ISODate): { start: ISODate; end: ISODate } {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  if (m >= 4 && m <= 9) return { start: `${y}-04-01`, end: `${y}-09-30` };
  if (m >= 10) return { start: `${y}-10-01`, end: `${y + 1}-03-31` };
  return { start: `${y - 1}-10-01`, end: `${y}-03-31` };
}

/**
 * Completed service between two dates as years + months + days, and a decimal
 * years figure for thresholds.
 */
export function serviceLength(from: ISODate, to: ISODate): { years: number; months: number; days: number; decimalYears: number } {
  const a = parseDate(from);
  const b = parseDate(to);
  let years = b.getUTCFullYear() - a.getUTCFullYear();
  let months = b.getUTCMonth() - a.getUTCMonth();
  let days = b.getUTCDate() - a.getUTCDate();
  if (days < 0) {
    months -= 1;
    days += new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 0)).getUTCDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return { years, months, days, decimalYears: diffDays(from, to) / 365.25 };
}
