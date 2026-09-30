import { registerJob } from '../lib/jobs';
import { executeRun, releaseRun } from '../services/payroll';

/** The payroll run: one transaction, progress reported on the job row. */
registerJob('payroll.run', async (_jobId, params, progress) => {
  const ym = params.ym as string;
  try {
    const { totals } = await executeRun(ym, params.actor as string, progress);
    return { ym, totals };
  } finally {
    await releaseRun(ym);
  }
});
