import { istDate, offerCreateSchema } from '@ajpwer/shared';
import { audit, who } from '../utils/audit.js';
import { fromDbDate, n, toDbDate } from '../utils/dbDates.js';
import { AppError, notFound } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { prisma } from '../config/db.js';
import { markTask, nextEmployeeCode, onboardingView } from '../services/employee.service.js';
import { resolveMonthlyGross } from '../services/salary.service.js';

const today = () => istDate(new Date());

/** The hiring pipeline, three tabs by status. */
export const listOffers = asyncHandler(async (_req, res) => {
  const people = await prisma.employee.findMany({
    where: { deleted_at: null, status: { in: ['OFFER', 'ACCEPTED', 'ONBOARDING'] } },
    include: {
      offers: { where: { deleted_at: null }, orderBy: { created_at: 'desc' }, take: 1 },
      department: { select: { id: true, name: true } },
      pay_group: { select: { id: true, name: true } },
      onboarding_tasks: true,
    },
    orderBy: { created_at: 'desc' },
  });
  res.json({
    data: people.map((p) => {
      const o = p.offers[0];
      return {
        id: p.id,
        code: p.code,
        name: p.name,
        phone: p.phone,
        designation: p.designation,
        department: p.department,
        pay_group: p.pay_group,
        status: p.status,
        joined_on: fromDbDate(p.joined_on),
        offer: o
          ? {
              id: o.id,
              ref: o.ref,
              mode: o.mode,
              amount: n(o.amount),
              monthly_gross: n(o.monthly_gross),
              structure_id: o.structure_id,
              issued_on: fromDbDate(o.issued_on),
              join_by: fromDbDate(o.join_by),
              valid_till: fromDbDate(o.valid_till),
              accepted_on: fromDbDate(o.accepted_on),
            }
          : null,
        onboarding: onboardingView(p.onboarding_tasks),
      };
    }),
  });
});

/**
 * Issue an offer: creates the person at OFFER status, the offer, and an offer
 * letter whose snapshot freezes the exact figures stated.
 */
export const createOffer = asyncHandler(async (req, res) => {
  const b = offerCreateSchema.parse(req.body);
  const group = await prisma.payGroup.findFirst({ where: { id: b.pay_group_id, deleted_at: null } });
  if (!group) throw notFound('Pay group');
  const { monthly_gross, preview } = await resolveMonthlyGross(prisma, {
    mode: b.mode,
    amount: b.amount,
    structure_id: b.structure_id,
    date: b.join_by,
    gender: b.gender,
    pt_state: b.pt_state,
    pf_enabled: b.pf_enabled ?? true,
    esi_enabled: b.esi_enabled ?? true,
    chosen_gross: b.chosen_gross,
  });
  const { actor, ip } = who(req);
  const company = await prisma.company.findFirst();
  const out = await prisma.$transaction(async (tx) => {
    const code = await nextEmployeeCode(tx);
    const e = await tx.employee.create({
      data: {
        code,
        name: b.name,
        gender: b.gender,
        phone: b.phone,
        email: b.email ?? null,
        department_id: b.department_id,
        designation: b.designation,
        pay_group_id: b.pay_group_id,
        joined_on: toDbDate(b.join_by),
        status: 'OFFER',
        statutory: { create: { pt_state: b.pt_state, pf_enabled: b.pf_enabled ?? true, esi_enabled: (b.esi_enabled ?? true) && preview.esi_within_ceiling } },
        identity: { create: {} },
      },
    });
    const count = await tx.offer.count();
    const ref = `AJPWER/OFR/${today().slice(0, 4)}/${String(count + 1).padStart(5, '0')}`;
    const offer = await tx.offer.create({
      data: {
        employee_id: e.id,
        ref,
        mode: b.mode,
        amount: BigInt(b.amount),
        monthly_gross: BigInt(monthly_gross),
        structure_id: b.structure_id,
        issued_on: toDbDate(today()),
        join_by: toDbDate(b.join_by),
        valid_till: toDbDate(b.valid_till),
      },
    });
    const dept = await tx.department.findUnique({ where: { id: b.department_id } });
    await tx.letter.create({
      data: {
        employee_id: e.id,
        kind: 'OFFER',
        ref,
        issued_on: toDbDate(today()),
        snapshot: JSON.parse(
          JSON.stringify({
            company: company ? { name: company.name, address: company.address } : null,
            employee: { code, name: b.name, designation: b.designation, department: dept?.name, joined_on: b.join_by },
            offer: { ref, mode: b.mode, amount: b.amount, join_by: b.join_by, valid_till: b.valid_till },
            pay_group: group.name,
            salary: {
              mode: b.mode,
              amount: b.amount,
              monthly_gross,
              annual_ctc: preview.ctc.annual_ctc,
              components: preview.structure.monthly.map((c) => ({ name: c.name, amount: c.amount })),
              yearly: preview.structure.yearly.map((c) => ({ name: c.name, amount: c.amount })),
              employer_pf: preview.ctc.employer_pf,
              employer_esi: preview.ctc.employer_esi,
              take_home: preview.take_home,
            },
            generated_on: today(),
          }),
        ),
      },
    });
    await audit(tx, { actor, ip, action: 'offer.issue', entity_type: 'employee', entity_id: e.id, detail: { ref, mode: b.mode, amount: b.amount, monthly_gross } });
    return { employee_id: e.id, code, offer_id: offer.id, ref };
  });
  res.status(201).json({ data: out });
});

export const acceptOffer = asyncHandler(async (req, res) => {
  const offer = await prisma.offer.findUnique({ where: { id: req.params.id }, include: { employee: true } });
  if (!offer) throw notFound('That offer');
  if (offer.employee.status !== 'OFFER') throw new AppError('INVALID_TRANSITION', `${offer.employee.name} is ${offer.employee.status}, not on offer.`, 409);
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    await tx.offer.update({ where: { id: offer.id }, data: { accepted_on: toDbDate(today()) } });
    await tx.employee.update({ where: { id: offer.employee_id }, data: { status: 'ACCEPTED' } });
    await audit(tx, { actor, ip, action: 'offer.accept', entity_type: 'employee', entity_id: offer.employee_id, detail: { ref: offer.ref } });
  });
  res.json({ data: { status: 'ACCEPTED' } });
});

/** Start onboarding: the salary record effective from the joining date, and the checklist. */
export const startOnboarding = asyncHandler(async (req, res) => {
  const offer = await prisma.offer.findUnique({ where: { id: req.params.id }, include: { employee: true } });
  if (!offer) throw notFound('That offer');
  if (offer.employee.status !== 'ACCEPTED') throw new AppError('INVALID_TRANSITION', `Mark the offer accepted before onboarding. ${offer.employee.name} is ${offer.employee.status}.`, 409);
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    await tx.employeeSalary.create({
      data: {
        employee_id: offer.employee_id,
        valid_from: offer.employee.joined_on,
        mode: offer.mode,
        amount: offer.amount,
        monthly_gross: offer.monthly_gross,
        structure_id: offer.structure_id,
        reason: `As offered (${offer.ref})`,
        created_by: actor,
      },
    });
    await tx.employee.update({ where: { id: offer.employee_id }, data: { status: 'ONBOARDING' } });
    await markTask(tx, offer.employee_id, 'PAY', actor);
    await audit(tx, { actor, ip, action: 'onboarding.start', entity_type: 'employee', entity_id: offer.employee_id, detail: { ref: offer.ref } });
  });
  res.json({ data: { status: 'ONBOARDING' } });
});
