import { mkdirSync } from 'node:fs';
import './jobs/handlers.js';
import { env } from './config/env.js';
import { startWorker } from './jobs/queue.js';
import { logger } from './config/logger.js';

mkdirSync(env.EXPORT_DIR, { recursive: true });
const worker = startWorker();
if (!worker) {
  logger.error('REDIS_URL is required to run a standalone worker');
  process.exit(1);
}
