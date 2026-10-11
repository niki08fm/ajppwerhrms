import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { STATUTORY_GRATUITY_RULES } from '@ajpwer/shared';
import { prisma } from '../../src/config/db.js';
import { hashPassword } from '../../src/services/auth.service.js';
import { toDbDate } from '../../src/utils/dbDates.js';
import { app, buildFixture } from './fixture.js';

let f;
const rules = { standard_min: 480, half_day_min: 240, grace_min: 15 };
const dateOf = (date) => date?.toISOString().slice(0, 10) ?? null;
const path = (row) => `/api/v1/policies/${row.policy_key}/versions/${row.version}`;
const historyPath = (row) => `/api/v1/policies/${row.policy_key}/versions`;
const liveRows = (key) => prisma.policy.findMany({ where: { policy_key: key, deleted_at: null }, orderBy: { version: 'asc' } });
beforeEach(async () => { f = await buildFixture(); });
afterAll(async () => { await prisma.$disconnect(); });

async function create({ kind = 'ATTENDANCE', name = 'Site attendance', valid_from = '2025-04-01', rules: bodyRules = rules } = {}) {
  const result = await f.agent.post('/api/v1/policies').send({ kind, name, valid_from, rules: bodyRules });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body.data;
}
async function publish(row, valid_from, bodyRules = row.rules) {
  const result = await f.agent.post(historyPath(row)).send({ valid_from, rules: bodyRules });
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body.data;
}
async function original(kind = 'ATTENDANCE') {
  return prisma.policy.findFirstOrThrow({ where: { kind, deleted_at: null } });
}
async function attach(row) {
  const group = (await f.agent.get(`/api/v1/pay-groups/${f.payGroupId}`)).body.data;
  const policy_ids = group.policies.filter((item) => item.kind !== row.kind).map((item) => item.id);
  policy_ids.push(row.id);
  const result = await f.agent.patch(`/api/v1/pay-groups/${f.payGroupId}`).send({ policy_ids });
  expect(result.status, JSON.stringify(result.body)).toBe(200);
}
async function freeze({ ym = '2026-08', state = 'LOCKED', finalMonth, snapshotGroup = f.payGroupId } = {}) {
  const period = await prisma.payrollPeriod.create({ data: { period_ym: ym, state: 'RUN' } });
  await prisma.payslip.create({ data: {
    period_id: period.id, employee_id: f.employees.A,
    gross: 2000000n, salary_gross: 2000000n, total_deductions: 0n, reimbursements: 0n, net: 2000000n,
    employer_total: 0n, ctc_month: 2000000n, pf_wage: 1000000n, esi_applicable: true,
    paid_days: 26, lop_days: 0, divisor: 26, computed_at: new Date(), engine_version: 'test',
    meta: { pay_group: { id: snapshotGroup }, ...(finalMonth ? { final_month_ym: finalMonth } : {}) },
  } });
  await prisma.payrollPeriod.update({ where: { id: period.id }, data: { state } });
  return period;
}
async function settlement({ state = 'INCLUDED', steps = [1, 2, 3, 4], separately = false } = {}) {
  const period = await prisma.payrollPeriod.create({ data: { period_ym: '2026-10', steps_submitted: steps } });
  await prisma.settlement.create({ data: {
    employee_id: f.employees.A, last_day: toDbDate('2026-08-20'), period_id: period.id,
    state, earnings: [], deductions: [], total_earnings: 0n, total_deductions: 0n, net: 0n,
    ...(separately ? { paid_separately: { paid_on: '2026-08-25', payment_ref: 'outside-payroll' } } : {}),
  } });
}

describe('Editing policy versions', () => {
  it('edits name and validated rules in place, retaining identity and auditing the before/after', async () => {
    const row = await create();
    const result = await f.agent.patch(path(row)).send({ name: ' Revised attendance ', rules: { ...rules, grace_min: 20 } });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data).toMatchObject({ id: row.id, policy_key: row.policy_key, version: 1, name: 'Revised attendance', rules: { ...rules, grace_min: 20 } });
    expect(await liveRows(row.policy_key)).toHaveLength(1);
    const event = await prisma.auditLog.findFirstOrThrow({ where: { entity_id: row.id, action: 'policy.edit' } });
    expect(event.detail).toMatchObject({ before: { name: 'Site attendance', version: 1 }, after: { name: 'Revised attendance', version: 1 } });
  });

  it('moves an effective start between neighbors and repairs only the predecessor end', async () => {
    const first = await create();
    const middle = await publish(first, '2026-10-01');
    const latest = await publish(first, '2026-12-01');
    const result = await f.agent.patch(path(middle)).send({ valid_from: '2026-11-01' });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect((await liveRows(first.policy_key)).map((row) => [row.id, dateOf(row.valid_from), dateOf(row.valid_to)])).toEqual([
      [first.id, '2025-04-01', '2026-10-31'], [middle.id, '2026-11-01', '2026-11-30'], [latest.id, '2026-12-01', null],
    ]);
  });

  it('rejects crossing/duplicate starts, invalid rules, unknown fields and blank changes atomically', async () => {
    const first = await create();
    const second = await publish(first, '2026-10-01');
    const before = await liveRows(first.policy_key);
    for (const body of [{ valid_from: '2025-04-01' }, { rules: { standard_min: -1 } }, { kind: 'LEAVE' }, { name: ' ' }, {}]) {
      expect((await f.agent.patch(path(second)).send(body)).status).toBe(422);
    }
    expect(await liveRows(first.policy_key)).toEqual(before);
    expect(await prisma.auditLog.count({ where: { action: 'policy.edit' } })).toBe(0);
  });

  it('does not normalize unrelated legacy gaps or finite end dates while changing a name', async () => {
    const first = await create();
    const second = await publish(first, '2026-10-01');
    await prisma.policy.update({ where: { id: first.id }, data: { valid_to: toDbDate('2026-07-31') } });
    await prisma.policy.update({ where: { id: second.id }, data: { valid_to: toDbDate('2026-11-15') } });
    expect((await f.agent.patch(path(second)).send({ name: 'Renamed finite version' })).status).toBe(200);
    expect((await liveRows(first.policy_key)).map((row) => dateOf(row.valid_to))).toEqual(['2026-07-31', '2026-11-15']);
  });
});

describe('Deleting policy versions', () => {
  it('soft-deletes a middle version, reconnects preceding coverage and retains historical links/audit', async () => {
    const first = await original();
    const middle = await publish(first, '2026-10-01');
    const latest = await publish(first, '2026-12-01');
    const result = await f.agent.delete(path(middle));
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data).toMatchObject({ id: middle.id, version: 2, deleted: true });
    expect((await liveRows(first.policy_key)).map((row) => [row.id, dateOf(row.valid_to)])).toEqual([[first.id, '2026-11-30'], [latest.id, null]]);
    expect((await prisma.policy.findUniqueOrThrow({ where: { id: middle.id } })).deleted_at).not.toBeNull();
    const link = await prisma.payGroupPolicy.findFirstOrThrow({ where: { policy_id: middle.id } });
    expect(link.deleted_at).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'policy.delete', entity_id: middle.id } })).toBe(1);
    expect((await f.agent.get(historyPath(first))).body.data.map((row) => row.version)).toEqual([3, 1]);
  });

  it('reopens the prior version after latest deletion and never reuses a deleted version number', async () => {
    const first = await create();
    const second = await publish(first, '2026-10-01');
    expect((await f.agent.delete(path(second))).status).toBe(200);
    expect((await liveRows(first.policy_key))[0].valid_to).toBeNull();
    const next = await publish(first, '2026-11-01');
    expect(next.version).toBe(3);
  });

  it('leaves later effective starts unchanged when deleting the first version', async () => {
    const first = await create();
    const next = await publish(first, '2026-10-01');
    expect((await f.agent.delete(path(first))).status).toBe(200);
    const history = await liveRows(first.policy_key);
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(next.id);
    expect(dateOf(history[0].valid_from)).toBe('2026-10-01');
  });

  it('allows unused sole-version cleanup but protects the only attached version until detached', async () => {
    const unused = await create();
    const before = await f.agent.get(historyPath(unused));
    expect(before.body.data[0]).toMatchObject({ can_edit: true, can_delete: true });
    expect((await f.agent.delete(path(unused))).status).toBe(200);
    expect((await f.agent.get(historyPath(unused))).status).toBe(404);
    const attached = await original();
    const history = await f.agent.get(historyPath(attached));
    expect(history.body.data[0]).toMatchObject({ can_edit: true, can_delete: false, deletion_reason: 'Remove this policy from its pay groups before deleting its only version.' });
    expect((await f.agent.delete(path(attached))).body.error.code).toBe('POLICY_ATTACHED');
    const group = (await f.agent.get(`/api/v1/pay-groups/${f.payGroupId}`)).body.data;
    expect((await f.agent.patch(`/api/v1/pay-groups/${f.payGroupId}`).send({ policy_ids: group.policies.filter((row) => row.id !== attached.id).map((row) => row.id) })).status).toBe(200);
    expect((await f.agent.delete(path(attached))).status).toBe(200);
  });

  it('restores prior rules for an API pay group that attached only the deleted latest version', async () => {
    const first = await original();
    const latest = await publish(first, '2026-10-01');
    await attach(latest);
    expect((await f.agent.delete(path(latest))).status).toBe(200);
    const group = (await f.agent.get(`/api/v1/pay-groups/${f.payGroupId}`)).body.data;
    expect(group.policies.filter((row) => row.policy_key === first.policy_key).map((row) => row.id)).toEqual([first.id]);
  });
});

describe('Frozen policy history and permissions', () => {
  it('protects locked pay and retroactive publishing while allowing a later new version', async () => {
    const first = await original();
    await freeze();
    const history = await f.agent.get(historyPath(first));
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    expect(history.body.data[0]).toMatchObject({ can_edit: false, can_delete: false });
    expect(history.body.data[0].protection_reason).toContain('locked payroll');
    const edit = await f.agent.patch(path(first)).send({ rules: { ...rules, grace_min: 30 } });
    expect(edit.status).toBe(409); expect(edit.body.error.code).toBe('POLICY_PROTECTED');
    const publishPast = await f.agent.post(historyPath(first)).send({ valid_from: '2026-08-15', rules });
    expect(publishPast.status).toBe(409); expect(publishPast.body.error.code).toBe('POLICY_PROTECTED');
    const later = await publish(first, '2026-10-01');
    expect(later.version).toBe(2);
  });

  it('rechecks moved start dates that would alter a frozen neighboring period', async () => {
    const first = await original();
    const future = await publish(first, '2026-09-15');
    await freeze();
    const history = await f.agent.get(historyPath(first));
    expect(history.body.data.find((row) => row.id === future.id).can_edit).toBe(true);
    const changed = await f.agent.patch(path(future)).send({ valid_from: '2026-08-20' });
    expect(changed.status).toBe(409); expect(changed.body.error.code).toBe('POLICY_PROTECTED');
    expect(dateOf((await prisma.policy.findUniqueOrThrow({ where: { id: future.id } })).valid_from)).toBe('2026-09-15');
  });

  it('retains protection after group detachment and employee movement, using the frozen final month/group', async () => {
    const first = await original();
    await freeze({ ym: '2026-10', state: 'PAID', finalMonth: '2026-08' });
    const group = await prisma.payGroup.findUniqueOrThrow({ where: { id: f.payGroupId } });
    const other = await prisma.payGroup.create({ data: { name: 'New group', calendar_method: 'ACTUAL', weekly_off: ['SUN'], shift_id: group.shift_id } });
    await prisma.employee.update({ where: { id: f.employees.A }, data: { pay_group_id: other.id } });
    await prisma.payGroupPolicy.updateMany({ where: { policy_id: first.id }, data: { deleted_at: new Date() } });
    const result = await f.agent.delete(path(first));
    expect(result.status).toBe(409); expect(result.body.error.code).toBe('POLICY_PROTECTED');
    expect(result.body.error.message).toContain('October 2026');
  });

  it('protects leave carry-forward from older versions and sandwich rules around the frozen month', async () => {
    const leave = await original('LEAVE');
    await publish(leave, '2026-08-01');
    const attendance = await original();
    const boundary = await publish(attendance, '2026-09-05');
    await freeze();
    const oldLeave = (await f.agent.get(historyPath(leave))).body.data.find((row) => row.id === leave.id);
    expect(oldLeave.can_edit).toBe(false);
    expect((await f.agent.patch(path(leave)).send({ name: 'Changed historic leave' })).body.error.code).toBe('POLICY_PROTECTED');
    const boundaryMetadata = (await f.agent.get(historyPath(attendance))).body.data.find((row) => row.id === boundary.id);
    expect(boundaryMetadata.can_edit).toBe(false);
    expect((await f.agent.patch(path(boundary)).send({ name: 'Changed sandwich context' })).status).toBe(409);
  });

  it.each([{ state: 'INCLUDED', separately: false }, { state: 'OPEN', separately: true }, { state: 'PAID', separately: false }])('protects finalized or separately paid F&F: $state / separately $separately', async (options) => {
    const row = await create({ kind: 'GRATUITY', rules: STATUTORY_GRATUITY_RULES });
    await attach(row);
    await settlement(options);
    const history = await f.agent.get(historyPath(row));
    expect(history.status, JSON.stringify(history.body)).toBe(200);
    expect(history.body.data[0].can_edit).toBe(false);
    const edited = await f.agent.patch(path(row)).send({ name: 'Changed settled gratuity' });
    expect(edited.status).toBe(409); expect(edited.body.error.code).toBe('POLICY_PROTECTED');
  });

  it('keeps paid-separate F&F calculation and its freeze atomic against a waiting policy edit', async () => {
    const gratuity = await create({ kind: 'GRATUITY', rules: { ...STATUTORY_GRATUITY_RULES, min_years: 1, flag_from_years: 0.5, base: 'GROSS', max_amount: null } });
    await attach(gratuity);
    expect((await f.agent.post(`/api/v1/employees/${f.employees.A}/resign`).send({ resigned_on: '2026-08-01', last_day: '2026-08-31', exit_reason: 'RESIGNATION' })).status).toBe(200);
    for (const code of ['HANDOVER', 'ASSETS', 'NO_DUES']) expect((await f.agent.post(`/api/v1/employees/${f.employees.A}/exit/tasks/${code}`).send({ done: true })).status).toBe(200);
    await prisma.payrollPeriod.create({ data: { period_ym: '2026-08' } });
    let releaseGate;
    let announceGate;
    const gateReady = new Promise((resolve) => { announceGate = resolve; });
    const release = new Promise((resolve) => { releaseGate = resolve; });
    const gate = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(20261011, 18)`;
      announceGate();
      await release;
    }, { timeout: 20_000 });
    await gateReady;
    let process;
    let edit;
    try {
      process = f.agent.post(`/api/v1/employees/${f.employees.A}/exit/process`).send({ period_ym: '2026-08', paid_separately: { paid_on: '2026-09-02', payment_ref: 'FNF-RACE' } }).then((response) => response);
      // The processing transaction holds its period while waiting for the
      // shared rules gate. A policy writer must wait for that same period.
      let waiting = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        const locks = await prisma.$queryRaw`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = 20261011::oid AND objid = 18::oid AND mode = 'ShareLock' AND NOT granted`;
        if (locks.length) { waiting = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting, 'F&F transaction must acquire the shared rules gate before calculating/finalizing').toBe(true);
      edit = f.agent.patch(path(gratuity)).send({ rules: { ...gratuity.rules, min_years: 3 } }).then((response) => response);
      releaseGate();
      const [processed, edited] = await Promise.all([process, edit]);
      expect(processed.status, JSON.stringify(processed.body)).toBe(200);
      expect(edited.status, JSON.stringify(edited.body)).toBe(409);
      expect(edited.body.error.code).toBe('POLICY_PROTECTED');
      const frozen = await prisma.settlement.findFirstOrThrow({ where: { employee_id: f.employees.A } });
      expect(frozen.state).toBe('INCLUDED');
      expect(frozen.paid_separately).toMatchObject({ payment_ref: 'FNF-RACE' });
      expect(frozen.earnings.find((line) => line.code === 'GRATUITY').amount).toBeGreaterThan(0);
      expect((await prisma.policy.findUniqueOrThrow({ where: { id: gratuity.id } })).rules.min_years).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: 'policy.edit', entity_id: gratuity.id } })).toBe(0);
    } finally {
      releaseGate();
      await gate;
      await Promise.allSettled([process, edit].filter(Boolean));
    }
  });

  it('rejects version writes without setup.write and validates lineage/version route identifiers', async () => {
    const row = await create();
    const role = await prisma.role.create({ data: { name: 'Read setup', permissions: ['setup.read'] } });
    await prisma.appUser.create({ data: { email: 'setup-reader@test.in', name: 'Reader', role_id: role.id, password_hash: await hashPassword('test-password-1') } });
    const reader = request.agent(app);
    expect((await reader.post('/api/v1/auth/login').send({ email: 'setup-reader@test.in', password: 'test-password-1' })).status).toBe(200);
    expect((await reader.get(historyPath(row))).status).toBe(200);
    expect((await reader.patch(path(row)).send({ name: 'Unauthorized' })).status).toBe(403);
    expect((await reader.delete(path(row))).status).toBe(403);
    expect((await f.agent.patch(`/api/v1/policies/not-a-key/versions/1`).send({ name: 'Bad key' })).status).toBe(422);
    expect((await f.agent.delete(`/api/v1/policies/${row.policy_key}/versions/not-a-version`)).status).toBe(422);
    expect((await f.agent.patch(`/api/v1/policies/${row.policy_key}/versions/999`).send({ name: 'Missing' })).status).toBe(404);
  });

  it('serializes competing publishers into one valid new version', async () => {
    const row = await create();
    const body = { valid_from: '2026-10-01', rules };
    const results = await Promise.all([f.agent.post(historyPath(row)).send(body), f.agent.post(historyPath(row)).send(body)]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 422]);
    expect((await liveRows(row.policy_key)).map((item) => item.version)).toEqual([1, 2]);
  });
});
