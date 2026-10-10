import { describe, expect, it, vi } from 'vitest';
import { calculateManualFaceFailureStreak, getManualFaceFailureStreak } from '../../src/services/face-failure-streak.service.js';

const EMPLOYEE = 'employee-a';
const NOW = new Date('2026-10-11T06:00:00Z');
const empty = { days: 0, latest_date: null, requires_review: false, dates: [] };

function failure(day, suffix = '') {
  const id = `exception-${day}${suffix}`;
  return {
    exception: { id, punch_id: `punch-${day}${suffix}`, decided_employee_id: EMPLOYEE,
      status: 'APPROVED', kind: 'FAILED_TRIES', decided_at: `${day}T05:00:00Z`, deleted_at: null },
    punch: { id: `punch-${day}${suffix}`, employee_id: EMPLOYEE, work_date: new Date(`${day}T00:00:00Z`),
      punched_at: `${day}T04:00:00Z`, method: 'EXCEPTION', source_ref: id, deleted_at: null },
  };
}

function face(day) {
  return { id: `face-${day}`, employee_id: EMPLOYEE, work_date: new Date(`${day}T00:00:00Z`),
    punched_at: `${day}T04:00:00Z`, method: 'FACE', source_ref: null, deleted_at: null };
}

function calculate(days, { change = () => {}, additionalPunches = [], now = NOW } = {}) {
  const pairs = days.map((day) => failure(day));
  change(pairs);
  return calculateManualFaceFailureStreak({
    exceptions: pairs.map((p) => p.exception), punches: [...pairs.map((p) => p.punch), ...additionalPunches], employeeId: EMPLOYEE, now,
  });
}

describe('approved manual face failure streak', () => {
  it('suggests review only after more than three distinct consecutive days', () => {
    expect(calculate(['2026-10-09', '2026-10-10', '2026-10-11'])).toMatchObject({ days: 3, requires_review: false });
    expect(calculate(['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'])).toEqual({
      days: 4, latest_date: '2026-10-11', requires_review: true,
      dates: ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'],
    });
  });

  it('counts multiple approved IN/OUT requests on the same day once', () => {
    const pairs = ['2026-10-10', '2026-10-11'].flatMap((day) => [failure(day, '-in'), failure(day, '-out')]);
    expect(calculateManualFaceFailureStreak({ exceptions: pairs.map((p) => p.exception), punches: pairs.map((p) => p.punch), employeeId: EMPLOYEE, now: NOW }))
      .toMatchObject({ days: 2, requires_review: false, dates: ['2026-10-10', '2026-10-11'] });
  });

  it('keeps yesterday-ending streaks fresh before today has an approved failure', () => {
    expect(calculate(['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'])).toMatchObject({ days: 4, latest_date: '2026-10-10', requires_review: true });
  });

  it('does not skip a calendar gap or weekly off to invent consecutive days', () => {
    expect(calculate(['2026-10-06', '2026-10-07', '2026-10-09', '2026-10-10', '2026-10-11']))
      .toMatchObject({ days: 3, requires_review: false, dates: ['2026-10-09', '2026-10-10', '2026-10-11'] });
  });

  it('does not suggest a historical streak that ended before yesterday', () => {
    expect(calculate(['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'])).toEqual(empty);
  });

  it.each(['PENDING', 'REJECTED'])('does not count %s requests as approved failure days', (status) => {
    expect(calculate(['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'], { change: (pairs) => { pairs[1].exception.status = status; } }))
      .toMatchObject({ days: 2, requires_review: false, dates: ['2026-10-10', '2026-10-11'] });
  });

  it('requires a live linked EXCEPTION punch, not an orphan approval or plain manual attendance', () => {
    const invalidations = [
      (pair) => { pair.exception.punch_id = 'missing-punch'; },
      (pair) => { pair.punch.method = 'MANUAL'; },
      (pair) => { pair.punch.source_ref = 'different-exception'; },
      (pair) => { pair.punch.deleted_at = NOW; },
      (pair) => { pair.exception.deleted_at = NOW; },
      (pair) => { pair.exception.kind = 'NOT_RECOGNISED'; },
    ];
    for (const invalidate of invalidations) {
      expect(calculate(['2026-10-11'], { change: (pairs) => invalidate(pairs[0]) })).toEqual(empty);
    }
  });

  it('uses the employee actually approved by HR and ignores another employee’s punches', () => {
    expect(calculate(['2026-10-11'], { change: (pairs) => { pairs[0].exception.decided_employee_id = 'employee-b'; } })).toEqual(empty);
    expect(calculate(['2026-10-11'], { change: (pairs) => { pairs[0].punch.employee_id = 'employee-b'; } })).toEqual(empty);
  });

  it('breaks a streak on a successful real FACE punch even when that day also had failures', () => {
    expect(calculate(['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'], { additionalPunches: [face('2026-10-09')] }))
      .toMatchObject({ days: 2, requires_review: false });
    expect(calculate(['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'], { additionalPunches: [face('2026-10-11')] })).toEqual(empty);
  });

  it('a successful FACE punch today closes a manual streak that ended yesterday', () => {
    expect(calculate(['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'], { additionalPunches: [face('2026-10-11')] })).toEqual(empty);
  });

  it('uses IST today and the punch work date for an approved overnight OUT', () => {
    // The October 10 shift ends at 00:15 IST on October 11; never count it as a new failure day.
    const now = new Date('2026-10-10T19:00:00Z');
    expect(calculate(['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'], {
      now, change: (pairs) => {
        pairs[3].punch.punched_at = '2026-10-10T18:45:00Z';
        pairs[3].exception.decided_at = '2026-10-10T18:50:00Z';
      },
    })).toMatchObject({ days: 4, latest_date: '2026-10-10', requires_review: true });
  });

  it('ignores future punches and approvals and never extends a streak with them', () => {
    expect(calculate(['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']))
      .toMatchObject({ days: 4, latest_date: '2026-10-11' });
    expect(calculate(['2026-10-11'], { change: (pairs) => { pairs[0].exception.decided_at = '2026-10-12T00:00:00Z'; } })).toEqual(empty);
    expect(calculate(['2026-10-11'], { change: (pairs) => { pairs[0].punch.punched_at = '2026-10-11T07:00:00Z'; } })).toEqual(empty);
  });

  it('reads only one employee’s recent actual punches and their linked approved failures', async () => {
    const pairs = ['2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'].map((day) => failure(day));
    const db = { punch: { findMany: vi.fn().mockResolvedValue(pairs.map((p) => p.punch)) },
      faceException: { findMany: vi.fn().mockResolvedValue(pairs.map((p) => p.exception)) } };
    expect(await getManualFaceFailureStreak(db, EMPLOYEE, NOW)).toMatchObject({ days: 4, requires_review: true });
    expect(db.punch.findMany.mock.calls[0][0].where).toEqual({
      employee_id: EMPLOYEE, deleted_at: null, method: { in: ['FACE', 'EXCEPTION'] },
      work_date: { gte: new Date('2026-09-12T00:00:00Z'), lte: new Date('2026-10-11T00:00:00Z') }, punched_at: { lte: NOW },
    });
    expect(db.faceException.findMany.mock.calls[0][0].where).toEqual({
      decided_employee_id: EMPLOYEE, status: 'APPROVED', kind: 'FAILED_TRIES', deleted_at: null,
      punch_id: { in: pairs.map((p) => p.punch.id) }, decided_at: { lte: NOW },
    });
  });

  it('skips exception lookup when there are no exception-method punches', async () => {
    const db = { punch: { findMany: vi.fn().mockResolvedValue([face('2026-10-11')]) }, faceException: { findMany: vi.fn() } };
    expect(await getManualFaceFailureStreak(db, EMPLOYEE, NOW)).toEqual(empty);
    expect(db.faceException.findMany).not.toHaveBeenCalled();
  });
});
