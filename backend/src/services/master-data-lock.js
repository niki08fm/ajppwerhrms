import { AppError } from '../utils/errors.js';

// Serialize assigning/deleting a pay group or salary template. Salary changes
// take period locks first, then this lock, then employee locks.
export async function lockAssignments(tx) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(20261031, 44)`;
}
export async function assertAssignableGroup(db, id) {
  const row = await db.payGroup.findFirst({
    where: {
      id,
      deleted_at: null
    },
    select: {
      id: true
    }
  });
  if (!row) throw new AppError('NOT_FOUND', 'That pay group is no longer available. Choose another pay group.', 404, 'pay_group_id');
}
export async function assertAssignableStructure(db, id) {
  const row = await db.salaryStructure.findFirst({
    where: {
      id,
      deleted_at: null
    },
    select: {
      id: true
    }
  });
  if (!row) throw new AppError('NOT_FOUND', 'That salary structure is no longer available. Choose another structure.', 404, 'structure_id');
}
