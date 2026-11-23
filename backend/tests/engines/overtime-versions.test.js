import { describe, expect, it } from 'vitest';
import { assemblePayslip } from '../../src/calculations/index.js';
import { overtimeByVersion } from '../../src/services/payslip.service.js';
import { fullMonthTotals, OVERTIME, payslipInput, policy, R } from './fixtures.js';

const v1 = policy('OVERTIME', { ...OVERTIME.rules, multiplier: 1.5, monthly_cap_min: 600 }, '2025-04-01', '2026-09-15', 1);
const v2 = policy('OVERTIME', { ...OVERTIME.rules, multiplier: 2, monthly_cap_min: 600 }, '2026-09-16', null, 2);
const day = (date, ot_min, status = 'PRESENT') => ({ date, ot_min, status });

describe('Overtime paid under the version in force each day', () => {
  it('groups days by version and leaves a single-version month to the month-end policy', () => {
    const days = [day('2026-09-02', 120), day('2026-09-10', 180), day('2026-09-20', 240), day('2026-09-21', 60, 'WEEKLY_OFF')];
    const groups = overtimeByVersion([v1, v2], days, 540);
    expect(groups.map((g) => [g.id, g.ot_min, g.from, g.to])).toEqual([[v1.id, 300, '2026-09-02', '2026-09-10'], [v2.id, 240, '2026-09-20', '2026-09-20']]);
    expect(overtimeByVersion([v1, v2], [day('2026-09-20', 240)], 240)).toBeNull();
    // HR corrections changed the total: keep the month-level figure.
    expect(overtimeByVersion([v1, v2], days, 600)).toBeNull();
  });

  it('pays each part at its own multiplier, with one monthly cap across both', () => {
    const segments = [
      { rules: v1.rules, ot_min: 480, from: '2026-09-01', to: '2026-09-15' },
      { rules: v2.rules, ot_min: 300, from: '2026-09-16', to: '2026-09-30' },
    ];
    const input = payslipInput({ monthly_gross: R(30000), attendance: fullMonthTotals('2026-09', 30, { ot_min: 780 }), overtime_rules: v2.rules, overtime_segments: segments });
    const p = assemblePayslip(input);
    const lines = p.lines.filter((l) => l.kind === 'OT');
    expect(lines).toHaveLength(2);
    expect(lines[0].name).toMatch(/1.5×/);
    expect(lines[1].name).toMatch(/2×/);
    // 600 minutes cap: 480 under v1, then only 120 of v2's 300.
    expect(p.ot.paid_min).toBe(600);
    expect(p.ot.excess_min).toBe(180);
    expect(p.ot.segments.map((s) => s.paid_min)).toEqual([480, 120]);
    const single = assemblePayslip({ ...input, overtime_segments: null });
    expect(single.lines.filter((l) => l.kind === 'OT')).toHaveLength(1);
    // At 2× for all 600 minutes the month-end version would overpay the first half.
    expect(single.ot.amount).toBeGreaterThan(p.ot.amount);
  });
});
