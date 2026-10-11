import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { prisma } from '../../src/config/db.js';
import { invalidatePrincipal } from '../../src/middleware/auth.js';
import { assertDepartmentAssignable } from '../../src/services/department.service.js';
import { toDbDate } from '../../src/utils/dbDates.js';
import { app, buildFixture, R } from './fixture.js';

let f;
beforeEach(async () => { f = await buildFixture(); invalidatePrincipal(); });
afterAll(async () => { await prisma.$disconnect(); });
const url = (id) => `/api/v1/departments${id ? `/${id}` : ''}`;
const create = (body) => f.agent.post(url()).send(body);
const current = async (id) => (await f.agent.get(url())).body.data.find((d) => d.id === id);
const employeeBody = (department_id) => ({ name: 'New department employee', gender: 'MALE', phone: '9000000000',
  department_id, designation: 'Engineer', pay_group_id: f.payGroupId, joined_on: '2026-10-01', status: 'ACTIVE',
  pt_state: 'Andhra Pradesh', salary: { mode: 'GROSS', amount: R(24000), structure_id: f.structureId } });
const offerBody = (department_id) => ({ name: 'New department offer', gender: 'MALE', phone: '9000000000',
  department_id, designation: 'Engineer', pay_group_id: f.payGroupId, mode: 'GROSS', amount: R(24000),
  structure_id: f.structureId, join_by: '2026-11-01', valid_till: '2026-10-31', pt_state: 'Andhra Pradesh' });

describe('Department settings', () => {
  it('shows active headcount separately from all linked records, including exited and archived people', async () => {
    expect(await current(f.deptId)).toMatchObject({ headcount: 3, assigned_count: 5, can_delete: false });
    await prisma.employee.updateMany({ where: { department_id: f.deptId }, data: { status: 'EXITED' } });
    await prisma.employee.update({ where: { id: f.employees.A }, data: { deleted_at: new Date() } });
    expect(await current(f.deptId)).toMatchObject({ headcount: 0, assigned_count: 5, can_delete: false });
    const r = await f.agent.delete(url(f.deptId));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'DEPARTMENT_IN_USE', details: { assigned_count: 5 } });
    expect(await prisma.department.findUnique({ where: { id: f.deptId } })).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { entity_id: f.deptId, action: 'department.delete' } })).toBe(0);
  });

  it('creates a trimmed name and edits a linked department without changing its employee links', async () => {
    const c = await create({ name: '  Civil  ', colour: 'chart-3' });
    expect(c.status).toBe(201);
    expect(c.body.data).toMatchObject({ name: 'Civil', colour: 'chart-3', headcount: 0, assigned_count: 0, can_delete: true });
    const r = await f.agent.patch(url(f.deptId)).send({ name: '  Electrical works  ', colour: 'chart-2' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: f.deptId, name: 'Electrical works', colour: 'chart-2', assigned_count: 5 });
    expect(await prisma.employee.count({ where: { department_id: f.deptId } })).toBe(5);
    expect(await prisma.auditLog.count({ where: { action: 'department.create', entity_id: c.body.data.id } })).toBe(1);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'department.update', entity_id: f.deptId } });
    expect(audit.detail.changes.name).toEqual({ from: 'Electrical', to: 'Electrical works' });
  });

  it('deletes only after the last employee record is moved and frees the name for a fresh department', async () => {
    const other = (await create({ name: 'Other' })).body.data;
    await prisma.employee.updateMany({ where: { department_id: f.deptId }, data: { department_id: other.id } });
    expect(await current(f.deptId)).toMatchObject({ assigned_count: 0, can_delete: true });
    const removed = await f.agent.delete(url(f.deptId));
    expect(removed.status).toBe(200);
    expect(removed.body.data).toEqual({ id: f.deptId, deleted: true });
    expect(await prisma.department.findUnique({ where: { id: f.deptId } })).toBeNull();
    const fresh = await create({ name: 'Electrical' });
    expect(fresh.status).toBe(201);
    expect(fresh.body.data.id).not.toBe(f.deptId);
    expect(await prisma.auditLog.count({ where: { action: 'department.delete', entity_id: f.deptId } })).toBe(1);
  });

  it('requires setup.write for all mutations while retaining people.read list access', async () => {
    expect((await request(app).post(url()).send({ name: 'None' })).status).toBe(401);
    await prisma.role.updateMany({ data: { permissions: { set: ['people.read'] } } });
    invalidatePrincipal();
    expect((await f.agent.get(url())).status).toBe(200);
    expect((await create({ name: 'None' })).status).toBe(403);
    expect((await f.agent.patch(url(f.deptId)).send({ name: 'None' })).status).toBe(403);
    expect((await f.agent.delete(url(f.deptId))).status).toBe(403);
  });

  it('validates names, chart colours, patch fields and IDs without resetting a legacy colour on rename', async () => {
    for (const body of [{ name: '   ' }, { name: 'x'.repeat(81) }, { name: 'Civil', colour: 'chart-6' }, { name: 'Civil', colour: '#ff0000' }]) {
      expect((await create(body)).status).toBe(422);
    }
    expect((await f.agent.patch(url(f.deptId)).send({})).status).toBe(422);
    expect((await f.agent.patch(url(f.deptId)).send({ headcount: 5 })).status).toBe(422);
    expect((await f.agent.patch(url('not-an-id')).send({ name: 'Civil' })).status).toBe(422);
    expect((await f.agent.delete(url('not-an-id'))).status).toBe(422);
    expect((await f.agent.delete(url(crypto.randomUUID()))).status).toBe(404);
    await prisma.department.update({ where: { id: f.deptId }, data: { colour: '#13877e' } });
    const r = await f.agent.patch(url(f.deptId)).send({ name: 'ELECTRICAL' });
    expect(r.status).toBe(200);
    expect(r.body.data.colour).toBe('#13877e');
  });

  it('rejects case-insensitive duplicate names, including concurrent creates and renames', async () => {
    expect((await create({ name: ' electrical ' })).status).toBe(409);
    const other = (await create({ name: 'Civil' })).body.data;
    const rename = await f.agent.patch(url(other.id)).send({ name: 'electrical' });
    expect(rename.status).toBe(409);
    expect(rename.body.error.field).toBe('name');
    const results = await Promise.all([create({ name: 'Planning' }), create({ name: 'planning' })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.department.count({ where: { name: { equals: 'planning', mode: 'insensitive' }, deleted_at: null } })).toBe(1);
    const a = (await create({ name: 'Safety' })).body.data;
    const b = (await create({ name: 'Stores' })).body.data;
    const renamed = await Promise.all([f.agent.patch(url(a.id)).send({ name: 'Operations' }), f.agent.patch(url(b.id)).send({ name: 'operations' })]);
    expect(renamed.map((r) => r.status).sort()).toEqual([200, 409]);
    await prisma.department.create({ data: { name: '  Legacy padded  ' } });
    expect((await create({ name: 'Legacy padded' })).status).toBe(409);
    expect((await f.agent.patch(url(other.id)).send({ name: ' legacy padded ' })).status).toBe(409);
  });

  it('deliberately restores a legacy soft-deleted name without destroying its employee history', async () => {
    await prisma.department.update({ where: { id: f.deptId }, data: { deleted_at: new Date() } });
    expect(await current(f.deptId)).toBeUndefined();
    const r = await create({ name: 'electrical', colour: 'chart-4' });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ id: f.deptId, name: 'electrical', assigned_count: 5, can_delete: false });
    expect(await prisma.employee.count({ where: { department_id: f.deptId } })).toBe(5);
    expect(await prisma.auditLog.count({ where: { action: 'department.restore', entity_id: f.deptId } })).toBe(1);
    const empty = await prisma.department.create({ data: { name: 'Archived empty', deleted_at: new Date() } });
    const restored = await create({ name: 'Archived empty' });
    expect(restored.status).toBe(201);
    expect(restored.body.data).toMatchObject({ id: empty.id, assigned_count: 0, can_delete: true });
    await prisma.department.create({ data: { name: 'archived case', deleted_at: new Date() } });
    const exact = await prisma.department.create({ data: { name: 'Archived case', deleted_at: new Date() } });
    const caseRestore = await create({ name: 'Archived case' });
    expect(caseRestore.status, JSON.stringify(caseRestore.body)).toBe(201);
    expect(caseRestore.body.data.id).toBe(exact.id);
  });

  it('rejects missing and legacy-deleted department assignments for employee create, edit and offers', async () => {
    const legacy = await prisma.department.create({ data: { name: 'Unavailable', deleted_at: new Date() } });
    const empty = (await create({ name: 'Temporary' })).body.data;
    expect((await f.agent.delete(url(empty.id))).status).toBe(200);
    for (const departmentId of [legacy.id, empty.id]) {
      const before = await prisma.employee.count();
      const created = await f.agent.post('/api/v1/employees').send(employeeBody(departmentId));
      expect(created.status, JSON.stringify(created.body)).toBe(409);
      expect(created.body.error).toMatchObject({ code: 'DEPARTMENT_UNAVAILABLE', field: 'department_id' });
      const person = (await f.agent.get(`/api/v1/employees/${f.employees.A}`)).body.data;
      const edited = await f.agent.patch(`/api/v1/employees/${f.employees.A}`).send({ department_id: departmentId, updated_at: person.updated_at });
      expect(edited.status).toBe(409);
      expect(edited.body.error.field).toBe('department_id');
      const offered = await f.agent.post('/api/v1/offers').send(offerBody(departmentId));
      expect(offered.status, JSON.stringify(offered.body)).toBe(409);
      expect(offered.body.error.field).toBe('department_id');
      expect(await prisma.employee.count()).toBe(before);
      expect((await prisma.employee.findUniqueOrThrow({ where: { id: f.employees.A } })).department_id).toBe(f.deptId);
    }
  });

  it('cannot delete a department while a concurrently validated employee assignment commits', async () => {
    const department = (await create({ name: 'Concurrent' })).body.data;
    let reached;
    let release;
    const locked = new Promise((resolve) => { reached = resolve; });
    const continueInsert = new Promise((resolve) => { release = resolve; });
    const assign = prisma.$transaction(async (tx) => {
      await assertDepartmentAssignable(tx, department.id);
      reached();
      await continueInsert;
      return tx.employee.create({ data: { code: 'DEPT_RACE', name: 'Concurrent employee', gender: 'MALE', phone: '9000000000',
        designation: 'Engineer', department_id: department.id, pay_group_id: f.payGroupId, status: 'OFFER', joined_on: toDbDate('2026-11-01') } });
    }, { timeout: 10000 });
    await locked;
    const deletion = f.agent.delete(url(department.id)).then((r) => r);
    // Let DELETE reach the locked parent row before committing the child.
    await new Promise((resolve) => setTimeout(resolve, 40));
    release();
    const [, r] = await Promise.all([assign, deletion]);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('DEPARTMENT_IN_USE');
    expect(await prisma.department.findUnique({ where: { id: department.id } })).not.toBeNull();
    expect(await prisma.employee.count({ where: { department_id: department.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'department.delete', entity_id: department.id } })).toBe(0);
  });
});
