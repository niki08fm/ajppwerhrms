import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { prisma } from '../config/db.js';

/**
 * Long operations — the payroll run and exports over 5,000 rows — go to a queue,
 * never inside a request. With REDIS_URL set this is BullMQ; without it (dev and
 * tests) jobs run in-process. Either way the job row in the database is the
 * status the client polls.
 */

const handlers = new Map();

export function registerJob(kind, handler) {
  handlers.set(kind, handler);
}

let queue = null;
let connection = null;

function getConnection() {
  if (!env.REDIS_URL) return null;
  if (!connection) connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

function getQueue() {
  const conn = getConnection();
  if (!conn) return null;
  if (!queue) queue = new Queue('ajpwer', { connection: conn });
  return queue;
}

async function execute(jobId) {
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) return;
  const handler = handlers.get(job.kind);
  if (!handler) {
    await prisma.job.update({ where: { id: jobId }, data: { status: 'FAILED', error: `No handler for ${job.kind}`, finished_at: new Date() } });
    return;
  }
  await prisma.job.update({ where: { id: jobId }, data: { status: 'RUNNING', started_at: new Date() } });
  let lastWrite = 0;
  const progress = async (done, total) => {
    if (Date.now() - lastWrite < 500 && done < total) return;
    lastWrite = Date.now();
    await prisma.job.update({ where: { id: jobId }, data: { progress: done, total } });
  };
  try {
    const result = await handler(jobId, job.params, progress);
    await prisma.job.update({
      where: { id: jobId },
      data: { status: 'DONE', result: JSON.parse(JSON.stringify(result ?? null)), finished_at: new Date() },
    });
  } catch (err) {
    logger.error({ err, jobId, kind: job.kind }, 'job failed');
    const message = err instanceof Error ? err.message : String(err);
    await prisma.job.update({ where: { id: jobId }, data: { status: 'FAILED', error: message, finished_at: new Date() } });
    throw err;
  }
}

/** Create the job row and dispatch it. Returns the job id immediately. */
export async function enqueue(kind, params, createdBy, id) {
  const job = await prisma.job.create({ data: { ...(id ? { id } : {}), kind, params: JSON.parse(JSON.stringify(params)), created_by: createdBy ?? null } });
  const q = getQueue();
  if (q) {
    await q.add(kind, { jobId: job.id }, { removeOnComplete: 1000, removeOnFail: 1000, attempts: 1 });
  } else {
    setImmediate(() => {
      execute(job.id).catch(() => undefined);
    });
  }
  return job.id;
}

/** Run a job to completion in-process (tests and scripts). */
export async function runNow(kind, params, createdBy) {
  const job = await prisma.job.create({ data: { kind, params: JSON.parse(JSON.stringify(params)), created_by: createdBy ?? null } });
  await execute(job.id);
  return job.id;
}

export function startWorker() {
  const conn = getConnection();
  if (!conn) {
    logger.info('REDIS_URL not set — jobs run in-process');
    return null;
  }
  const worker = new Worker(
    'ajpwer',
    async (j) => {
      await execute(j.data.jobId);
    },
    { connection: conn, concurrency: 2 },
  );
  worker.on('failed', (j, err) => logger.warn({ jobId: j?.data?.jobId, err: err.message }, 'queue job failed'));
  logger.info('BullMQ worker started');
  return worker;
}

export async function closeJobs() {
  await queue?.close();
  connection?.disconnect();
}
