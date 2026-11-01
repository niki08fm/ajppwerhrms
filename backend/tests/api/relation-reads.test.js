import { afterAll, beforeEach, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../../src/config/db.js';
import { loadEmployee } from '../../src/services/employee.service.js';
import { buildFixture } from './fixture.js';
let fixture,
  queries = 0;
const db = new PrismaClient({
  log: [{
    emit: 'event',
    level: 'query'
  }]
});
db.$on('query', () => queries++);
beforeEach(async () => {
  fixture = await buildFixture();
  await db.$connect();
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});
it('loads the same complete employee with one database trip instead of separate relation queries', async () => {
  const read = strategy => loadEmployee({
    employee: {
      findFirst: args => db.employee.findFirst({
        ...args,
        relationLoadStrategy: strategy
      })
    }
  }, fixture.employees.A);
  queries = 0;
  const previous = await read('query'),
    before = queries;
  queries = 0;
  const joined = await read('join'),
    after = queries;
  const normalize = e => ({
    ...e,
    onboarding_tasks: [...e.onboarding_tasks].sort((a, b) => a.task_code.localeCompare(b.task_code))
  });
  expect(normalize(joined)).toEqual(normalize(previous));
  expect(after).toBe(1);
  expect(before).toBeGreaterThan(after);
  console.log(JSON.stringify({
    action: 'profile-relations',
    queryStrategyTrips: before,
    joinStrategyTrips: after
  }));
});
