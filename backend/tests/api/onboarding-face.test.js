import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { embeddingToBytes, MODEL_VERSION } from '@ajpwer/face';
import { prisma } from '../../src/config/db.js';
import { setFaceClient } from '../../src/services/face.service.js';
import { buildFixture } from './fixture.js';

let f;
const required = ['PERSONAL', 'IDENTITY', 'BANK', 'PAY', 'JOINING_LETTER'];

beforeEach(async () => {
  f = await buildFixture();
});
afterAll(async () => {
  setFaceClient(null);
  await prisma.$disconnect();
});

async function completedChecklist(except = null) {
  await prisma.onboardingTask.createMany({
    data: required.filter((code) => code !== except).map((task_code) => ({
      employee_id: f.employees.ONBOARD, task_code, done_at: new Date(), done_by: 'HR',
    })),
  });
}

describe('Face registration is separate from onboarding', () => {
  it('activates without face registration and ignores an unfinished historical face step', async () => {
    await completedChecklist();
    await prisma.onboardingTask.create({ data: { employee_id: f.employees.ONBOARD, task_code: 'FACE' } });

    const profile = await f.agent.get(`/api/v1/employees/${f.employees.ONBOARD}`);
    expect(profile.status).toBe(200);
    expect(profile.body.data.face.enrolled).toBe(false);
    expect(profile.body.data.onboarding.required_left).toBe(0);
    expect(profile.body.data.onboarding.items.some((item) => item.code === 'FACE')).toBe(false);

    const activated = await f.agent.post(`/api/v1/employees/${f.employees.ONBOARD}/activate`);
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    expect(activated.body.data.status).toBe('ACTIVE');
    expect(await prisma.employeeFace.count({ where: { employee_id: f.employees.ONBOARD } })).toBe(0);
    // Historical checklist records remain intact rather than being deleted.
    expect(await prisma.onboardingTask.findUnique({ where: {
      employee_id_task_code: { employee_id: f.employees.ONBOARD, task_code: 'FACE' },
    } })).toMatchObject({ done_at: null });
  });

  it('still blocks activation when another required step is unfinished', async () => {
    await completedChecklist('BANK');
    const result = await f.agent.post(`/api/v1/employees/${f.employees.ONBOARD}/activate`);
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('BLOCKING_ISSUES');
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: f.employees.ONBOARD } })).status).toBe('ONBOARDING');
  });

  it('does not permit an old client to restore the retired face checklist step', async () => {
    const result = await f.agent.post(`/api/v1/employees/${f.employees.ONBOARD}/onboarding/FACE`).send({ done: true });
    expect(result.status).toBe(404);
    expect(await prisma.onboardingTask.count({ where: { employee_id: f.employees.ONBOARD, task_code: 'FACE' } })).toBe(0);
  });

  it('defers profile registration and preserves all current templates', async () => {
    const vector = [1, ...Array(127).fill(0)];
    await prisma.employeeFace.createMany({ data: ['REGISTERED', 'ROLLING'].map((kind) => ({
      employee_id: f.employees.A, model_version: MODEL_VERSION, kind,
      embedding: embeddingToBytes(vector), consent_at: new Date(),
    })) });
    const before = await prisma.employeeFace.findMany({ where: { employee_id: f.employees.A }, orderBy: { id: 'asc' } });
    const analyze = vi.fn();
    setFaceClient({ analyze });
    const result = await f.agent.post(`/api/v1/employees/${f.employees.A}/face`)
      .field('consent', 'true').field('confirm_duplicate', 'true')
      .attach('front', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'front.jpg', contentType: 'image/jpeg' });
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(result.body.error.code).toBe('FACE_REGISTRATION_AT_SITE');
    expect(analyze).not.toHaveBeenCalled();
    expect(await prisma.employeeFace.findMany({ where: { employee_id: f.employees.A }, orderBy: { id: 'asc' } })).toEqual(before);
    expect(await prisma.auditLog.count({ where: { entity_id: f.employees.A, action: 'face.enrol' } })).toBe(0);
    setFaceClient(null);
  });
});
