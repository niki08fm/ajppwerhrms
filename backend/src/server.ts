import { mkdirSync } from 'node:fs';
import { createApp } from './app';
import { env } from './lib/env';
import { closeJobs, startWorker } from './lib/jobs';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';

mkdirSync(env.UPLOAD_DIR, { recursive: true });
mkdirSync(env.EXPORT_DIR, { recursive: true });

const app = createApp();
// In development the API process also works the queue. In production run `npm run worker` separately.
const worker = env.NODE_ENV !== 'production' || process.env.RUN_WORKER === 'true' ? startWorker() : null;

const server = app.listen(env.API_PORT, () => {
  logger.info(`AJPWER API listening on http://localhost:${env.API_PORT}/api/v1`);
});

async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  server.close();
  await worker?.close();
  await closeJobs();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
