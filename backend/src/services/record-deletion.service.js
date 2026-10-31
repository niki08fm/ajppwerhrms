import { z } from 'zod';
import { istDate } from '@ajpwer/shared';
import { audit } from '../utils/audit.js';
import { AppError, notFound } from '../utils/errors.js';
import { toDbDate, fromDbDate } from '../utils/dbDates.js';
import { lockAssignments } from './master-data-lock.js';
const confirmSchema = z.object({
  confirm_name: z.string().min(1).max(500)
}).strict();
const entityTypes = {
  employee: 'employee',
  structure: 'salary_structure',
  group: 'pay_group'
};
const modelOf = {
  employee: 'employee',
  structure: 'salaryStructure',
  group: 'payGroup'
};
const member = {
  id: true,
  name: true,
  code: true,
  status: true
};
async function target(db, kind, id) {
  z.string().uuid().parse(id);
  const row = await db[modelOf[kind]].findFirst({
    where: {
      id,
      deleted_at: null
    }
  });
  if (!row) throw notFound(kind === 'group' ? 'That pay group' : kind === 'structure' ? 'That salary structure' : 'That employee');
  return row;
}
export async function structureAssignments(db, id) {
  const date = toDbDate(istDate(new Date()));
  const salaries = await db.employeeSalary.findMany({
    where: {
      structure_id: id,
      deleted_at: null,
      employee: {
        deleted_at: null,
        status: {
          not: 'EXITED'
        }
      },
      OR: [{
        valid_to: null
      }, {
        valid_to: {
          gte: date
        }
      }]
    },
    select: {
      employee: {
        select: member
      },
      valid_from: true,
      valid_to: true
    },
    orderBy: {
      valid_from: 'asc'
    }
  });
  // Only the latest live offer can still assign a template; earlier offers are history.
  const offers = await db.offer.findMany({
    where: {
      deleted_at: null,
      revoked_on: null,
      employee: {
        deleted_at: null,
        status: {
          in: ['OFFER', 'ACCEPTED']
        }
      }
    },
    distinct: ['employee_id'],
    orderBy: [{
      employee_id: 'asc'
    }, {
      created_at: 'desc'
    }],
    select: {
      structure_id: true,
      employee: {
        select: member
      }
    }
  });
  const rows = new Map();
  for (const s of salaries) rows.set(s.employee.id, {
    ...s.employee,
    source: 'Current or future salary',
    effective_from: fromDbDate(s.valid_from)
  });
  for (const o of offers.filter(o => o.structure_id === id)) if (!rows.has(o.employee.id)) rows.set(o.employee.id, {
    ...o.employee,
    source: 'Latest open offer'
  });
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}
async function employeeObligations(db, e) {
  const [slips, settlements, advances, loans, carries, holds, held] = await Promise.all([db.payslip.count({
    where: {
      employee_id: e.id,
      deleted_at: null,
      period: {
        deleted_at: null,
        state: {
          in: ['RUN', 'LOCKED']
        }
      }
    }
  }), db.settlement.count({
    where: {
      employee_id: e.id,
      deleted_at: null,
      state: {
        not: 'PAID'
      }
    }
  }), db.advance.findMany({
    where: {
      employee_id: e.id,
      deleted_at: null,
      status: 'ACTIVE'
    },
    select: {
      amount: true,
      recovered: true
    }
  }), db.loan.findMany({
    where: {
      employee_id: e.id,
      deleted_at: null,
      status: 'ACTIVE'
    },
    select: {
      principal: true,
      recovered: true
    }
  }), db.recoveryCarry.count({
    where: {
      employee_id: e.id,
      deleted_at: null,
      amount: {
        gt: 0
      }
    }
  }), db.salaryHold.count({
    where: {
      employee_id: e.id,
      deleted_at: null,
      released_at: null
    }
  }), db.heldPay.count({
    where: {
      employee_id: e.id,
      state: {
        in: ['HELD', 'QUEUED']
      }
    }
  })]);
  return [...(slips ? [`${slips} unpaid payroll record(s). Pay or take the payroll back to its steps first.`] : []), ...(settlements ? [`${settlements} unsettled F&F record(s). Resolve the settlement first.`] : []), ...(advances.some(a => a.amount > a.recovered) || loans.some(l => l.principal > l.recovered) || carries ? ['Outstanding advances, loans or recovery carry. Settle these before deleting the employee.'] : []), ...(holds || held ? ['Held salary remains unresolved. Release or settle it first.'] : [])];
}
export async function deletionPreview(db, kind, id) {
  const row = await target(db, kind, id);
  let assignments = [],
    blockers = [];
  if (kind === 'employee') blockers = await employeeObligations(db, row);
  if (kind === 'structure') assignments = await structureAssignments(db, id);
  if (kind === 'group') assignments = await db.employee.findMany({
    where: {
      pay_group_id: id,
      deleted_at: null,
      status: {
        not: 'EXITED'
      }
    },
    select: member,
    orderBy: {
      name: 'asc'
    }
  });
  if (assignments.length) blockers.push(`Move ${assignments.length} linked employee(s) to another ${kind === 'group' ? 'pay group' : 'salary structure'} first. Current and future assignments must be cleared.`);
  const running = kind === 'employee' ? await db.payrollPeriod.count({
    where: {
      deleted_at: null,
      running_job_id: {
        not: null
      }
    }
  }) : 0;
  if (running) blockers.push('Payroll is being generated. Wait for it to finish and review again.');
  const effects = kind === 'employee' ? ['Remove this employee from active lists, future payroll selection and site/face punching.', 'Remove this employee’s enrolled face templates and revoke pending face registration approvals.', 'Keep paid payslips, attendance, salary history, documents and audit records linked to the original employee ID.', 'This does not record an exit or calculate F&F. Use Exit and F&F for a normal departure.'] : [`Remove this ${kind === 'group' ? 'pay group' : 'salary structure'} from setup lists and new assignment choices.`, 'Keep historical salary, offer and payroll references intact. Exited or deleted employees retain their historical links.', kind === 'group' ? 'Policy definitions and old pay group rules are retained.' : 'Salary components and old salary revisions are retained.'];
  return {
    id: row.id,
    name: row.name,
    ...(kind === 'employee' ? {
      code: row.code
    } : {}),
    kind,
    can_delete: !blockers.length,
    blockers,
    assigned_count: assignments.length,
    employees: assignments,
    effects,
    confirmation: row.name
  };
}
export async function deleteNamedRecord(tx, kind, id, body, actor) {
  z.string().uuid().parse(id);
  const {
    confirm_name
  } = confirmSchema.parse(body);
  if (kind === 'employee') await tx.$queryRaw`SELECT id FROM payroll_period WHERE deleted_at IS NULL ORDER BY id FOR UPDATE`;
  await lockAssignments(tx);
  if (kind === 'employee') await tx.$queryRaw`SELECT id FROM employee WHERE id=${id}::uuid FOR UPDATE`;
  const row = await target(tx, kind, id);
  if (confirm_name !== row.name) throw new AppError('CONFIRMATION_MISMATCH', 'Type the complete name exactly as shown to confirm this deletion.', 422, 'confirm_name');
  const preview = await deletionPreview(tx, kind, id);
  if (!preview.can_delete) throw new AppError('DELETE_BLOCKED', preview.blockers[0], 409, null, {
    blockers: preview.blockers,
    assigned_count: preview.assigned_count
  });
  const at = new Date();
  await tx[modelOf[kind]].update({
    where: {
      id
    },
    data: {
      deleted_at: at
    }
  });
  if (kind === 'employee') {
    await tx.employeeFace.updateMany({
      where: {
        employee_id: id,
        deleted_at: null
      },
      data: {
        deleted_at: at,
        embedding: Buffer.alloc(0)
      }
    });
    await tx.faceRegistrationAuthorization.updateMany({
      where: {
        employee_id: id,
        status: 'APPROVED'
      },
      data: {
        status: 'REVOKED',
        revoked_by: actor.actor,
        revoked_at: at
      }
    });
    await tx.offer.updateMany({
      where: {
        employee_id: id,
        deleted_at: null,
        revoked_on: null
      },
      data: {
        revoked_on: toDbDate(istDate(at)),
        revoked_by: actor.actor,
        revoke_reason: 'Employee deleted with typed-name confirmation.'
      }
    });
    // Rosters changed: require fresh reviews for editable months, never alter paid records.
    const periods = await tx.payrollPeriod.findMany({
      where: {
        deleted_at: null,
        state: 'DRAFT',
        period_ym: {
          gte: row.joined_on ? fromDbDate(row.joined_on).slice(0, 7) : istDate(at).slice(0, 7)
        }
      }
    });
    for (const p of periods) await tx.payrollPeriod.update({
      where: {
        id: p.id
      },
      data: {
        steps_submitted: [],
        step_log: [...(Array.isArray(p.step_log) ? p.step_log : []), {
          action: 'employee.delete',
          employee_id: id,
          at: at.toISOString(),
          by: actor.actor
        }]
      }
    });
  }
  await audit(tx, {
    ...actor,
    action: `${kind === 'group' ? 'pay_group' : kind}.delete`,
    entity_type: entityTypes[kind],
    entity_id: id,
    detail: {
      name: row.name,
      ...(kind === 'employee' ? {
        code: row.code
      } : {}),
      deletion_mode: 'soft',
      effects: preview.effects
    }
  });
  return {
    id,
    deleted: true,
    name: row.name,
    history_retained: true
  };
}
