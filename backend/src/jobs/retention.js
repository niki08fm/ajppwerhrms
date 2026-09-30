import { readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { addDays, istDate } from '@ajpwer/shared';
import { audit } from '../utils/audit.js';
import { toDbDate } from '../utils/dbDates.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { prisma } from '../config/db.js';
import { rebuildAggregates } from '../services/aggregates.service.js';

/**
 * Nightly retention and housekeeping. Built at the start, because retention added later never happens.
 *
 *   Gate snapshots    30 days
 *   Face embeddings   until exit
 *   Punches           three years
 *   Payroll records   seven years (never deleted by this job; payslips are protected by trigger)
 */
export async function runRetention(now = new Date()) {
  const today = istDate(now);
  const report = {};

  // 1. Gate snapshots older than 30 days: delete the file and the pointer.
  const cutoff = new Date(now.getTime() - env.RETENTION_GATE_SNAPSHOT_DAYS * 86_400_000);
  const old = await prisma.faceException.findMany({ where: { snapshot_key: { not: null }, occurred_at: { lt: cutoff } }, select: { id: true, snapshot_key: true } });
  const dir = path.resolve(env.UPLOAD_DIR, 'snapshots');
  for (const fx of old) {
    try {
      unlinkSync(path.join(dir, path.basename(fx.snapshot_key)));
    } catch {
      // already gone
    }
  }
  await prisma.faceException.updateMany({ where: { id: { in: old.map((o) => o.id) } }, data: { snapshot_key: null } });
  // Orphan files too.
  try {
    for (const f of readdirSync(dir)) {
      const full = path.join(dir, f);
      if (statSync(full).mtime < cutoff) unlinkSync(full);
    }
  } catch {
    // no directory yet
  }
  report.snapshots_deleted = old.length;

  // 2. Face embeddings of people who have exited: no further purpose.
  const exited = await prisma.employeeFace.updateMany({
    where: { deleted_at: null, employee: { status: 'EXITED' } },
    data: { deleted_at: now, embedding: Buffer.alloc(0) },
  });
  report.embeddings_deleted = exited.count;

  // 3. Punches older than three years. The append-only trigger allows this job alone, by opt-in.
  const punchCutoff = addDays(today, -env.RETENTION_PUNCH_DAYS);
  report.punches_deleted = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ajpwer.retention = 'on'`);
    return tx.$executeRaw`DELETE FROM punch WHERE work_date < ${toDbDate(punchCutoff)}::date`;
  });

  // 4. Housekeeping.
  report.login_attempts_deleted = (await prisma.loginAttempt.deleteMany({ where: { at: { lt: new Date(now.getTime() - 30 * 86_400_000) } } })).count;
  report.idempotency_keys_deleted = (await prisma.idempotencyKey.deleteMany({ where: { created_at: { lt: new Date(now.getTime() - 7 * 86_400_000) } } })).count;

  // 5. Rebuild the cached daily aggregates.
  await rebuildAggregates(60, today);

  await audit(prisma, { actor: 'system', action: 'retention.run', entity_type: 'system', detail: report });
  return report;
}

// Run directly: `npm run jobs:retention` (schedule nightly with cron or a systemd timer).
if (process.argv[1] && /retention\.(ts|js)$/.test(process.argv[1])) {
  runRetention()
    .then((r) => {
      logger.info(r, 'retention complete');
      return prisma.$disconnect();
    })
    .catch((err) => {
      logger.error({ err }, 'retention failed');
      process.exit(1);
    });
}
