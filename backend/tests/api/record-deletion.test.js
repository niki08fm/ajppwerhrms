import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { MODEL_VERSION, embeddingToBytes } from '@ajpwer/face';
import { prisma } from '../../src/config/db.js';
import { invalidatePrincipal } from '../../src/middleware/auth.js';
import { invalidateFaceCache, loadGallery } from '../../src/services/face.service.js';
import { toDbDate } from '../../src/utils/dbDates.js';
import { app, buildFixture } from './fixture.js';
let f;
beforeEach(async () => {
  f = await buildFixture();
  invalidateFaceCache();
});
afterAll(async () => {
  await prisma.$disconnect();
});
const path = (type, id) => `/api/v1/${type}/${id}`;
const preview = (type, id) => f.agent.get(`${path(type, id)}/deletion`);
const remove = (type, id, name) => f.agent.delete(path(type, id)).send({
  confirm_name: name
});
const person = () => prisma.employee.findUniqueOrThrow({
  where: {
    id: f.employees.A
  }
});
async function structure(name = 'Replacement') {
  return prisma.salaryStructure.create({
    data: {
      name,
      components: {
        create: [{
          seq: 1,
          name: 'Basic',
          calc_type: 'PCT_GROSS',
          calc_value: 50,
          counts_as_wages: true
        }, {
          seq: 2,
          name: 'Special Allowance',
          calc_type: 'BALANCE',
          calc_value: 0
        }]
      }
    }
  });
}
async function slip(state) {
  const period = await prisma.payrollPeriod.create({
    data: {
      period_ym: '2026-08',
      state: 'RUN'
    }
  });
  const p = await prisma.payslip.create({
    data: {
      period_id: period.id,
      employee_id: f.employees.A,
      gross: 2000000n,
      salary_gross: 2000000n,
      total_deductions: 0n,
      reimbursements: 0n,
      net: 2000000n,
      employer_total: 0n,
      ctc_month: 2000000n,
      pf_wage: 1000000n,
      esi_applicable: true,
      paid_days: 26,
      lop_days: 0,
      divisor: 26,
      computed_at: new Date(),
      engine_version: 'test',
      meta: {
        employee: {
          name: 'Person A',
          code: 'T001'
        }
      }
    }
  });
  await prisma.payrollPeriod.update({
    where: {
      id: period.id
    },
    data: {
      state
    }
  });
  return p;
}
describe('Named deletion and assignment guards', () => {
  it('requires the exact employee name, not their code, substring or wrong case', async () => {
    const e = await person(),
      info = await preview('employees', e.id);
    expect(info.status).toBe(200);
    expect(info.body.data).toMatchObject({
      name: e.name,
      code: e.code,
      can_delete: true
    });
    for (const name of ['', e.code, 'Person', e.name.toLowerCase(), `${e.name} `]) expect((await remove('employees', e.id, name)).status).toBe(422);
    expect((await person()).deleted_at).toBeNull();
    expect(await prisma.auditLog.count({
      where: {
        action: 'employee.delete'
      }
    })).toBe(0);
  });
  it('deletes only the confirmed employee, disables face registration and preserves paid history', async () => {
    const e = await person(),
      p = await slip('PAID');
    await prisma.employeeFace.create({
      data: {
        employee_id: e.id,
        model_version: MODEL_VERSION,
        embedding: embeddingToBytes([1, ...Array(127).fill(0)]),
        kind: 'REGISTERED',
        consent_at: new Date(),
        enrolled_at: new Date()
      }
    });
    await prisma.faceRegistrationAuthorization.create({
      data: {
        employee_id: e.id,
        reason: 'Re-registration',
        approved_by: 'hr@test.in',
        expires_at: new Date(Date.now() + 3600000)
      }
    });
    expect((await loadGallery()).byEmployee.has(e.id)).toBe(true);
    const punches = await prisma.punch.count({
      where: {
        employee_id: e.id
      }
    });
    const result = await remove('employees', e.id, e.name);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.data).toMatchObject({
      id: e.id,
      deleted: true,
      history_retained: true
    });
    expect((await person()).deleted_at).not.toBeNull();
    expect((await f.agent.get(path('employees', e.id))).status).toBe(404);
    expect(await prisma.employee.count({
      where: {
        deleted_at: null
      }
    })).toBe(4);
    expect(await prisma.payslip.findUnique({
      where: {
        id: p.id
      }
    })).not.toBeNull();
    expect(await prisma.punch.count({
      where: {
        employee_id: e.id
      }
    })).toBe(punches);
    expect(await prisma.employeeSalary.count({
      where: {
        employee_id: e.id
      }
    })).toBe(1);
    const face = await prisma.employeeFace.findFirst({
      where: {
        employee_id: e.id
      }
    });
    expect(face.deleted_at).not.toBeNull();
    expect(face.embedding.byteLength).toBe(0);
    expect((await loadGallery()).byEmployee.has(e.id)).toBe(false);
    expect((await prisma.faceRegistrationAuthorization.findFirst({
      where: {
        employee_id: e.id
      }
    })).status).toBe('REVOKED');
    expect((await preview('employees', e.id)).status).toBe(404);
    expect(await prisma.auditLog.count({
      where: {
        action: 'employee.delete',
        entity_id: e.id
      }
    })).toBe(1);
  });
  it('blocks unpaid payroll and outstanding recovery until resolved', async () => {
    const e = await person();
    await slip('LOCKED');
    expect((await preview('employees', e.id)).body.data.can_delete).toBe(false);
    expect((await remove('employees', e.id, e.name)).status).toBe(409);
    await prisma.payrollPeriod.updateMany({
      data: {
        state: 'PAID'
      }
    });
    const advance = await prisma.advance.create({
      data: {
        employee_id: e.id,
        amount: 500000n,
        recovered: 0n,
        reason: 'Loan',
        granted_on: toDbDate('2026-08-01'),
        instalment: 100000n
      }
    });
    expect((await remove('employees', e.id, e.name)).status).toBe(409);
    await prisma.advance.update({
      where: {
        id: advance.id
      },
      data: {
        recovered: 500000n,
        status: 'CLOSED'
      }
    });
    expect((await remove('employees', e.id, e.name)).status).toBe(200);
  });
  it('blocks holds and running payroll, then reopens editable review steps after deletion', async () => {
    const e = await person();
    const hold = await prisma.salaryHold.create({
      data: {
        employee_id: e.id,
        from_ym: '2026-08',
        reason: 'Review',
        created_by: 'hr@test.in'
      }
    });
    expect((await remove('employees', e.id, e.name)).status).toBe(409);
    await prisma.salaryHold.update({
      where: {
        id: hold.id
      },
      data: {
        released_at: new Date()
      }
    });
    const period = await prisma.payrollPeriod.create({
      data: {
        period_ym: '2026-08',
        running_job_id: randomUUID()
      }
    });
    expect((await remove('employees', e.id, e.name)).status).toBe(409);
    await prisma.payrollPeriod.update({
      where: {
        id: period.id
      },
      data: {
        running_job_id: null,
        steps_submitted: [1, 2, 3]
      }
    });
    expect((await remove('employees', e.id, e.name)).status).toBe(200);
    expect((await prisma.payrollPeriod.findUnique({
      where: {
        id: period.id
      }
    })).steps_submitted).toEqual([]);
  });
  it('requires salary reassignment while retaining closed historical rows and components', async () => {
    const source = await prisma.salaryStructure.findUniqueOrThrow({
        where: {
          id: f.structureId
        }
      }),
      other = await structure();
    expect((await preview('structures', source.id)).body.data.assigned_count).toBe(5);
    expect((await remove('structures', source.id, source.name)).status).toBe(409);
    const original = await prisma.employeeSalary.findMany({
      where: {
        structure_id: source.id
      }
    });
    await prisma.employeeSalary.updateMany({
      where: {
        structure_id: source.id
      },
      data: {
        valid_to: toDbDate('2026-07-31')
      }
    });
    for (const s of original) await prisma.employeeSalary.create({
      data: {
        employee_id: s.employee_id,
        structure_id: other.id,
        mode: s.mode,
        amount: s.amount,
        monthly_gross: s.monthly_gross,
        valid_from: toDbDate('2026-08-01'),
        reason: 'Moved template'
      }
    });
    expect((await preview('structures', source.id)).body.data.can_delete).toBe(true);
    expect((await remove('structures', source.id, source.name)).status).toBe(200);
    expect(await prisma.employeeSalary.count({
      where: {
        structure_id: source.id
      }
    })).toBe(5);
    expect((await f.agent.get(path('structures', source.id))).status).toBe(404);
    expect((await f.agent.get('/api/v1/structures')).body.data.some(s => s.id === source.id)).toBe(false);
    const revision = await f.agent.post(`${path('employees', f.employees.A)}/salary`).send({
      mode: 'GROSS',
      amount: 2000000,
      structure_id: source.id,
      valid_from: '2026-11-01',
      reason: 'Invalid deleted template'
    });
    expect(revision.status).toBe(404);
  });
  it('rechecks future assignments after a preview so a stale confirmation cannot delete them', async () => {
    const empty = await structure('Empty template');
    expect((await preview('structures', empty.id)).body.data.can_delete).toBe(true);
    await prisma.employeeSalary.updateMany({
      where: {
        employee_id: f.employees.A
      },
      data: {
        valid_to: toDbDate('2026-12-31')
      }
    });
    await prisma.employeeSalary.create({
      data: {
        employee_id: f.employees.A,
        structure_id: empty.id,
        valid_from: toDbDate('2027-01-01'),
        mode: 'GROSS',
        amount: 2000000n,
        monthly_gross: 2000000n,
        reason: 'Future assignment'
      }
    });
    expect((await remove('structures', empty.id, empty.name)).status).toBe(409);
    expect((await prisma.salaryStructure.findUnique({
      where: {
        id: empty.id
      }
    })).deleted_at).toBeNull();
  });
  it('requires moving pay-group members and rejects assignments to deleted groups', async () => {
    const source = await prisma.payGroup.findUniqueOrThrow({
      where: {
        id: f.payGroupId
      }
    });
    expect((await remove('pay-groups', source.id, source.name)).status).toBe(409);
    const dest = await prisma.payGroup.create({
      data: {
        name: 'Replacement group',
        calendar_method: source.calendar_method,
        weekly_off: source.weekly_off,
        shift_id: source.shift_id
      }
    });
    const moved = await f.agent.post(`${path('pay-groups', dest.id)}/employees`).send({
      employee_ids: Object.values(f.employees)
    });
    expect(moved.status).toBe(200);
    expect((await remove('pay-groups', source.id, source.name)).status).toBe(200);
    expect((await prisma.payGroup.findUnique({
      where: {
        id: source.id
      }
    })).deleted_at).not.toBeNull();
    expect(await prisma.payGroupPolicy.count({
      where: {
        pay_group_id: source.id
      }
    })).toBeGreaterThan(0);
    expect((await f.agent.post(`${path('pay-groups', source.id)}/employees`).send({
      employee_ids: [f.employees.A]
    })).status).toBe(404);
    expect((await f.agent.get('/api/v1/pay-groups')).body.data.some(g => g.id === source.id)).toBe(false);
  });
  it('checks exact names for setup records and serializes a competing group move', async () => {
    const source = await prisma.payGroup.findUniqueOrThrow({
      where: {
        id: f.payGroupId
      }
    });
    const dest = await prisma.payGroup.create({
      data: {
        name: 'Unused group',
        calendar_method: source.calendar_method,
        weekly_off: source.weekly_off,
        shift_id: source.shift_id
      }
    });
    const empty = await structure('Unused template');
    expect((await remove('structures', empty.id, 'unused template')).status).toBe(422);
    expect((await remove('pay-groups', dest.id, 'Unused')).status).toBe(422);
    const [deleted, moved] = await Promise.all([remove('pay-groups', dest.id, dest.name), f.agent.post(`${path('pay-groups', dest.id)}/employees`).send({
      employee_ids: [f.employees.A]
    })]);
    expect([deleted.status, moved.status]).toEqual(deleted.status === 200 ? [200, 404] : [409, 200]);
    const e = await person(),
      group = await prisma.payGroup.findUnique({
        where: {
          id: e.pay_group_id
        }
      });
    expect(group.deleted_at).toBeNull();
  });
  it('blocks open F&F, loan balances and queued held salary independently', async () => {
    const e = await person();
    const settlement = await prisma.settlement.create({
      data: {
        employee_id: e.id,
        last_day: toDbDate('2026-08-31'),
        earnings: [],
        deductions: [],
        total_earnings: 0n,
        total_deductions: 0n,
        net: 0n
      }
    });
    expect((await preview('employees', e.id)).body.data.blockers.join(' ')).toContain('F&F');
    await prisma.settlement.update({
      where: {
        id: settlement.id
      },
      data: {
        state: 'PAID',
        paid_at: new Date()
      }
    });
    const loan = await prisma.loan.create({
      data: {
        employee_id: e.id,
        loan_type: 'Personal',
        principal: 500000n,
        months: 5,
        emi: 100000n,
        started_on: toDbDate('2026-08-01')
      }
    });
    expect((await remove('employees', e.id, e.name)).status).toBe(409);
    await prisma.loan.update({
      where: {
        id: loan.id
      },
      data: {
        recovered: 500000n,
        status: 'CLOSED'
      }
    });
    const carry = await prisma.recoveryCarry.create({
      data: {
        employee_id: e.id,
        period_ym: '2026-09',
        amount: 100000n
      }
    });
    expect((await remove('employees', e.id, e.name)).status).toBe(409);
    await prisma.recoveryCarry.update({
      where: {
        id: carry.id
      },
      data: {
        amount: 0n
      }
    });
    const hold = await prisma.salaryHold.create({
      data: {
        employee_id: e.id,
        from_ym: '2026-08',
        reason: 'Review',
        created_by: 'hr@test.in',
        released_at: new Date()
      }
    });
    const held = await prisma.heldPay.create({
      data: {
        employee_id: e.id,
        hold_id: hold.id,
        period_ym: '2026-08',
        amount: 100000n,
        state: 'QUEUED',
        pay_ym: '2026-09'
      }
    });
    expect((await remove('employees', e.id, e.name)).status).toBe(409);
    await prisma.heldPay.update({
      where: {
        id: held.id
      },
      data: {
        state: 'PAID'
      }
    });
    expect((await remove('employees', e.id, e.name)).status).toBe(200);
    expect((await f.agent.post('/api/v1/advances').send({
      employee_id: e.id,
      amount: 100000,
      instalment: 100000,
      reason: 'Test',
      granted_on: '2026-10-31'
    })).status).toBe(404);
  });
  it('retains exited employees historical assignments without blocking setup deletion', async () => {
    await prisma.employee.updateMany({
      data: {
        status: 'EXITED',
        last_day: toDbDate('2026-08-31')
      }
    });
    const group = await prisma.payGroup.findUnique({
        where: {
          id: f.payGroupId
        }
      }),
      template = await prisma.salaryStructure.findUnique({
        where: {
          id: f.structureId
        }
      });
    expect((await remove('structures', template.id, template.name)).status).toBe(200);
    expect((await remove('pay-groups', group.id, group.name)).status).toBe(200);
    expect(await prisma.employee.count({
      where: {
        pay_group_id: group.id,
        deleted_at: null
      }
    })).toBe(5);
    expect(await prisma.employeeSalary.count({
      where: {
        structure_id: template.id,
        deleted_at: null
      }
    })).toBe(5);
  });
  it('keeps an expired open offer linked until it is revoked', async () => {
    const template = await structure('Offer template');
    const offer = await prisma.offer.create({
      data: {
        employee_id: f.employees.OFFER,
        ref: 'TEST/OFFER',
        mode: 'GROSS',
        amount: 1800000n,
        monthly_gross: 1800000n,
        structure_id: template.id,
        issued_on: toDbDate('2026-01-01'),
        valid_till: toDbDate('2026-02-01')
      }
    });
    expect((await preview('structures', template.id)).body.data.assigned_count).toBe(1);
    expect((await remove('structures', template.id, template.name)).status).toBe(409);
    expect((await f.agent.post(`/api/v1/offers/${offer.id}/revoke`).send({
      reason: 'Replace structure'
    })).status).toBe(200);
    expect((await remove('structures', template.id, template.name)).status).toBe(200);
  });
  it('does not treat an already-onboarded offer as a current structure assignment', async () => {
    const template = await structure('Historical offer template');
    await prisma.offer.create({
      data: {
        employee_id: f.employees.ONBOARD,
        ref: 'TEST/HISTORY',
        mode: 'GROSS',
        amount: 1800000n,
        monthly_gross: 1800000n,
        structure_id: template.id,
        issued_on: toDbDate('2025-01-01'),
        accepted_on: toDbDate('2025-01-02'),
        valid_till: toDbDate('2026-12-01')
      }
    });
    expect((await preview('structures', template.id)).body.data.assigned_count).toBe(0);
    expect((await remove('structures', template.id, template.name)).status).toBe(200);
    expect(await prisma.offer.count({
      where: {
        structure_id: template.id
      }
    })).toBe(1);
  });
  it('enforces permissions and validates confirmations and IDs', async () => {
    const e = await person();
    expect((await request(app).delete(path('employees', e.id)).send({
      confirm_name: e.name
    })).status).toBe(401);
    expect((await remove('employees', 'bad-id', e.name)).status).toBe(422);
    expect((await remove('structures', randomUUID(), 'Missing')).status).toBe(404);
    await prisma.role.updateMany({
      data: {
        permissions: {
          set: ['people.read', 'setup.read']
        }
      }
    });
    invalidatePrincipal();
    expect((await preview('employees', e.id)).status).toBe(403);
    expect((await remove('employees', e.id, e.name)).status).toBe(403);
    expect((await preview('structures', f.structureId)).status).toBe(403);
    expect((await remove('pay-groups', f.payGroupId, 'Factory')).status).toBe(403);
  });
});
