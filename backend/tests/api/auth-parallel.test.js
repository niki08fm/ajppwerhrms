import { afterAll, afterEach, beforeEach, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { invalidatePrincipal } from '../../src/middleware/auth.js';
import { buildFixture } from './fixture.js';
let f,
  tracking = false,
  count = 0,
  blocked = null;
prisma.$use(async (params, next) => {
  const principal = params.model === 'AppUser' && params.action === 'findFirst';
  if (tracking && principal) count++;
  const result = await next(params);
  if (principal && blocked) {
    const current = blocked;
    blocked = null;
    current.started();
    await current.gate;
  }
  return result;
});
beforeEach(async () => {
  tracking = false;
  blocked = null;
  f = await buildFixture();
  invalidatePrincipal();
  count = 0;
});
afterEach(() => {
  tracking = false;
  blocked = null;
});
afterAll(() => prisma.$disconnect());
it('shares the signed-in user lookup across simultaneous independent requests', async () => {
  tracking = true;
  const results = await Promise.all(Array.from({
    length: 4
  }, () => f.agent.get('/api/v1/auth/me')));
  expect(results.map(r => r.status)).toEqual([200, 200, 200, 200]);
  expect(count).toBe(1);
});
it('does not restore old permissions when a pending lookup finishes after invalidation', async () => {
  let release, started;
  const gate = new Promise(r => release = r),
    read = new Promise(r => started = r);
  blocked = {
    gate,
    started
  };
  const pending = f.agent.get('/api/v1/auth/me').then(r => r);
  await read;
  try {
    await prisma.role.updateMany({
      data: {
        permissions: {
          set: ['people.read']
        }
      }
    });
    invalidatePrincipal();
  } finally {
    release();
  }
  expect((await pending).status).toBe(200);
  const current = await f.agent.get('/api/v1/auth/me');
  expect(current.body.data.permissions).toEqual(['people.read']);
});
