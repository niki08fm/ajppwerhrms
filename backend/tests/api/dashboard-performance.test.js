import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, buildFixture } from './fixture.js';
import { prisma } from '../../src/config/db.js';
import { invalidatePrincipal } from '../../src/middleware/auth.js';
import { invalidateApprovalsCache } from '../../src/services/approvals.service.js';
import { invalidateDashboardCache } from '../../src/utils/dashboard-cache.js';

let fixture;
let observed = null;
prisma.$use(async (params, next) => {
  observed?.push({ model: params.model, action: params.action });
  return next(params);
});
beforeEach(async () => {
  fixture = await buildFixture();
  invalidatePrincipal();
  invalidateApprovalsCache();
  invalidateDashboardCache();
});
afterEach(() => { observed = null; });
afterAll(async () => { await prisma.$disconnect(); });

describe('Lightweight navigation approvals', () => {
  it('returns the same approval count without loading unrelated people, salary or document summaries', async () => {
    const reads = [];
    observed = reads;
    const badge = await fixture.agent.get('/api/v1/dashboard/people').query({ summary: 'approvals' });
    expect(badge.status).toBe(200);
    expect(badge.body.data).toEqual({ approvals: { total: expect.any(Number) } });
    observed = null;
    const unnecessary = new Set(['Employee:groupBy', 'PayrollExclusion:findMany', 'Document:count', 'SalaryHold:findMany', 'HeldPay:aggregate', 'FaceException:count', 'LeaveRequest:count']);
    expect(reads.filter((q) => unnecessary.has(`${q.model}:${q.action}`))).toEqual([]);
    const approvals = await fixture.agent.get('/api/v1/approvals');
    expect(approvals.status).toBe(200);
    expect(badge.body.data.approvals.total).toBe(approvals.body.data.items.length);
    const full = await fixture.agent.get('/api/v1/dashboard/people');
    expect(full.status).toBe(200);
    expect(full.body.data).toHaveProperty('pipeline');
    expect(full.body.data).toHaveProperty('held_salaries');
    expect(full.body.data.approvals.total).toBe(badge.body.data.approvals.total);
  });
  it('preserves authentication requirements for lightweight reads', async () => {
    expect((await request(app).get('/api/v1/dashboard/people?summary=approvals')).status).toBe(401);
  });
});
