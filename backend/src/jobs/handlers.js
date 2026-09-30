import { registerJob } from './queue.js';
import { executeRun, releaseRun } from '../services/payroll.service.js';

/** The payroll run: one transaction, progress reported on the job row. */
registerJob('payroll.run', async (_jobId, params, progress) => {
  const ym = params.ym;
  try {
    const { totals } = await executeRun(ym, params.actor, progress);
    return { ym, totals };
  } finally {
    await releaseRun(ym);
  }
});
