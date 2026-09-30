import { mkdirSync } from 'node:fs';
import './jobs/handlers';
import { env } from './lib/env';
import { startWorker } from './lib/jobs';
import { logger } from './lib/logger';

mkdirSync(env.EXPORT_DIR, { recursive: true });
const worker = startWorker();
if (!worker) {
  logger.error('REDIS_URL is required to run a standalone worker');
  process.exit(1);
}
