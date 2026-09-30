/**
 * Money is integer paise everywhere. ₹24,000.50 is 2400050.
 *
 * No floating point touches a money figure: percentages are converted once to
 * integer micro-percent (the same precision as the database's numeric(9,6))
 * and all multiplication and division is done in BigInt with explicit rounding.
 */

export type Paise = number;

export const PAISE_PER_RUPEE = 100;
const MICRO = 1_000_000n;

export type RoundMode = 'nearest' | 'up' | 'down';

function assertInt(n: number, label: string): void {
  if (!Number.isSafeInteger(n)) throw new Error(`${label} must be a safe integer, got ${n}`);
}

/** Whole rupees → paise. Accepts at most two decimals, e.g. rupees(24000.5). */
export function rupees(r: number): Paise {
  return Math.round(r * 100);
}

/** Paise → rupees as a number, for display only. */
export function toRupees(p: Paise): number {
  return p / 100;
}

/** Integer division of BigInts with a rounding mode. Denominator must be positive. */
function divBig(num: bigint, den: bigint, mode: RoundMode = 'nearest'): bigint {
  if (den <= 0n) throw new Error('denominator must be positive');
  const neg = num < 0n;
  const a = neg ? -num : num;
  let q = a / den;
  const r = a % den;
  if (r !== 0n) {
    if (mode === 'nearest') {
      if (r * 2n >= den) q += 1n;
    } else if (mode === 'up') {
      if (!neg) q += 1n;
    } else if (mode === 'down') {
      if (neg) q += 1n;
    }
  }
  return neg ? -q : q;
}

/** round(a × b ÷ c) in integer arithmetic. */
export function mulDiv(a: number, b: number, c: number, mode: RoundMode = 'nearest'): number {
  assertInt(a, 'a');
  assertInt(b, 'b');
  assertInt(c, 'c');
  return Number(divBig(BigInt(a) * BigInt(b), BigInt(c), mode));
}

/** round(a ÷ b). */
export function divRound(a: number, b: number, mode: RoundMode = 'nearest'): number {
  return mulDiv(a, 1, b, mode);
}

/** Convert a percentage like 12 or 0.75 or 8.33 to integer micro-percent. */
export function toMicroPct(pct: number | string): bigint {
  const s = typeof pct === 'number' ? pct.toFixed(6) : pct;
  const [whole, frac = ''] = s.split('.');
  const sign = whole.startsWith('-') ? -1n : 1n;
  const w = BigInt(whole.replace('-', '') || '0');
  const f = BigInt((frac + '000000').slice(0, 6));
  return sign * (w * MICRO + f);
}

/** amount × pct ÷ 100, rounded once. `pct` is a percentage (12 means 12%). */
export function pct(amount: Paise, percent: number | string, mode: RoundMode = 'nearest'): Paise {
  assertInt(amount, 'amount');
  return Number(divBig(BigInt(amount) * toMicroPct(percent), 100n * MICRO, mode));
}

/** Multiply an amount by a factor such as 1.5 or 2 (stored with six decimals). */
export function mulFactor(amount: Paise, factor: number | string, mode: RoundMode = 'nearest'): Paise {
  assertInt(amount, 'amount');
  return Number(divBig(BigInt(amount) * toMicroPct(factor), MICRO, mode));
}

/** Round a paise figure to whole rupees. */
export function roundRupee(p: Paise, mode: RoundMode = 'nearest'): Paise {
  assertInt(p, 'paise');
  return Number(divBig(BigInt(p), 100n, mode)) * 100;
}

export function sum(values: Paise[]): Paise {
  let t = 0;
  for (const v of values) {
    assertInt(v, 'value');
    t += v;
  }
  return t;
}

export function clampMin0(p: Paise): Paise {
  return p < 0 ? 0 : p;
}

/**
 * Day counts are kept in hundredths so half days and quarter-day penalties
 * stay exact: 1.5 days → 150.
 */
export function daysToHundredths(d: number): number {
  return Math.round(d * 100);
}

// ─── Formatting ────────────────────────────────────────────────────────────

function groupIndian(intPart: string): string {
  if (intPart.length <= 3) return intPart;
  const last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
}

export interface FormatOptions {
  /** Show paise (for payslip lines). Default false: whole rupees, rounded. */
  paise?: boolean;
  /** Omit the ₹ symbol. */
  bare?: boolean;
}

/**
 * ₹1,23,456 — Indian grouping. Negative reads −₹1,234 with a true minus sign.
 */
export function formatINR(p: Paise | bigint | null | undefined, opts: FormatOptions = {}): string {
  if (p === null || p === undefined) return '—';
  const n = typeof p === 'bigint' ? Number(p) : p;
  const neg = n < 0;
  const abs = Math.abs(n);
  let body: string;
  if (opts.paise) {
    const r = Math.floor(abs / 100);
    const ps = abs % 100;
    body = groupIndian(String(r)) + '.' + String(ps).padStart(2, '0');
  } else {
    body = groupIndian(String(Math.round(abs / 100)));
  }
  return (neg ? '−' : '') + (opts.bare ? '' : '₹') + body;
}

/** Parse "24,000.50" or "24000" (rupees) to paise. Returns null if not a number. */
export function parseRupees(input: string): Paise | null {
  const cleaned = input.replace(/[₹,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [w, f = ''] = cleaned.replace('-', '').split('.');
  const v = Number(w) * 100 + Number((f + '00').slice(0, 2));
  return cleaned.startsWith('-') ? -v : v;
}

/** 7h 45m — durations are never shown as decimals. */
export function formatMinutes(min: number | null | undefined): string {
  if (min === null || min === undefined) return '—';
  const neg = min < 0;
  const m = Math.abs(Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  const s = h > 0 ? (r > 0 ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
  return neg ? `−${s}` : s;
}

/** One decimal, e.g. "12.5%". */
export function formatPct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}
