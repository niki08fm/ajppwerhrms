import { describe, expect, it } from 'vitest';
import { assemblePayslip, assignWorkDate, computeDay, dayIntervals, overrideDiffers, pairPunches, projectLabourCost, resolvePolicies, runEmployeeMonth } from '../../src/calculations/index.js';
import { istMidnight, monthDates, dayName } from '@ajpwer/shared';
import { ATTENDANCE, fullDay, HOLIDAY_PAID, HOLIDAY_WORK, LATE, OVERTIME, payslipInput, policy, punch, R, SHIFT_START, WEEKOFF_PAID, WEEKOFF_SANDWICH } from './fixtures.js';

const day = (date, punches = fullDay(date), policies = [ATTENDANCE, OVERTIME], extra = {}) =>
  computeDay({
    date,
    joined_on: '2025-01-01',
    last_day: null,
    is_holiday: false,
    is_weekly_off: false,
    leave: null,
    punches,
    policies: resolvePolicies(policies, date),
    shift_start_min: SHIFT_START,
    ...extra,
  });

/** September 2026, Sundays off, full days on every working day unless changed. */
function september(overrides = {}, skip = []) {
  const punches = {};
  for (const d of monthDates('2026-09')) {
    if (dayName(d) === 'SUN' || skip.includes(d)) continue;
    punches[d] = fullDay(d);
  }
  return {
    ym: '2026-09',
    joined_on: '2025-01-01',
    last_day: null,
    weekly_off: ['SUN'],
    holidays: [],
    shift_start_min: SHIFT_START,
    policies: [ATTENDANCE, WEEKOFF_PAID, HOLIDAY_PAID],
    punches,
    leave: {},
    overrides: {},
    ...overrides,
  };
}

describe('Step 1 — pairing', () => {
  it('two INs with no OUT: the first closes unmatched, the day is MISSING_PUNCH at half value', () => {
    const d = day('2026-09-01', [punch('2026-09-01', '09:00', 'IN'), punch('2026-09-01', '09:05', 'IN'), punch('2026-09-01', '17:30', 'OUT')]);
    expect(d.pairs).toHaveLength(2);
    expect(d.pairs[0].out).toBeNull();
    expect(d.status).toBe('MISSING_PUNCH');
    expect(d.day_value).toBe(0.5);
  });

  it('an OUT with no IN is an orphan, flagged, never negative hours', () => {
    const r = pairPunches([punch('2026-09-01', '17:30', 'OUT')]);
    expect(r.orphan_outs).toHaveLength(1);
    expect(r.worked_min).toBe(0);
    const d = day('2026-09-01', [punch('2026-09-01', '17:30', 'OUT')]);
    expect(d.flags).toContain('ORPHAN_OUT');
    expect(d.worked_min).toBe(0);
  });

  it('break minutes are the gaps between pairs', () => {
    const r = pairPunches([punch('2026-09-01', '09:00', 'IN'), punch('2026-09-01', '13:00', 'OUT'), punch('2026-09-01', '13:45', 'IN'), punch('2026-09-01', '18:00', 'OUT')]);
    expect(r.worked_min).toBe(240 + 255);
    expect(r.break_min).toBe(45);
  });
});

describe('Step 2 — classification thresholds', () => {
  it('92% tolerance: 7h 55m of an 8h day is PRESENT, not half day', () => {
    const d = day('2026-09-01', [punch('2026-09-01', '09:00', 'IN'), punch('2026-09-01', '16:55', 'OUT')]);
    expect(d.status).toBe('PRESENT');
  });
  it('half day and short', () => {
    expect(day('2026-09-01', [punch('2026-09-01', '09:00', 'IN'), punch('2026-09-01', '13:30', 'OUT')]).status).toBe('HALF_DAY');
    expect(day('2026-09-01', [punch('2026-09-01', '09:00', 'IN'), punch('2026-09-01', '10:00', 'OUT')]).status).toBe('SHORT');
  });
  it('before joining is NOT_JOINED, after the last day is EXITED', () => {
    expect(day('2026-09-01', [], [ATTENDANCE], { joined_on: '2026-09-10' }).status).toBe('NOT_JOINED');
    expect(day('2026-09-20', [], [ATTENDANCE], { last_day: '2026-09-15' }).status).toBe('EXITED');
  });
  it('a gap between policy versions falls back to the documented default and flags, never crashes', () => {
    const d = day('2026-09-01', fullDay('2026-09-01'), []);
    expect(d.flags).toContain('NO_ATTENDANCE_POLICY');
    expect(d.status).toBe('PRESENT');
  });
});

describe('§20.17 Cross-site day', () => {
  it('one day valued by total hours, both sites recorded, cost split by minutes between two projects', () => {
    const d = day('2026-09-02', [
      punch('2026-09-02', '08:00', 'IN', 'alpha'),
      punch('2026-09-02', '12:00', 'OUT', 'alpha'),
      punch('2026-09-02', '13:00', 'IN', 'beta'),
      punch('2026-09-02', '17:00', 'OUT', 'beta'),
    ]);
    expect(d.status).toBe('PRESENT');
    expect(d.worked_min).toBe(480);
    expect(d.sites).toEqual(['alpha', 'beta']);
    expect(d.cross_site).toBe(true);

    const cost = projectLabourCost([{ employee_id: 'e1', ctc_month: R(30000), intervals: dayIntervals(d) }], { alpha: 'P-ALPHA', beta: 'P-BETA' });
    const alpha = cost.find((c) => c.project_id === 'P-ALPHA');
    const beta = cost.find((c) => c.project_id === 'P-BETA');
    expect(alpha.minutes).toBe(240);
    expect(beta.minutes).toBe(240);
    expect(alpha.cost).toBe(R(15000));
    expect(beta.cost).toBe(R(15000));
  });
});

describe('§20.18 Policy versioning', () => {
  it('grace 15 → 10 minutes from 1 April leaves March untouched and changes April', () => {
    const v1 = policy('ATTENDANCE', { standard_min: 480, half_day_min: 240, grace_min: 15 }, '2025-04-01', '2026-03-31', 1);
    const v2 = policy('ATTENDANCE', { standard_min: 480, half_day_min: 240, grace_min: 10 }, '2026-04-01', null, 2);
    const march = day('2026-03-31', [punch('2026-03-31', '09:12', 'IN'), punch('2026-03-31', '17:30', 'OUT')], [v1, v2]);
    const april = day('2026-04-01', [punch('2026-04-01', '09:12', 'IN'), punch('2026-04-01', '17:30', 'OUT')], [v1, v2]);
    expect(march.late_min).toBe(0);
    expect(april.late_min).toBe(2);
  });

  it('two overlapping versions: the later valid_from covering the date wins', () => {
    const a = policy('ATTENDANCE', { standard_min: 480, half_day_min: 240, grace_min: 15 }, '2025-01-01', null, 1);
    const b = policy('ATTENDANCE', { standard_min: 480, half_day_min: 240, grace_min: 5 }, '2026-06-01', null, 2);
    expect(resolvePolicies([a, b], '2026-05-31').attendance.grace_min).toBe(15);
    expect(resolvePolicies([a, b], '2026-06-01').attendance.grace_min).toBe(5);
  });
});

describe('§20.19 Sandwich rule', () => {
  // Saturday 12 and Monday 14 September 2026, Sunday 13 off.
  it('absent Saturday and Monday with Sunday off: three days LOP under a sandwich policy', () => {
    const m = runEmployeeMonth(september({ policies: [ATTENDANCE, WEEKOFF_SANDWICH, HOLIDAY_PAID] }, ['2026-09-12', '2026-09-14']));
    expect(m.totals.lop_days).toBe(3);
    expect(m.totals.sandwiched).toEqual(['2026-09-13']);
  });
  it('two days without it', () => {
    const m = runEmployeeMonth(september({}, ['2026-09-12', '2026-09-14']));
    expect(m.totals.lop_days).toBe(2);
  });
  it('approved leave on either side does not trigger it', () => {
    const m = runEmployeeMonth(september({ policies: [ATTENDANCE, WEEKOFF_SANDWICH, HOLIDAY_PAID], leave: { '2026-09-12': { leave_type: 'CL', paid: true } } }, ['2026-09-12', '2026-09-14']));
    expect(m.totals.sandwiched).toEqual([]);
    expect(m.totals.lop_days).toBe(1);
  });
  it('an override on the off day wins over the sandwich rule', () => {
    const m = runEmployeeMonth(
      september(
        {
          policies: [ATTENDANCE, WEEKOFF_SANDWICH, HOLIDAY_PAID],
          overrides: { '2026-09-13': { status: 'WEEKLY_OFF', day_value: 1, worked_min: 0, ot_min: 0, late_min: 0 } },
        },
        ['2026-09-12', '2026-09-14'],
      ),
    );
    expect(m.totals.sandwiched).toEqual([]);
    expect(m.totals.lop_days).toBe(2);
  });
});

describe('§20.20 Off-day work', () => {
  it('working a holiday adds one extra line paying the difference up to the rate; the day is untouched', () => {
    const input = september({
      holidays: ['2026-09-17'],
      policies: [ATTENDANCE, OVERTIME, WEEKOFF_PAID, HOLIDAY_PAID, HOLIDAY_WORK],
    });
    input.punches['2026-09-17'] = [punch('2026-09-17', '08:00', 'IN'), punch('2026-09-17', '19:00', 'OUT')];
    const m = runEmployeeMonth(input);
    const d = m.days.find((x) => x.date === '2026-09-17');
    expect(d.status).toBe('HOLIDAY_WORKED');
    expect(d.day_value).toBe(1);
    expect(d.ot_min).toBe(0); // 11 hours on a holiday is never overtime as well
    expect(m.offday_work).toHaveLength(1);
    expect(m.totals.paid_days).toBe(30);

    const p = assemblePayslip(payslipInput({ attendance: m.totals, offday_work: m.offday_work, overtime_rules: OVERTIME.rules }));
    const lines = p.lines.filter((l) => l.kind === 'OFFDAY');
    expect(lines).toHaveLength(1);
    expect(lines[0].name).toMatch(/17 September 2026/);
    expect(lines[0].name).toMatch(/200% — normal day plus one extra day/);
    // At 2× the person ends up with two days' pay in total: one inside salary, one extra.
    expect(lines[0].amount).toBe(Math.round(R(24000) / 26));
    // The holiday's 11 hours add nothing to overtime: OT is the same as a month without the holiday worked.
    const withoutHoliday = september({ holidays: ['2026-09-17'], policies: [ATTENDANCE, OVERTIME, WEEKOFF_PAID, HOLIDAY_PAID, HOLIDAY_WORK] });
    expect(m.totals.ot_min).toBe(runEmployeeMonth(withoutHoliday).totals.ot_min);
  });

  it('an unpaid off day worked pays the full rate instead', () => {
    const input = september({ policies: [ATTENDANCE, HOLIDAY_PAID, HOLIDAY_WORK] }); // no weekly-off pay policy → Sundays unpaid
    input.punches['2026-09-06'] = fullDay('2026-09-06');
    const m = runEmployeeMonth(input);
    expect(m.offday_work[0].day_paid).toBe(false);
    const p = assemblePayslip(payslipInput({ attendance: m.totals, offday_work: m.offday_work }));
    expect(p.lines.find((l) => l.kind === 'OFFDAY').amount).toBe(Math.round((R(24000) * 2) / 26));
  });
});

describe('§20.21 Late penalty is monthly', () => {
  const lateOn = (dates) => {
    const input = september({ policies: [ATTENDANCE, WEEKOFF_PAID, HOLIDAY_PAID, LATE] });
    for (const d of dates) input.punches[d] = [punch(d, '09:40', 'IN'), punch(d, '18:00', 'OUT')];
    return runEmployeeMonth(input);
  };
  it('three lates with a free-three policy cost nothing', () => {
    const m = lateOn(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(m.totals.late_days).toBe(3);
    expect(m.totals.late_penalty_days).toBe(0);
  });
  it('the fourth costs by its slab', () => {
    const m = lateOn(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
    expect(m.totals.late_penalty_days).toBe(0.25); // 25 minutes late → 1–30 slab
    expect(m.totals.paid_days).toBe(29.75);
    expect(m.days.find((d) => d.date === '2026-09-04').late_penalty_days).toBe(0.25);
  });
});

describe('§20.22 / §20.23 Overrides', () => {
  it('an override changes the effective day, leaves the computed day intact, and stores both; revert restores exactly', () => {
    const base = september({}, ['2026-09-08']);
    const before = runEmployeeMonth(base);
    const computed = before.days.find((d) => d.date === '2026-09-08');
    expect(computed.status).toBe('ABSENT');

    const after = runEmployeeMonth({ ...base, overrides: { '2026-09-08': { status: 'PRESENT', day_value: 1, worked_min: 480, ot_min: 0, late_min: 0 } } });
    const eff = after.days.find((d) => d.date === '2026-09-08');
    expect(eff.status).toBe('PRESENT');
    expect(eff.overridden).toBe(true);
    expect(eff.computed).toEqual({ status: 'ABSENT', day_value: 0, worked_min: 0, ot_min: 0, late_min: 0 });
    expect(after.totals.paid_days).toBe(before.totals.paid_days + 1);

    const reverted = runEmployeeMonth(base);
    expect(reverted.totals).toEqual(before.totals);
  });

  it('an override that changes nothing is rejected', () => {
    const c = { status: 'PRESENT', day_value: 1, worked_min: 510, ot_min: 0, late_min: 0 };
    expect(overrideDiffers(c, { ...c })).toBe(false);
    expect(overrideDiffers(c, { ...c, late_min: 5 })).toBe(true);
  });
});

describe('§20.24 Overnight shift', () => {
  it('an out-punch at 01:30 closing an IN from the previous evening belongs to the previous work date', () => {
    const inAt = new Date(istMidnight('2026-09-10').getTime() + 20 * 60 * 60_000); // 20:00 on the 10th
    const outAt = new Date(istMidnight('2026-09-11').getTime() + 90 * 60_000); // 01:30 on the 11th
    expect(assignWorkDate(outAt, 'OUT', { direction: 'IN', work_date: '2026-09-10', at: inAt.getTime() })).toBe('2026-09-10');
    // An IN at 01:30 is a new day.
    expect(assignWorkDate(outAt, 'IN', { direction: 'IN', work_date: '2026-09-10', at: inAt.getTime() })).toBe('2026-09-11');
    // No open IN: the calendar date in IST.
    expect(assignWorkDate(outAt, 'OUT', null)).toBe('2026-09-11');

    const d = day('2026-09-10', [punch('2026-09-10', '20:00', 'IN'), { ...punch('2026-09-11', '01:30', 'OUT'), work_date: '2026-09-10' }]);
    expect(d.worked_min).toBe(330);
    expect(d.pairs[0].out).not.toBeNull();
  });

  it('work date is derived in Asia/Kolkata: 00:30 IST is the new day even though it is the previous day in UTC', () => {
    const at = new Date('2026-09-10T19:00:00Z'); // 00:30 IST on the 11th
    expect(assignWorkDate(at, 'IN', null)).toBe('2026-09-11');
  });
});
