import { Router } from 'express';
import { z } from 'zod';
import {
  addDays,
  CALENDAR_METHODS,
  departmentSchema,
  holidaySchema,
  istDate,
  parsePolicyRules,
  payGroupPatchSchema,
  payGroupSchema,
  POLICY_KINDS,
  POLICY_KIND_MISSING_WARNING,
  policyCreateSchema,
  policyVersionSchema,
  ptSlabsReplaceSchema,
  shiftSchema,
  statutoryRatesCreateSchema,
  STATUTORY_MINIMUM_RATES,
  structureCreateSchema,
  ymOf,
  type PolicyKind,
} from '@ajpwer/shared';
import { calendarDivisor, ctcForGross, expandStructure, findOverlaps, validateStructure, workingDaysInMonth, type ComponentDef } from '../engines';
import { audit, auditReq, who } from '../lib/audit';
import { requirePerm } from '../lib/auth';
import { fromDbDate, n, toDbDate } from '../lib/db-dates';
import { ah, AppError, notFound } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { holidaysBetween, ratesOn, toAttachedPolicy, toComponentDefs } from '../services/rules';
import { randomUUID } from 'node:crypto';

export const setupRouter = Router();
const today = () => istDate(new Date());
const SAMPLE_GROSS = 24_000_00;

// ─── Policies ────────────────────────────────────────────────────────────────

function policyView(p: Awaited<ReturnType<typeof prisma.policy.findMany>>[number] & { pay_groups?: { pay_group: { id: string; name: string } }[] }) {
  return {
    id: p.id,
    policy_key: p.policy_key,
    kind: p.kind,
    name: p.name,
    version: p.version,
    valid_from: fromDbDate(p.valid_from),
    valid_to: fromDbDate(p.valid_to),
    status: p.status,
    rules: p.rules,
    created_by: p.created_by,
    created_at: p.created_at,
    pay_groups: p.pay_groups?.map((x) => x.pay_group) ?? [],
  };
}

setupRouter.get(
  '/policies',
  requirePerm('setup.read'),
  ah(async (req, res) => {
    const kind = req.query.kind as PolicyKind | undefined;
    const rows = await prisma.policy.findMany({
      where: { deleted_at: null, ...(kind ? { kind } : {}) },
      include: { pay_groups: { where: { deleted_at: null }, include: { pay_group: { select: { id: true, name: true } } } } },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }, { version: 'desc' }],
    });
    res.json({ data: rows.map(policyView) });
  }),
);

setupRouter.get(
  '/policies/:key/versions',
  requirePerm('setup.read'),
  ah(async (req, res) => {
    const rows = await prisma.policy.findMany({
      where: { policy_key: req.params.key, deleted_at: null },
      include: { pay_groups: { where: { deleted_at: null }, include: { pay_group: { select: { id: true, name: true } } } } },
      orderBy: { version: 'desc' },
    });
    if (!rows.length) throw notFound('That policy');
    res.json({ data: rows.map(policyView) });
  }),
);

setupRouter.post(
  '/policies',
  requirePerm('setup.write'),
  ah(async (req, res) => {
    const b = policyCreateSchema.parse(req.body);
    const rules = parsePolicyRules(b.kind, b.rules);
    const { actor, ip } = who(req);
    const p = await prisma.$transaction(async (tx) => {
      const created = await tx.policy.create({
        data: { policy_key: randomUUID(), kind: b.kind, name: b.name, version: 1, valid_from: toDbDate(b.valid_from), rules: rules as never, created_by: actor },
      });
      await audit(tx, { actor, ip, action: 'policy.create', entity_type: 'policy', entity_id: created.id, detail: { kind: b.kind, name: b.name, valid_from: b.valid_from, rules } });
      return created;
    });
    res.status(201).json({ data: policyView(p) });
  }),
);

/**
 * Editing a policy is not permitted. Publishing a new version closes the current
 * one the day before, creates version n+1, and attaches it wherever the old one
 * was. Both stay attached; the engine picks by date.
 */
setupRouter.post(
  '/policies/:key/versions',
  requirePerm('setup.write'),
  ah(async (req, res) => {
    const b = policyVersionSchema.parse(req.body);
    const { actor, ip } = who(req);
    const created = await prisma.$transaction(async (tx) => {
      const versions = await tx.policy.findMany({ where: { policy_key: req.params.key, deleted_at: null }, orderBy: { version: 'desc' }, include: { pay_groups: { where: { deleted_at: null } } } });
      if (!versions.length) throw notFound('That policy');
      const latest = versions[0];
      const rules = parsePolicyRules(latest.kind, b.rules);
      if (b.valid_from <= fromDbDate(latest.valid_from)) {
        throw new AppError('VALIDATION', `The new version must start after the current one (${fromDbDate(latest.valid_from)}).`, 422, 'valid_from');
      }
      if (latest.valid_to && fromDbDate(latest.valid_to) < addDays(b.valid_from, -1)) {
        // leave a documented gap: the engine falls back to defaults and flags it
      }
      await tx.policy.update({ where: { id: latest.id }, data: { valid_to: toDbDate(addDays(b.valid_from, -1)) } });
      const v = await tx.policy.create({
        data: { policy_key: latest.policy_key, kind: latest.kind, name: b.name ?? latest.name, version: latest.version + 1, valid_from: toDbDate(b.valid_from), rules: rules as never, created_by: actor },
      });
      for (const link of latest.pay_groups) {
        await tx.payGroupPolicy.create({ data: { pay_group_id: link.pay_group_id, policy_id: v.id } });
      }
      await audit(tx, {
        actor,
        ip,
        action: 'policy.version',
        entity_type: 'policy',
        entity_id: v.id,
        detail: { policy_key: latest.policy_key, from_version: latest.version, to_version: v.version, closed_on: addDays(b.valid_from, -1), valid_from: b.valid_from, old_rules: latest.rules, new_rules: rules, pay_groups: latest.pay_groups.map((x) => x.pay_group_id) },
      });
      return v;
    });
    res.status(201).json({ data: policyView(created) });
  }),
);

setupRouter.all(['/policies/:id', '/policies/:key/versions/:v'], (req, _res, next) => {
  if (req.method === 'PATCH' || req.method === 'PUT') return next(new AppError('FORBIDDEN', 'Policies are never edited. Publish a new version with an effective date instead.', 405));
  next();
});

// ─── Salary structures ───────────────────────────────────────────────────────

/**
 * A structure at a sample gross, for the builder and the list: someone on PF
 * (restricted to the ceiling), with ESI where the gross allows it. "% of CTC"
 * components run on the CTC that gross works out to.
 */
async function sampleAt(components: ComponentDef[], gross: number) {
  const rates = await ratesOn(prisma, today()).catch(() => ({ ...STATUTORY_MINIMUM_RATES }));
  const ctc = ctcForGross(gross, { components, pf: { pf_enabled: true, pf_restrict_to_ceiling: true, vpf_pct: 0 }, esi_enabled: true, rates: { pf: rates.pf, esi: rates.esi } });
  return { annual_ctc: ctc.annual_ctc, ctc_basis: ctc.ctc_basis, expanded: expandStructure(components, gross, ctc.ctc_basis) };
}

async function structureView(id: string) {
  const s = await prisma.salaryStructure.findUniqueOrThrow({
    where: { id },
    include: { components: { where: { deleted_at: null }, orderBy: { seq: 'asc' } }, pay_groups: { where: { deleted_at: null }, select: { id: true, name: true } } },
  });
  const components = toComponentDefs(s.components);
  const referenced = await prisma.payslip.count({ where: { employee: { salaries: { some: { structure_id: id } } } }, take: 1 }).catch(() => 0);
  const used = (await prisma.employeeSalary.count({ where: { structure_id: id } })) > 0;
  const at = await sampleAt(components, SAMPLE_GROSS);
  const sample = at.expanded;
  return {
    id: s.id,
    name: s.name,
    valid_from: fromDbDate(s.valid_from),
    duplicated_from: s.duplicated_from,
    components,
    pay_groups: s.pay_groups,
    immutable: used || referenced > 0,
    sample: { gross: SAMPLE_GROSS, annual_ctc: at.annual_ctc, monthly: sample.monthly.map((c) => ({ name: c.name, amount: c.amount })), yearly: sample.yearly.map((c) => ({ name: c.name, amount: c.amount })), over_budget: sample.over_budget },
    validation: validateStructure(components, SAMPLE_GROSS, at.ctc_basis),
  };
}

setupRouter.get(
  '/structures',
  requirePerm('setup.read'),
  ah(async (_req, res) => {
    const rows = await prisma.salaryStructure.findMany({ where: { deleted_at: null }, orderBy: [{ name: 'asc' }, { valid_from: 'desc' }], select: { id: true } });
    res.json({ data: await Promise.all(rows.map((r) => structureView(r.id))) });
  }),
);

setupRouter.get(
  '/structures/:id',
  requirePerm('setup.read'),
  ah(async (req, res) => {
    res.json({ data: await structureView(req.params.id) });
  }),
);

/** Live validation and preview for the builder — shown inline, not on submit. */
setupRouter.post(
  '/structures/validate',
  requirePerm('setup.read'),
  ah(async (req, res) => {
    const b = z.object({ components: structureCreateSchema.shape.components, sample_gross: z.number().int().min(1) }).strict().parse(req.body);
    const components = b.components.map((c) => ({ ...c }));
    const at = await sampleAt(components, b.sample_gross);
    res.json({ data: { ...validateStructure(components, b.sample_gross, at.ctc_basis), expanded: at.expanded, annual_ctc: at.annual_ctc } });
  }),
);

/** Structures are never edited in place: "duplicate and edit" creates a new one with a new effective date. */
setupRouter.post(
  '/structures',
  requirePerm('setup.write'),
  ah(async (req, res) => {
    const b = structureCreateSchema.parse(req.body);
    const v = validateStructure(b.components, SAMPLE_GROSS, (await sampleAt(b.components, SAMPLE_GROSS)).ctc_basis);
    if (v.errors.length) throw new AppError('VALIDATION', v.errors[0], 422, 'components', v.errors);
    const { actor, ip } = who(req);
    const s = await prisma.$transaction(async (tx) => {
      const created = await tx.salaryStructure.create({
        data: {
          name: b.name,
          valid_from: toDbDate(b.valid_from),
          duplicated_from: b.duplicated_from ?? null,
          created_by: actor,
          components: { create: b.components.map((c) => ({ ...c, calc_value: c.calc_value })) },
        },
      });
      await audit(tx, { actor, ip, action: 'structure.create', entity_type: 'salary_structure', entity_id: created.id, detail: { name: b.name, duplicated_from: b.duplicated_from, components: b.components } });
      return created;
    });
    res.status(201).json({ data: await structureView(s.id) });
  }),
);

// ─── Pay groups ──────────────────────────────────────────────────────────────

async function payGroupView(id: string) {
  const g = await prisma.payGroup.findUniqueOrThrow({
    where: { id },
    include: {
      shift: true,
      structure: { select: { id: true, name: true, valid_from: true } },
      policies: { where: { deleted_at: null }, include: { policy: true } },
      _count: { select: { employees: { where: { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE', 'ONBOARDING'] } } } } },
    },
  });
  const date = today();
  const attached = g.policies.filter((x) => !x.policy.deleted_at).map((x) => toAttachedPolicy(x.policy));
  const kindsNow = new Set(attached.filter((p) => p.valid_from <= date && (!p.valid_to || p.valid_to >= date)).map((p) => p.kind));
  const ym = ymOf(date);
  const hol = [...(await holidaysBetween(prisma, `${ym}-01`, `${ym}-31`)).keys()];
  return {
    id: g.id,
    name: g.name,
    frequency: g.frequency,
    pay_day: g.pay_day,
    calendar_method: g.calendar_method,
    weekly_off: g.weekly_off,
    shift: g.shift,
    structure: g.structure ? { ...g.structure, valid_from: fromDbDate(g.structure.valid_from) } : null,
    policies: attached.sort((a, b) => a.kind.localeCompare(b.kind) || b.version - a.version),
    headcount: g._count.employees,
    divisor_this_month: calendarDivisor(g.calendar_method, ym, workingDaysInMonth(ym, g.weekly_off as never, hol)),
    warnings: [
      ...POLICY_KINDS.filter((k) => !kindsNow.has(k)).map((k) => ({ kind: k, message: POLICY_KIND_MISSING_WARNING[k] })),
      ...findOverlaps(attached).map((o) => ({ kind: o.kind, message: `${o.a} and ${o.b} overlap from ${o.from}${o.to ? ` to ${o.to}` : ''}; the one starting later applies.` })),
    ],
  };
}

setupRouter.get(
  '/pay-groups',
  requirePerm('setup.read'),
  ah(async (_req, res) => {
    const rows = await prisma.payGroup.findMany({ where: { deleted_at: null }, orderBy: { name: 'asc' }, select: { id: true } });
    res.json({ data: await Promise.all(rows.map((r) => payGroupView(r.id))) });
  }),
);

setupRouter.get(
  '/pay-groups/:id',
  requirePerm('setup.read'),
  ah(async (req, res) => {
    res.json({ data: await payGroupView(req.params.id) });
  }),
);

setupRouter.post(
  '/pay-groups',
  requirePerm('setup.write'),
  ah(async (req, res) => {
    const b = payGroupSchema.parse(req.body);
    const { actor, ip } = who(req);
    const g = await prisma.$transaction(async (tx) => {
      const created = await tx.payGroup.create({
        data: {
          name: b.name,
          frequency: b.frequency,
          pay_day: b.pay_day,
          calendar_method: b.calendar_method,
          weekly_off: b.weekly_off,
          shift_id: b.shift_id,
          structure_id: b.structure_id,
          policies: { create: b.policy_ids.map((policy_id) => ({ policy_id })) },
        },
      });
      await audit(tx, { actor, ip, action: 'pay_group.create', entity_type: 'pay_group', entity_id: created.id, detail: b });
      return created;
    });
    res.status(201).json({ data: await payGroupView(g.id) });
  }),
);

setupRouter.patch(
  '/pay-groups/:id',
  requirePerm('setup.write'),
  ah(async (req, res) => {
    const b = payGroupPatchSchema.parse(req.body);
    const before = await prisma.payGroup.findUnique({ where: { id: req.params.id }, include: { policies: { where: { deleted_at: null } } } });
    if (!before) throw notFound('That pay group');
    const { actor, ip } = who(req);
    await prisma.$transaction(async (tx) => {
      const { policy_ids, ...core } = b;
      if (Object.keys(core).length) await tx.payGroup.update({ where: { id: before.id }, data: core });
      if (policy_ids) {
        const current = new Set(before.policies.map((p) => p.policy_id));
        const next = new Set(policy_ids);
        const toRemove = before.policies.filter((p) => !next.has(p.policy_id));
        for (const r of toRemove) await tx.payGroupPolicy.update({ where: { id: r.id }, data: { deleted_at: new Date() } });
        for (const pid of policy_ids) {
          if (current.has(pid)) continue;
          await tx.payGroupPolicy.upsert({
            where: { pay_group_id_policy_id: { pay_group_id: before.id, policy_id: pid } },
            update: { deleted_at: null },
            create: { pay_group_id: before.id, policy_id: pid },
          });
        }
      }
      await audit(tx, {
        actor,
        ip,
        action: 'pay_group.update',
        entity_type: 'pay_group',
        entity_id: before.id,
        detail: { before: { ...before, policies: before.policies.map((p) => p.policy_id) }, after: b },
      });
    });
    res.json({ data: await payGroupView(before.id) });
  }),
);

// ─── Statutory ───────────────────────────────────────────────────────────────

setupRouter.get(
  '/statutory-rates',
  requirePerm('setup.read'),
  ah(async (_req, res) => {
    const rows = await prisma.statutoryRates.findMany({ where: { deleted_at: null }, orderBy: { valid_from: 'desc' } });
    const date = today();
    const current = rows.find((r) => fromDbDate(r.valid_from) <= date) ?? null;
    res.json({ data: { current: current ? { ...current, valid_from: fromDbDate(current.valid_from) } : null, versions: rows.map((r) => ({ ...r, valid_from: fromDbDate(r.valid_from) })) } });
  }),
);

/** Rates are versioned: a change inserts a new row with its effective date. Old runs keep the row they used. */
setupRouter.patch(
  '/statutory-rates',
  requirePerm('setup.write'),
  ah(async (req, res) => {
    const b = statutoryRatesCreateSchema.parse(req.body);
    const { actor, ip } = who(req);
    const existing = await prisma.statutoryRates.findUnique({ where: { valid_from: toDbDate(b.valid_from) } });
    if (existing) {
      const used = await prisma.payrollPeriod.count({ where: { statutory_rates_id: existing.id } });
      if (used) throw new AppError('CONFLICT', `The rates effective ${b.valid_from} were used by a payroll run. Publish new rates with a later effective date.`, 409);
    }
    const row = await prisma.$transaction(async (tx) => {
      const r = existing
        ? await tx.statutoryRates.update({ where: { id: existing.id }, data: { pf: b.pf, esi: b.esi, gratuity: b.gratuity, recovery_cap_pct: b.recovery_cap_pct } })
        : await tx.statutoryRates.create({ data: { valid_from: toDbDate(b.valid_from), pf: b.pf, esi: b.esi, gratuity: b.gratuity, recovery_cap_pct: b.recovery_cap_pct, created_by: actor } });
      await audit(tx, { actor, ip, action: 'statutory_rates.publish', entity_type: 'statutory_rates', entity_id: r.id, detail: { ...b, replaced: existing ? { pf: existing.pf, esi: existing.esi } : null } });
      return r;
    });
    res.json({ data: { ...row, valid_from: fromDbDate(row.valid_from) } });
  }),
);

setupRouter.get(
  '/pt-slabs',
  requirePerm('setup.read'),
  ah(async (_req, res) => {
    const [slabs, heads] = await Promise.all([
      prisma.ptSlab.findMany({ where: { deleted_at: null }, orderBy: [{ state: 'asc' }, { gender_scope: 'asc' }, { upto_amount: { sort: 'asc', nulls: 'last' } }] }),
      prisma.employeeStatutory.groupBy({ by: ['pt_state'], _count: true, where: { employee: { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE'] } } } }),
    ]);
    const states = [...new Set([...slabs.map((s) => s.state), ...heads.map((h) => h.pt_state)])].sort();
    res.json({
      data: states.map((state) => ({
        state,
        headcount: heads.find((h) => h.pt_state === state)?._count ?? 0,
        slabs: slabs.filter((s) => s.state === state).map((s) => ({ id: s.id, gender_scope: s.gender_scope, upto_amount: s.upto_amount === null ? null : n(s.upto_amount), amount: n(s.amount), feb_amount: s.feb_amount === null ? null : n(s.feb_amount) })),
      })),
    });
  }),
);

setupRouter.patch(
  '/pt-slabs',
  requirePerm('setup.write'),
  ah(async (req, res) => {
    const b = ptSlabsReplaceSchema.parse(req.body);
    const { actor, ip } = who(req);
    await prisma.$transaction(async (tx) => {
      const old = await tx.ptSlab.findMany({ where: { state: b.state, deleted_at: null } });
      await tx.ptSlab.updateMany({ where: { state: b.state, deleted_at: null }, data: { deleted_at: new Date() } });
      await tx.ptSlab.createMany({
        data: b.slabs.map((s) => ({ state: b.state, gender_scope: s.gender_scope, upto_amount: s.upto_amount === null ? null : BigInt(s.upto_amount), amount: BigInt(s.amount), feb_amount: s.feb_amount === null ? null : BigInt(s.feb_amount) })),
      });
      await audit(tx, { actor, ip, action: 'pt_slabs.replace', entity_type: 'pt_slab', entity_id: null, detail: { state: b.state, old: old.map((o) => ({ upto: n(o.upto_amount), amount: n(o.amount) })), new: b.slabs } });
    });
    res.json({ data: { ok: true } });
  }),
);

setupRouter.get(
  '/tax-regimes',
  requirePerm('setup.read'),
  ah(async (_req, res) => {
    const rows = await prisma.taxRegime.findMany({ where: { deleted_at: null }, include: { slabs: { where: { deleted_at: null } } }, orderBy: [{ code: 'asc' }, { valid_from: 'desc' }] });
    const heads = await prisma.employeeStatutory.groupBy({ by: ['tax_regime_code'], _count: true, where: { employee: { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE'] } } } });
    res.json({
      data: rows.map((r) => ({
        ...r,
        valid_from: fromDbDate(r.valid_from),
        headcount: heads.find((h) => h.tax_regime_code === r.code)?._count ?? 0,
        slabs: r.slabs.map((s) => ({ upto_amount: s.upto_amount === null ? null : n(s.upto_amount), rate: Number(s.rate) })).sort((a, b) => (a.upto_amount ?? Infinity) - (b.upto_amount ?? Infinity)),
      })),
    });
  }),
);

// ─── Shifts, holidays, departments, company ──────────────────────────────────

setupRouter.get(
  '/shifts',
  requirePerm('setup.read'),
  ah(async (_req, res) => {
    const rows = await prisma.shift.findMany({ where: { deleted_at: null }, include: { pay_groups: { where: { deleted_at: null }, select: { id: true, name: true } } }, orderBy: { start_min: 'asc' } });
    res.json({ data: rows });
  }),
);

setupRouter.post(
  '/shifts',
  requirePerm('setup.write'),
  ah(async (req, res) => {
    const b = shiftSchema.parse(req.body);
    const s = await prisma.shift.create({ data: b });
    await auditReq(req, { action: 'shift.create', entity_type: 'shift', entity_id: s.id, detail: b });
    res.status(201).json({ data: s });
  }),
);

setupRouter.patch(
  '/shifts/:id',
  requirePerm('setup.write'),
  ah(async (req, res) => {
    const b = shiftSchema.partial().strict().parse(req.body);
    const before = await prisma.shift.findUniqueOrThrow({ where: { id: req.params.id } });
    const s = await prisma.shift.update({ where: { id: req.params.id }, data: b });
    await auditReq(req, { action: 'shift.update', entity_type: 'shift', entity_id: s.id, detail: { before, after: b } });
    res.json({ data: s });
  }),
);

setupRouter.get(
  '/holidays',
  requirePerm('setup.read'),
  ah(async (req, res) => {
    const year = Number(req.query.year ?? today().slice(0, 4));
    const rows = await prisma.holiday.findMany({ where: { deleted_at: null, date: { gte: toDbDate(`${year}-01-01`), lte: toDbDate(`${year}-12-31`) } }, orderBy: { date: 'asc' } });
    const distinct = await Promise.all(
      rows.map(async (r) => ({ id: r.id, n: (await prisma.punch.findMany({ where: { work_date: r.date }, distinct: ['employee_id'], select: { employee_id: true } })).length })),
    );
    res.json({ data: rows.map((r) => ({ id: r.id, date: fromDbDate(r.date), name: r.name, worked_by: distinct.find((d) => d.id === r.id)?.n ?? 0 })) });
  }),
);

async function holidayLockWarning(date: string): Promise<string | null> {
  const p = await prisma.payrollPeriod.findUnique({ where: { period_ym: ymOf(date) } });
  if (p && (p.state === 'LOCKED' || p.state === 'PAID')) {
    return `${ymOf(date)} is ${p.state.toLowerCase()}. Its payslips are snapshots and will not change; the holiday affects only live figures.`;
  }
  return null;
}

setupRouter.post(
  '/holidays',
  requirePerm('setup.write'),
  ah(async (req, res) => {
    const b = holidaySchema.parse(req.body);
    const h = await prisma.holiday.upsert({ where: { date: toDbDate(b.date) }, update: { name: b.name, deleted_at: null }, create: { date: toDbDate(b.date), name: b.name } });
    await auditReq(req, { action: 'holiday.add', entity_type: 'holiday', entity_id: h.id, detail: b });
    res.status(201).json({ data: { id: h.id, date: b.date, name: b.name }, warning: await holidayLockWarning(b.date) });
  }),
);

setupRouter.delete(
  '/holidays/:id',
  requirePerm('setup.write'),
  ah(async (req, res) => {
    const h = await prisma.holiday.update({ where: { id: req.params.id }, data: { deleted_at: new Date() } });
    await auditReq(req, { action: 'holiday.remove', entity_type: 'holiday', entity_id: h.id, detail: { date: fromDbDate(h.date), name: h.name } });
    res.json({ data: { ok: true }, warning: await holidayLockWarning(fromDbDate(h.date)) });
  }),
);

setupRouter.get(
  '/departments',
  requirePerm('people.read'),
  ah(async (_req, res) => {
    const rows = await prisma.department.findMany({ where: { deleted_at: null }, orderBy: { name: 'asc' }, include: { _count: { select: { employees: { where: { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE'] } } } } } } });
    res.json({ data: rows.map((d) => ({ id: d.id, name: d.name, colour: d.colour, headcount: d._count.employees })) });
  }),
);

setupRouter.post(
  '/departments',
  requirePerm('setup.write'),
  ah(async (req, res) => {
    const b = departmentSchema.parse(req.body);
    const d = await prisma.department.create({ data: b });
    await auditReq(req, { action: 'department.create', entity_type: 'department', entity_id: d.id, detail: b });
    res.status(201).json({ data: d });
  }),
);

setupRouter.get(
  '/company',
  requirePerm('setup.read'),
  ah(async (_req, res) => {
    res.json({ data: await prisma.company.findFirst() });
  }),
);

setupRouter.patch(
  '/company',
  requirePerm('setup.write'),
  ah(async (req, res) => {
    const b = z
      .object({ name: z.string().min(1), address: z.string().nullable(), pan: z.string().nullable(), tan: z.string().nullable(), pf_code: z.string().nullable(), esi_code: z.string().nullable() })
      .partial()
      .strict()
      .parse(req.body);
    const c = await prisma.company.findFirst();
    const out = c ? await prisma.company.update({ where: { id: c.id }, data: b }) : await prisma.company.create({ data: { name: b.name ?? 'Company', ...b } });
    await auditReq(req, { action: 'company.update', entity_type: 'company', entity_id: out.id, detail: b });
    res.json({ data: out });
  }),
);

/** The calendar methods with a live figure — "on ₹26,000 a month, one day's pay in September is ₹1,000". */
setupRouter.get(
  '/calendar-methods',
  requirePerm('setup.read'),
  ah(async (req, res) => {
    const ym = (req.query.month as string) || ymOf(today());
    const weeklyOff = ((req.query.weekly_off as string) || 'SUN').split(',').filter(Boolean);
    const gross = Number(req.query.gross ?? 26_000_00);
    const hol = [...(await holidaysBetween(prisma, `${ym}-01`, `${ym}-31`)).keys()];
    const working = workingDaysInMonth(ym, weeklyOff as never, hol);
    res.json({
      data: CALENDAR_METHODS.map((m) => {
        const d = calendarDivisor(m, ym, working);
        return { method: m, divisor: d, day_rate: Math.round(gross / d) };
      }),
      meta: { month: ym, gross, working_days: working },
    });
  }),
);
