import { describe, expect, it } from 'vitest';
import { waitingItems } from '../../src/services/approvals.service.js';

/**
 * The Approvals list: one list of what waits on HR, built from face exceptions, the day
 * registers of the last week, planned transfers, unreviewed site changes and pending leave. The database and
 * the day register are stand-ins here; the register's own rules are tested in attendance.test.js.
 */
const NOW = '2026-09-30';
const ELEC = { id: 'd-el', name: 'Electrical', colour: 'chart-1' };
const CIVIL = { id: 'd-cv', name: 'Civil', colour: 'chart-2' };
const people = {
  harish: { id: 'e-1', code: 'AJ0019', name: 'Harish Varma', department: ELEC },
  naresh: { id: 'e-2', code: 'AJ0012', name: 'Naresh Kumar', department: ELEC },
  padma: { id: 'e-3', code: 'AJ0014', name: 'Padma Rao', department: CIVIL },
  suresh: { id: 'e-4', code: 'AJ0002', name: 'Suresh Reddy', department: ELEC },
};

function mockDb({ frozenMonths = [], transfers = [] } = {}) {
  return {
    site: { findMany: async () => [{ id: 's-a', name: 'Alpha substation' }, { id: 's-b', name: 'Beta line camp' }] },
    employee: { findMany: async ({ where }) => Object.values(people).filter((p) => where.id.in.includes(p.id)) },
    payrollPeriod: { findUnique: async ({ where }) => (frozenMonths.includes(where.period_ym) ? { state: 'LOCKED', steps_submitted: [] } : null) },
    policy: { findMany: async () => [{ rules: { types: [{ code: 'SL', name: 'Sick Leave', paid: true }] } }] },
    faceException: {
      findMany: async () => [
        { id: 'fx-1', site_id: 's-a', site: { id: 's-a', name: 'Alpha substation' }, occurred_at: new Date('2026-09-30T04:02:00Z'), best_match_id: 'e-1', claimed_employee_id: null, score: '0.48', reason: 'Below threshold', direction: null, distance_m: 64, snapshot_key: null, kind: 'NOT_RECOGNISED', crop_keys: ['a', 'b', 'c'], claimed_name: null },
        { id: 'fx-2', site_id: 's-b', site: { id: 's-b', name: 'Beta line camp' }, occurred_at: new Date('2026-09-30T03:28:00Z'), best_match_id: null, claimed_employee_id: null, score: null, reason: 'Nobody close', direction: 'IN', distance_m: 12, snapshot_key: 'k', kind: 'NOT_RECOGNISED', crop_keys: [], claimed_name: null },
      ],
    },
    siteChange: {
      findMany: async () => [
        { id: 'sc-1', employee_id: 'e-3', work_date: new Date('2026-09-29T00:00:00Z'), from_site_id: 's-b', to_site_id: 's-a', left_at: new Date('2026-09-29T06:50:00Z'), arrived_at: new Date('2026-09-29T07:35:00Z'), status: 'COUNTED', travel_min: 45, hr_travel_min: null },
      ],
    },
    leaveRequest: {
      findMany: async () => [
        { id: 'lv-1', employee: people.padma, leave_type: 'SL', from_date: new Date('2026-10-01T00:00:00Z'), to_date: new Date('2026-10-02T00:00:00Z'), days: '2', reason: 'Fever', created_at: new Date('2026-09-28T02:40:00Z') },
      ],
    },
    siteTransferRequest: { findMany: async () => transfers },
  };
}

const row = (employee, day, extra = {}) => ({
  employee,
  day: { status: 'PRESENT', worked_min: 545, early_min: 0, late_min: 0, sites: ['s-a'], ...day },
  override: null,
  in_min: 530,
  out_min: 1075,
  open_now: false,
  context: { standard_min: 540 },
  ...extra,
});

/** A register: Naresh missed his punch-out yesterday, Suresh left early today, Harish is still in today. */
const register = async (_db, date) => {
  if (date === '2026-09-29') return [row(people.naresh, { status: 'MISSING_PUNCH', sites: ['s-b'] }), row(people.harish, {})];
  if (date === NOW)
    return [
      row(people.suresh, { status: 'HALF_DAY', worked_min: 391, early_min: 149 }),
      row(people.harish, { status: 'MISSING_PUNCH' }, { open_now: true }),
      row(people.padma, { status: 'HALF_DAY', worked_min: 400, early_min: 140 }, { override: { id: 'o-1' } }),
    ];
  return [];
};

describe('waiting items', () => {
  it('gathers every kind into one list, newest first', async () => {
    const items = await waitingItems(mockDb(), NOW, { fresh: true, register });
    expect(items.map((i) => i.id)).toEqual(['short:e-4:2026-09-30', 'face:fx-1', 'face:fx-2', 'miss:e-2:2026-09-29', 'move:sc-1', 'leave:lv-1']);
    const ats = items.map((i) => i.at);
    expect([...ats].sort().reverse()).toEqual(ats);
  });

  it('names a face check by its best match and keeps the evidence', async () => {
    const items = await waitingItems(mockDb(), NOW, { fresh: true, register });
    const fx = items.find((i) => i.id === 'face:fx-1');
    expect(fx.employee).toMatchObject({ name: 'Harish Varma', department: { id: 'd-el', colour: 'chart-1' } });
    expect(fx.site).toEqual({ id: 's-a', name: 'Alpha substation' });
    expect(fx.detail).toMatchObject({ exception_id: 'fx-1', score: 0.48, crops: 3, has_snapshot: false });
    expect(items.find((i) => i.id === 'face:fx-2').employee).toBeNull();
  });

  it('skips days still open, days HR already corrected, and today for missing punch-outs', async () => {
    const items = await waitingItems(mockDb(), NOW, { fresh: true, register });
    expect(items.some((i) => i.employee?.id === 'e-1' && i.kind !== 'face')).toBe(false);
    expect(items.some((i) => i.employee?.id === 'e-3' && i.kind === 'short')).toBe(false);
    const miss = items.find((i) => i.kind === 'miss');
    expect(miss).toMatchObject({ day: '2026-09-29', site: { id: 's-b', name: 'Beta line camp' } });
    expect(miss.detail).toMatchObject({ work_date: '2026-09-29', in_min: 530, sites: ['Beta line camp'] });
  });

  it('carries the short day, site change and leave details the decision needs', async () => {
    const items = await waitingItems(mockDb(), NOW, { fresh: true, register });
    expect(items.find((i) => i.kind === 'short').detail).toMatchObject({ worked_min: 391, early_min: 149, standard_min: 540, status: 'HALF_DAY' });
    expect(items.find((i) => i.kind === 'move').detail).toMatchObject({ site_change_id: 'sc-1', travel_min: 45, from_site: { name: 'Beta line camp' }, to_site: { name: 'Alpha substation' } });
    expect(items.find((i) => i.kind === 'leave').detail).toMatchObject({ leave_id: 'lv-1', leave_name: 'Sick Leave', from_date: '2026-10-01', to_date: '2026-10-02', days: 2 });
  });

  it('does not look in a month payroll has frozen', async () => {
    const asked = [];
    const spy = async (db, date) => {
      asked.push(date);
      return register(db, date);
    };
    await waitingItems(mockDb({ frozenMonths: ['2026-09'] }), '2026-10-02', { fresh: true, register: spy });
    expect(asked.sort()).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('includes planned transfers independently of punches or frozen attendance', async () => {
    const request = {
      id: 'tr-1', employee: people.harish, from_site_id: 's-a', to_site_id: 's-b', departure_date: new Date('2026-10-03T00:00:00Z'),
      reason: 'Electrical work at Beta', requested_by: 'tablet-alpha', requested_at: new Date('2026-09-30T07:00:00Z'), status: 'PENDING',
    };
    const db = mockDb({ frozenMonths: ['2026-09'], transfers: [request] });
    const queried = [];
    db.siteTransferRequest.findMany = async (query) => { queried.push(query); return [request]; };
    const asked = [];
    const items = await waitingItems(db, NOW, { fresh: true, register: async (_db, date) => { asked.push(date); return []; } });
    expect(asked).toEqual([]);
    expect(queried[0].where).toEqual({ status: 'PENDING' });
    expect(items[0]).toMatchObject({
      id: 'transfer:tr-1', kind: 'transfer', at: '2026-09-30T07:00:00.000Z', day: NOW,
      employee: people.harish, site: { id: 's-a', name: 'Alpha substation' },
      detail: { transfer_request_id: 'tr-1', from_site: { id: 's-a', name: 'Alpha substation' }, to_site: { id: 's-b', name: 'Beta line camp' }, departure_date: '2026-10-03', reason: 'Electrical work at Beta' },
    });
    expect(items.some((item) => item.kind === 'move')).toBe(true);
  });
});
