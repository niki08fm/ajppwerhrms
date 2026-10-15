import { formatLongDate, istDate, offerCreateSchema, offerOnboardSchema, offerRevokeSchema } from '@ajpwer/shared';
import { audit, who } from '../utils/audit.js';
import { fromDbDate, n, toDbDate } from '../utils/dbDates.js';
import { AppError, notFound } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { prisma } from '../config/db.js';
import { loadEmployee, markTask, nextEmployeeCode, onboardingView } from '../services/employee.service.js';
import { issueLetter } from '../services/letter.service.js';
import { resolveMonthlyGross } from '../services/salary.service.js';
import { assertDepartmentAssignable } from '../services/department.service.js';

const today = () => istDate(new Date());

const offerOut = (o) =>
  o
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
        revoked_on: fromDbDate(o.revoked_on),
        revoke_reason: o.revoke_reason,
        revoked_by: o.revoked_by,
      }
    : null;

/** The hiring pipeline by status: on offer, accepted, onboarding, and offers revoked. */
export const listOffers = asyncHandler(async (_req, res) => {
  const revoked = await prisma.offer.findMany({
    where: { deleted_at: null, revoked_on: { not: null } },
    include: { employee: { include: { department: { select: { id: true, name: true } }, pay_group: { select: { id: true, name: true } } } } },
    orderBy: { revoked_on: 'desc' },
  });
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
        offer: offerOut(o),
        onboarding: onboardingView(p.onboarding_tasks),
      };
    }).concat(revoked.map((o) => ({
      id: o.employee.id,
      code: o.employee.code,
      name: o.employee.name,
      phone: o.employee.phone,
      designation: o.employee.designation,
      department: o.employee.department,
      pay_group: o.employee.pay_group,
      status: 'REVOKED',
      joined_on: fromDbDate(o.employee.joined_on),
      offer: offerOut(o),
      onboarding: null,
    }))),
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
  const { monthly_gross, amount: normalizedAmount, preview } = await resolveMonthlyGross(prisma, {
    mode: b.mode,
    amount: b.amount,
    structure_id: b.structure_id,
    date: b.join_by ?? today(),
    gender: b.gender,
    pt_state: b.pt_state,
    pf_enabled: b.pf_enabled ?? true,
    eps_enabled: b.eps_enabled ?? true,
    esi_enabled: b.esi_enabled ?? true,
    chosen_gross: b.chosen_gross,
  });
  const { actor, ip } = who(req);
  const company = await prisma.company.findFirst();
  const out = await prisma.$transaction(async (tx) => {
    const dept = await assertDepartmentAssignable(tx, b.department_id);
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
        joined_on: b.join_by ? toDbDate(b.join_by) : null,
        status: 'OFFER',
        statutory: { create: { pt_state: b.pt_state, pf_enabled: b.pf_enabled ?? true, eps_enabled: b.eps_enabled ?? true, esi_enabled: (b.esi_enabled ?? true) && preview.esi_within_ceiling } },
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
        amount: BigInt(normalizedAmount),
        monthly_gross: BigInt(monthly_gross),
        structure_id: b.structure_id,
        issued_on: toDbDate(today()),
        join_by: b.join_by ? toDbDate(b.join_by) : null,
        valid_till: toDbDate(b.valid_till),
      },
    });
    await tx.letter.create({
      data: {
        employee_id: e.id,
        kind: 'OFFER',
        ref,
        issued_on: toDbDate(today()),
        snapshot: JSON.parse(
          JSON.stringify({
            company: company ? { name: company.name, address: company.address } : null,
            employee: { code, name: b.name, designation: b.designation, department: dept?.name, joined_on: b.join_by ?? null },
            offer: { ref, mode: b.mode, amount: normalizedAmount, join_by: b.join_by ?? null, valid_till: b.valid_till },
            pay_group: group.name,
            salary: {
              mode: b.mode,
              amount: normalizedAmount,
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
    await audit(tx, { actor, ip, action: 'offer.issue', entity_type: 'employee', entity_id: e.id, detail: { ref, mode: b.mode, amount: normalizedAmount, entered_amount: b.amount, monthly_gross } });
    return { employee_id: e.id, code, offer_id: offer.id, ref, amount: normalizedAmount };
  });
  res.status(201).json({ data: out });
});

export const acceptOffer = asyncHandler(async (req, res) => {
  const offer = await prisma.offer.findUnique({ where: { id: req.params.id }, include: { employee: true } });
  if (!offer) throw notFound('That offer');
  if (offer.revoked_on) throw new AppError('INVALID_TRANSITION', `The offer to ${offer.employee.name} was revoked on ${fromDbDate(offer.revoked_on)}.`, 409);
  if (offer.employee.status !== 'OFFER') throw new AppError('INVALID_TRANSITION', `${offer.employee.name} is ${offer.employee.status}, not on offer.`, 409);
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    await tx.offer.update({ where: { id: offer.id }, data: { accepted_on: toDbDate(today()) } });
    await tx.employee.update({ where: { id: offer.employee_id }, data: { status: 'ACCEPTED' } });
    await audit(tx, { actor, ip, action: 'offer.accept', entity_type: 'employee', entity_id: offer.employee_id, detail: { ref: offer.ref } });
  });
  res.json({ data: { status: 'ACCEPTED' } });
});

/** Revoke an open or accepted offer. The person leaves the pipeline; the offer and its letter stay on record. */
export const revokeOffer = asyncHandler(async (req, res) => {
  const { reason } = offerRevokeSchema.parse(req.body ?? {});
  const offer = await prisma.offer.findUnique({ where: { id: req.params.id }, include: { employee: true } });
  if (!offer) throw notFound('That offer');
  if (offer.revoked_on) throw new AppError('INVALID_TRANSITION', `The offer to ${offer.employee.name} is already revoked.`, 409);
  if (!['OFFER', 'ACCEPTED'].includes(offer.employee.status)) {
    throw new AppError('INVALID_TRANSITION', `${offer.employee.name} is ${offer.employee.status.toLowerCase()}; only an open or accepted offer can be revoked.`, 409);
  }
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    await tx.offer.update({ where: { id: offer.id }, data: { revoked_on: toDbDate(today()), revoke_reason: reason, revoked_by: actor } });
    await tx.employee.update({ where: { id: offer.employee_id }, data: { deleted_at: new Date() } });
    await audit(tx, { actor, ip, action: 'offer.revoke', entity_type: 'employee', entity_id: offer.employee_id, detail: { ref: offer.ref, from: offer.employee.status, reason } });
  });
  res.json({ data: { status: 'REVOKED' } });
});

/**
 * Start onboarding accepted candidates from a joining date, all or none: the joining date,
 * the offered salary from that date, the joining letter issued, then the onboarding steps.
 */
async function onboardOffers(offerIds, joinedOn, actor, ip) {
  return prisma.$transaction(async (tx) => {
    const offers = await tx.offer.findMany({ where: { id: { in: offerIds }, deleted_at: null }, include: { employee: true } });
    if (offers.length !== new Set(offerIds).size) throw notFound('One of those offers');
    for (const offer of offers) {
      const name = offer.employee.name;
      if (offer.revoked_on || offer.employee.deleted_at) throw new AppError('INVALID_TRANSITION', `The offer to ${name} was revoked.`, 409);
      if (offer.employee.status !== 'ACCEPTED') throw new AppError('INVALID_TRANSITION', `Mark the offer accepted before onboarding. ${name} is ${offer.employee.status.toLowerCase()}.`, 409);
      const date = joinedOn ?? fromDbDate(offer.employee.joined_on);
      if (!date) throw new AppError('VALIDATION', `Give ${name}'s joining date to start onboarding.`, 422, 'joined_on');
      if (date < fromDbDate(offer.issued_on)) throw new AppError('VALIDATION', `${name}'s joining date cannot be before the offer was issued (${formatLongDate(fromDbDate(offer.issued_on))}).`, 422, 'joined_on');
    }
    const today_ = today();
    for (const offer of offers) {
      const date = joinedOn ?? fromDbDate(offer.employee.joined_on);
      await tx.offer.update({ where: { id: offer.id }, data: { join_by: toDbDate(date) } });
      await tx.employee.update({ where: { id: offer.employee_id }, data: { joined_on: toDbDate(date), status: 'ONBOARDING' } });
      await tx.employeeSalary.create({
        data: {
          employee_id: offer.employee_id,
          valid_from: toDbDate(date),
          mode: offer.mode,
          amount: offer.amount,
          monthly_gross: offer.monthly_gross,
          structure_id: offer.structure_id,
          reason: `As offered (${offer.ref})`,
          created_by: actor,
        },
      });
      await markTask(tx, offer.employee_id, 'PAY', actor);
      await audit(tx, { actor, ip, action: 'onboarding.start', entity_type: 'employee', entity_id: offer.employee_id, detail: { ref: offer.ref, joined_on: date } });
      // Formalities start once the joining letter is out: issue it now, with the date and salary.
      await issueLetter(tx, await loadEmployee(tx, offer.employee_id), 'JOINING', { today: today_, actor, ip });
    }
    return offers.map((o) => o.employee_id);
  }, { timeout: 120_000 });
}

/** Start onboarding one accepted candidate. The joining date may be given now or come from the offer. */
export const startOnboarding = asyncHandler(async (req, res) => {
  const b = offerOnboardSchema.pick({ joined_on: true }).partial().parse(req.body ?? {});
  const { actor, ip } = who(req);
  await onboardOffers([req.params.id], b.joined_on, actor, ip);
  res.json({ data: { status: 'ONBOARDING' } });
});

/** Start onboarding several accepted candidates from one joining date. */
export const startOnboardingMany = asyncHandler(async (req, res) => {
  const b = offerOnboardSchema.parse(req.body);
  const { actor, ip } = who(req);
  const ids = await onboardOffers(b.offer_ids, b.joined_on, actor, ip);
  res.json({ data: { status: 'ONBOARDING', employee_ids: ids } });
});
