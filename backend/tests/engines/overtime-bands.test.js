import { describe, expect, it } from 'vitest';
import { describeOvertimeRate, overtimeMultiplier, overtimeRulesSchema } from '@ajpwer/shared';
import { computeDay, overtimePay, resolvePolicies } from '../../src/calculations/index.js';
import { NINE_HOUR_DAY, OVERTIME, OVERTIME_FROM_SHIFT_END, policy, punch, R, SHIFT_BREAK, SHIFT_END, SHIFT_START } from './fixtures.js';

// 2× up to ₹20,000 gross, 1.5× from ₹20,001 to ₹50,000, 1× above.
const BANDS = [
  { upto_gross: R(20000), multiplier: 2 },
  { upto_gross: R(50000), multiplier: 1.5 },
  { upto_gross: null, multiplier: 1 },
];
const banded = (extra = {}) => overtimeRulesSchema.parse({ ...OVERTIME.rules, base: 'GROSS', divisor: 25, monthly_cap_min: null, gross_bands: BANDS, ...extra });

describe('Overtime multiplier by monthly gross', () => {
  it('picks the band for the gross, limits inclusive', () => {
    const r = banded();
    expect(overtimeMultiplier(r, R(15000))).toBe(2);
    expect(overtimeMultiplier(r, R(20000))).toBe(2);
    expect(overtimeMultiplier(r, R(20000) + 100)).toBe(1.5);
    expect(overtimeMultiplier(r, R(50000))).toBe(1.5);
    expect(overtimeMultiplier(r, R(80000))).toBe(1);
  });

  it('without bands, the one multiplier applies to everyone', () => {
    const r = overtimeRulesSchema.parse({ ...OVERTIME.rules });
    expect(r.gross_bands).toEqual([]);
    expect(overtimeMultiplier(r, R(15000))).toBe(2);
    expect(overtimeMultiplier(r, R(90000))).toBe(2);
  });

  it('pays each person at their band, on the base the policy selects', () => {
    // Gross base, 25 days × 8 hours: hourly = gross ÷ 200. One hour of overtime.
    const low = overtimePay(60, banded(), { basic: R(9000), hra: R(3000), gross: R(18000) }, 26);
    expect(low).toMatchObject({ multiplier: 2, hourly: R(90), amount: R(180) });
    const mid = overtimePay(60, banded(), { basic: R(20000), hra: R(8000), gross: R(40000) }, 26);
    expect(mid).toMatchObject({ multiplier: 1.5, hourly: R(200), amount: R(300) });
    // The base stays the policy's choice: Basic + HRA, while the band still reads gross.
    const comp = overtimePay(60, banded({ base: 'COMPONENTS', components: ['basic', 'hra'] }), { basic: R(10000), hra: R(4000), gross: R(25000) }, 26);
    expect(comp).toMatchObject({ multiplier: 1.5, base_monthly: R(14000), hourly: R(70), amount: R(105) });
  });

  it('describes the bands in words', () => {
    expect(describeOvertimeRate(banded())).toBe('2× up to ₹20,000 gross · 1.5× ₹20,001 – ₹50,000 · 1× above ₹50,000');
    expect(describeOvertimeRate(OVERTIME.rules)).toBe('2×');
  });

  it('rejects bands that are out of order or leave the top open-ended band out', () => {
    const bad = [
      [{ upto_gross: R(20000), multiplier: 2 }], // last band has a limit
      [{ upto_gross: R(50000), multiplier: 2 }, { upto_gross: R(20000), multiplier: 1.5 }, { upto_gross: null, multiplier: 1 }],
      [{ upto_gross: null, multiplier: 2 }, { upto_gross: null, multiplier: 1 }],
    ];
    for (const gross_bands of bad) expect(overtimeRulesSchema.safeParse({ ...OVERTIME.rules, gross_bands }).success).toBe(false);
    expect(overtimeRulesSchema.safeParse({ ...OVERTIME.rules, gross_bands: [{ upto_gross: null, multiplier: 1.5 }] }).success).toBe(true);
  });
});

describe('Overtime daily cap', () => {
  const at = (inAt, outAt) => [punch('2026-09-01', inAt, 'IN'), punch('2026-09-01', outAt, 'OUT')];
  const withCap = (daily_cap_min) => policy('OVERTIME', { ...OVERTIME_FROM_SHIFT_END.rules, daily_cap_min, monthly_cap_min: null });
  const run = (punches, ot) =>
    computeDay({
      date: '2026-09-01', joined_on: '2025-01-01', last_day: null, is_holiday: false, is_weekly_off: false, leave: null, punches,
      policies: resolvePolicies([NINE_HOUR_DAY, ot], '2026-09-01'), shift_start_min: SHIFT_START, shift_end_min: SHIFT_END, shift_break_min: SHIFT_BREAK,
    });

  it('counts at most the cap in one day and shows HR the rest', () => {
    // 09:00–22:00: four hours after the 18:00 shift end, capped at two.
    const d = run(at('09:00', '22:00'), withCap(120));
    expect(d.ot_min).toBe(120);
    expect(d.ot_capped_min).toBe(120);
    expect(d.flags).toContain('OT_DAILY_CAP');
  });

  it('under the cap, or with no cap, nothing changes', () => {
    expect(run(at('09:00', '19:00'), withCap(120))).toMatchObject({ ot_min: 60 });
    expect(run(at('09:00', '19:00'), withCap(120)).ot_capped_min).toBeUndefined();
    expect(run(at('09:00', '22:00'), withCap(null)).ot_min).toBe(240);
  });

  it('a daily cap above the monthly cap is refused', () => {
    expect(overtimeRulesSchema.safeParse({ ...OVERTIME.rules, monthly_cap_min: 60, daily_cap_min: 120 }).success).toBe(false);
  });
});
