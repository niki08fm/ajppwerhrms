import { z } from 'zod';
import {
  addDays,
  CALENDAR_METHODS,
  firstOfMonth,
  yearMonth,
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
  SEED_TAX_REGIMES,
  STATUTORY_MINIMUM_RATES,
  structureCreateSchema,
  ymOf,
} from '@ajpwer/shared';
import { calendarDivisor, salaryPreview, findOverlaps, validateStructure, workingDaysInMonth } from '../calculations/index.js';
import { audit, auditReq, who } from '../utils/audit.js';
import { fromDbDate, n, toDbDate } from '../utils/dbDates.js';
import { AppError, notFound } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { prisma } from '../config/db.js';
import { holidaysBetween, ptSlabs, ratesOn, regimesOn, toAttachedPolicy, toComponentDefs } from '../services/rules.service.js';
import { insertSalary } from '../services/salary.service.js';
import { firstOpenMonth, planStructureMove } from '../services/structureMove.service.js';
import { randomUUID } from 'node:crypto';

const today = () => istDate(new Date());

const SAMPLE_GROSS = 24_000_00;

// ─── Policies ────────────────────────────────────────────────────────────────

function policyView(p) {
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

export const listPolicies = asyncHandler(async (req, res) => {
  const kind = req.query.kind;
  const rows = await prisma.policy.findMany({
    where: { deleted_at: null, ...(kind ? { kind } : {}) },
    include: { pay_groups: { where: { deleted_at: null }, include: { pay_group: { select: { id: true, name: true } } } } },
    orderBy: [{ kind: 'asc' }, { name: 'asc' }, { version: 'desc' }],
  });
  res.json({ data: rows.map(policyView) });
});

export const listPolicyVersions = asyncHandler(async (req, res) => {
  const rows = await prisma.policy.findMany({
    where: { policy_key: req.params.key, deleted_at: null },
    include: { pay_groups: { where: { deleted_at: null }, include: { pay_group: { select: { id: true, name: true } } } } },
    orderBy: { version: 'desc' },
  });
  if (!rows.length) throw notFound('That policy');
  res.json({ data: rows.map(policyView) });
});

export const createPolicy = asyncHandler(async (req, res) => {
  const b = policyCreateSchema.parse(req.body);
  const rules = parsePolicyRules(b.kind, b.rules);
  const { actor, ip } = who(req);
  const p = await prisma.$transaction(async (tx) => {
    const created = await tx.policy.create({
      data: { policy_key: randomUUID(), kind: b.kind, name: b.name, version: 1, valid_from: toDbDate(b.valid_from), rules: rules, created_by: actor },
    });
    await audit(tx, { actor, ip, action: 'policy.create', entity_type: 'policy', entity_id: created.id, detail: { kind: b.kind, name: b.name, valid_from: b.valid_from, rules } });
    return created;
  });
  res.status(201).json({ data: policyView(p) });
});

/**
 * Editing a policy is not permitted. Publishing a new version closes the current
 * one the day before, creates version n+1, and attaches it wherever the old one
 * was. Both stay attached; the engine picks by date.
 */
export const createPolicyVersion = asyncHandler(async (req, res) => {
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
      data: { policy_key: latest.policy_key, kind: latest.kind, name: b.name ?? latest.name, version: latest.version + 1, valid_from: toDbDate(b.valid_from), rules: rules, created_by: actor },
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
      detail: {
        policy_key: latest.policy_key,
        from_version: latest.version,
        to_version: v.version,
        closed_on: addDays(b.valid_from, -1),
        valid_from: b.valid_from,
        old_rules: latest.rules,
        new_rules: rules,
        pay_groups: latest.pay_groups.map((x) => x.pay_group_id),
      },
    });
    return v;
  });
  res.status(201).json({ data: policyView(created) });
});

export const rejectPolicyEdit = (req, _res, next) => {
  if (req.method === 'PATCH' || req.method === 'PUT') return next(new AppError('FORBIDDEN', 'Policies are never edited. Publish a new version with an effective date instead.', 405));
  next();
};

// ─── Salary structures ───────────────────────────────────────────────────────

/** The PT state most people are in: the sensible default for a sample. */
async function commonPtState() {
  const rows = await prisma.employeeStatutory.groupBy({ by: ['pt_state'], _count: { pt_state: true }, orderBy: { _count: { pt_state: 'desc' } }, take: 1 }).catch(() => []);
  return rows[0]?.pt_state ?? 'Telangana';
}

/**
 * A structure at a sample salary, laid out the way a salary breakup reads:
 * earnings to gross, company contributions to CTC, deductions to net pay. PF,
 * ESI, PT and TDS are worked out from the rates, not typed in (new regime, no
 * declarations). "% of CTC" components run on the agreed CTC, or on the CTC a
 * gross works out to.
 */
async function sampleAt(components, sample) {
  const date = today();
  const [rates, slabs, regimes, ptState] = await Promise.all([
    ratesOn(prisma, date).catch(() => ({ ...STATUTORY_MINIMUM_RATES })),
    ptSlabs(prisma),
    regimesOn(prisma, date).catch(() => null),
    sample.pt_state ? Promise.resolve(sample.pt_state) : commonPtState(),
  ]);
  const regime = regimes?.NEW ?? SEED_TAX_REGIMES.find((r) => r.code === 'NEW');
  const breakup = salaryPreview({
    mode: sample.mode,
    amount: sample.amount,
    components,
    pf: { pf_enabled: sample.pf_enabled, pf_restrict_to_ceiling: true, vpf_pct: 0 },
    esi_enabled: sample.esi_enabled,
    pt: { pt_applicable: true, pt_state: ptState, gender: 'MALE' },
    rates: { pf: rates.pf, esi: rates.esi },
    pt_slabs: slabs,
    regime,
    declarations: { decl_80c: 0, decl_80d: 0, decl_rent_monthly: 0, decl_metro: false },
    month: Number(date.slice(5, 7)),
  });
  return { breakup, rates: { pf: rates.pf, esi: rates.esi }, pt_state: ptState, ctc_basis: breakup.ctc.ctc_basis };
}

const AT_SAMPLE_GROSS = { mode: 'GROSS', amount: SAMPLE_GROSS, pf_enabled: true, esi_enabled: true };

async function structureView(id) {
  const s = await prisma.salaryStructure.findUniqueOrThrow({
    where: { id },
    include: { components: { where: { deleted_at: null }, orderBy: { seq: 'asc' } }, pay_groups: { where: { deleted_at: null }, select: { id: true, name: true } } },
  });
  const components = toComponentDefs(s.components);
  const referenced = await prisma.payslip.count({ where: { employee: { salaries: { some: { structure_id: id } } } }, take: 1 }).catch(() => 0);
  const used = (await prisma.employeeSalary.count({ where: { structure_id: id } })) > 0;
  const d = toDbDate(today());
  const people = await prisma.employeeSalary.count({ where: { structure_id: id, deleted_at: null, valid_from: { lte: d }, OR: [{ valid_to: null }, { valid_to: { gte: d } }] } });
  const at = await sampleAt(components, AT_SAMPLE_GROSS);
  const sample = at.breakup.structure;
  return {
    id: s.id,
    name: s.name,
    created_at: s.created_at,
    duplicated_from: s.duplicated_from,
    components,
    pay_groups: s.pay_groups,
    /** People paid on this structure today */
    people,
    immutable: used || referenced > 0,
    sample: {
      gross: SAMPLE_GROSS,
      annual_ctc: at.breakup.ctc.annual_ctc,
      monthly: sample.monthly.map((c) => ({ name: c.name, amount: c.amount })),
      yearly: sample.yearly.map((c) => ({ name: c.name, amount: c.amount })),
      over_budget: sample.over_budget,
    },
    validation: validateStructure(components, SAMPLE_GROSS, at.ctc_basis),
  };
}

export const listStructures = asyncHandler(async (_req, res) => {
  const rows = await prisma.salaryStructure.findMany({ where: { deleted_at: null }, orderBy: [{ name: 'asc' }, { created_at: 'desc' }], select: { id: true } });
  res.json({ data: await Promise.all(rows.map((r) => structureView(r.id))) });
});

export const getStructure = asyncHandler(async (req, res) => {
  res.json({ data: await structureView(req.params.id) });
});

/** Live validation and preview for the builder — shown inline, not on submit. */
export const validateStructureDraft = asyncHandler(async (req, res) => {
  const b = z
    .object({
      components: structureCreateSchema.shape.components,
      sample: z
        .object({
          mode: z.enum(['GROSS', 'CTC']),
          amount: z.number().int().min(1),
          pf_enabled: z.boolean().default(true),
          esi_enabled: z.boolean().default(true),
          pt_state: z.string().min(1).optional(),
        })
        .strict(),
    })
    .strict()
    .parse(req.body);
  const components = b.components.map((c) => ({ ...c }));
  const at = await sampleAt(components, b.sample);
  res.json({ data: { ...validateStructure(components, at.breakup.gross, at.ctc_basis), breakup: at.breakup, rates: at.rates, pt_state: at.pt_state } });
});

/** Structures are never edited in place: "duplicate and edit" creates a new one with a new effective date. */
export const createStructure = asyncHandler(async (req, res) => {
  const b = structureCreateSchema.parse(req.body);
  const v = validateStructure(b.components, SAMPLE_GROSS, (await sampleAt(b.components, AT_SAMPLE_GROSS)).ctc_basis);
  if (v.errors.length) throw new AppError('VALIDATION', v.errors[0], 422, 'components', v.errors);
  const { actor, ip } = who(req);
  const s = await prisma.$transaction(async (tx) => {
    const created = await tx.salaryStructure.create({
      data: {
        name: b.name,
        duplicated_from: b.duplicated_from ?? null,
        created_by: actor,
        components: { create: b.components.map((c) => ({ ...c, calc_value: c.calc_value })) },
      },
    });
    await audit(tx, {
      actor,
      ip,
      action: 'structure.create',
      entity_type: 'salary_structure',
      entity_id: created.id,
      detail: { name: b.name, duplicated_from: b.duplicated_from, components: b.components },
    });
    return created;
  });
  res.status(201).json({ data: await structureView(s.id) });
});

// ─── Pay groups ──────────────────────────────────────────────────────────────

async function payGroupView(id) {
  const g = await prisma.payGroup.findUniqueOrThrow({
    where: { id },
    include: {
      shift: true,
      structure: { select: { id: true, name: true } },
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
    structure: g.structure,
    policies: attached.sort((a, b) => a.kind.localeCompare(b.kind) || b.version - a.version),
    headcount: g._count.employees,
    divisor_this_month: calendarDivisor(g.calendar_method, ym, workingDaysInMonth(ym, g.weekly_off, hol)),
    warnings: [
      ...POLICY_KINDS.filter((k) => !kindsNow.has(k)).map((k) => ({ kind: k, message: POLICY_KIND_MISSING_WARNING[k] })),
      ...findOverlaps(attached).map((o) => ({ kind: o.kind, message: `${o.a} and ${o.b} overlap from ${o.from}${o.to ? ` to ${o.to}` : ''}; the one starting later applies.` })),
    ],
  };
}

export const listPayGroups = asyncHandler(async (_req, res) => {
  const rows = await prisma.payGroup.findMany({ where: { deleted_at: null }, orderBy: { name: 'asc' }, select: { id: true } });
  res.json({ data: await Promise.all(rows.map((r) => payGroupView(r.id))) });
});

export const getPayGroup = asyncHandler(async (req, res) => {
  res.json({ data: await payGroupView(req.params.id) });
});

export const createPayGroup = asyncHandler(async (req, res) => {
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
});

/**
 * What attaching a different structure to this group would do: who moves, from
 * which month, and who cannot be moved (with the reason). Nothing is written.
 */
export const previewStructureMove = asyncHandler(async (req, res) => {
  const q = z.object({ structure_id: z.string().uuid(), from: yearMonth.optional() }).parse(req.query);
  const g = await prisma.payGroup.findFirst({ where: { id: req.params.id, deleted_at: null } });
  if (!g) throw notFound('That pay group');
  res.json({ data: { ...(await planStructureMove(prisma, g.id, q.structure_id, q.from)), first_open_month: await firstOpenMonth(prisma) } });
});

export const updatePayGroup = asyncHandler(async (req, res) => {
  const { structure_from, ...b } = payGroupPatchSchema.parse(req.body);
  const before = await prisma.payGroup.findUnique({ where: { id: req.params.id }, include: { policies: { where: { deleted_at: null } } } });
  if (!before) throw notFound('That pay group');
  // A new structure reaches everyone in the group from the chosen month, as a dated change on each salary.
  const plan = b.structure_id && b.structure_id !== before.structure_id ? await planStructureMove(prisma, before.id, b.structure_id, structure_from) : null;
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
    if (plan) {
      const from = firstOfMonth(plan.from);
      for (const m of plan.move) {
        await insertSalary(
          tx,
          m.employee.id,
          from,
          { mode: m.mode, amount: m.amount, monthly_gross: m.to_gross, structure_id: plan.structure.id, reason: `Pay group ${before.name} moved to ${plan.structure.name}` },
          actor,
        );
        await audit(tx, {
          actor,
          ip,
          action: 'salary.structure_change',
          entity_type: 'employee',
          entity_id: m.employee.id,
          detail: {
            pay_group_id: before.id,
            from: plan.from,
            from_structure_id: m.from_structure_id,
            to_structure_id: plan.structure.id,
            mode: m.mode,
            amount: m.amount,
            monthly_gross: { before: m.from_gross, after: m.to_gross },
          },
        });
      }
    }
    await audit(tx, {
      actor,
      ip,
      action: 'pay_group.update',
      entity_type: 'pay_group',
      entity_id: before.id,
      detail: {
        before: { ...before, policies: before.policies.map((p) => p.policy_id) },
        after: b,
        ...(plan ? { structure_move: { from: plan.from, moved: plan.move.length, unchanged: plan.unchanged, skipped: plan.skipped } } : {}),
      },
    });
  });
  res.json({
    data: {
      ...(await payGroupView(before.id)),
      structure_move: plan ? { from: plan.from, moved: plan.move.length, unchanged: plan.unchanged, skipped: plan.skipped } : null,
    },
  });
});

// ─── Statutory ───────────────────────────────────────────────────────────────
export const getStatutoryRates = asyncHandler(async (_req, res) => {
  const rows = await prisma.statutoryRates.findMany({ where: { deleted_at: null }, orderBy: { valid_from: 'desc' } });
  const date = today();
  const current = rows.find((r) => fromDbDate(r.valid_from) <= date) ?? null;
  res.json({ data: { current: current ? { ...current, valid_from: fromDbDate(current.valid_from) } : null, versions: rows.map((r) => ({ ...r, valid_from: fromDbDate(r.valid_from) })) } });
});

/** Rates are versioned: a change inserts a new row with its effective date. Old runs keep the row they used. */
export const publishStatutoryRates = asyncHandler(async (req, res) => {
  const b = statutoryRatesCreateSchema.parse(req.body);
  const { actor, ip } = who(req);
  const existing = await prisma.statutoryRates.findUnique({ where: { valid_from: toDbDate(b.valid_from) } });
  if (existing) {
    const used = await prisma.payrollPeriod.count({ where: { statutory_rates_id: existing.id } });
    if (used) throw new AppError('CONFLICT', `The rates effective ${b.valid_from} were used by a payroll run. Publish new rates with a later effective date.`, 409);
  }
  const row = await prisma.$transaction(async (tx) => {
    const r = existing
      ? await tx.statutoryRates.update({ where: { id: existing.id }, data: { pf: b.pf, esi: b.esi, recovery_cap_pct: b.recovery_cap_pct } })
      : await tx.statutoryRates.create({ data: { valid_from: toDbDate(b.valid_from), pf: b.pf, esi: b.esi, recovery_cap_pct: b.recovery_cap_pct, created_by: actor } });
    await audit(tx, {
      actor,
      ip,
      action: 'statutory_rates.publish',
      entity_type: 'statutory_rates',
      entity_id: r.id,
      detail: { ...b, replaced: existing ? { pf: existing.pf, esi: existing.esi } : null },
    });
    return r;
  });
  res.json({ data: { ...row, valid_from: fromDbDate(row.valid_from) } });
});

export const listPtSlabs = asyncHandler(async (_req, res) => {
  const [slabs, heads] = await Promise.all([
    prisma.ptSlab.findMany({ where: { deleted_at: null }, orderBy: [{ state: 'asc' }, { gender_scope: 'asc' }, { upto_amount: { sort: 'asc', nulls: 'last' } }] }),
    prisma.employeeStatutory.groupBy({ by: ['pt_state'], _count: true, where: { employee: { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE'] } } } }),
  ]);
  const states = [...new Set([...slabs.map((s) => s.state), ...heads.map((h) => h.pt_state)])].sort();
  res.json({
    data: states.map((state) => ({
      state,
      headcount: heads.find((h) => h.pt_state === state)?._count ?? 0,
      slabs: slabs
        .filter((s) => s.state === state)
        .map((s) => ({
          id: s.id,
          gender_scope: s.gender_scope,
          upto_amount: s.upto_amount === null ? null : n(s.upto_amount),
          amount: n(s.amount),
          feb_amount: s.feb_amount === null ? null : n(s.feb_amount),
        })),
    })),
  });
});

export const replacePtSlabs = asyncHandler(async (req, res) => {
  const b = ptSlabsReplaceSchema.parse(req.body);
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    const old = await tx.ptSlab.findMany({ where: { state: b.state, deleted_at: null } });
    await tx.ptSlab.updateMany({ where: { state: b.state, deleted_at: null }, data: { deleted_at: new Date() } });
    await tx.ptSlab.createMany({
      data: b.slabs.map((s) => ({
        state: b.state,
        gender_scope: s.gender_scope,
        upto_amount: s.upto_amount === null ? null : BigInt(s.upto_amount),
        amount: BigInt(s.amount),
        feb_amount: s.feb_amount === null ? null : BigInt(s.feb_amount),
      })),
    });
    await audit(tx, {
      actor,
      ip,
      action: 'pt_slabs.replace',
      entity_type: 'pt_slab',
      entity_id: null,
      detail: { state: b.state, old: old.map((o) => ({ upto: n(o.upto_amount), amount: n(o.amount) })), new: b.slabs },
    });
  });
  res.json({ data: { ok: true } });
});

export const listTaxRegimes = asyncHandler(async (_req, res) => {
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
});

// ─── Shifts, holidays, departments, company ──────────────────────────────────
export const listShifts = asyncHandler(async (_req, res) => {
  const rows = await prisma.shift.findMany({
    where: { deleted_at: null },
    include: { pay_groups: { where: { deleted_at: null }, select: { id: true, name: true } } },
    orderBy: { start_min: 'asc' },
  });
  res.json({ data: rows });
});

export const createShift = asyncHandler(async (req, res) => {
  const b = shiftSchema.parse(req.body);
  const s = await prisma.shift.create({ data: b });
  await auditReq(req, { action: 'shift.create', entity_type: 'shift', entity_id: s.id, detail: b });
  res.status(201).json({ data: s });
});

export const updateShift = asyncHandler(async (req, res) => {
  const b = shiftSchema.partial().strict().parse(req.body);
  const before = await prisma.shift.findUniqueOrThrow({ where: { id: req.params.id } });
  const s = await prisma.shift.update({ where: { id: req.params.id }, data: b });
  await auditReq(req, { action: 'shift.update', entity_type: 'shift', entity_id: s.id, detail: { before, after: b } });
  res.json({ data: s });
});

export const listHolidays = asyncHandler(async (req, res) => {
  const year = Number(req.query.year ?? today().slice(0, 4));
  const rows = await prisma.holiday.findMany({ where: { deleted_at: null, date: { gte: toDbDate(`${year}-01-01`), lte: toDbDate(`${year}-12-31`) } }, orderBy: { date: 'asc' } });
  const distinct = await Promise.all(
    rows.map(async (r) => ({ id: r.id, n: (await prisma.punch.findMany({ where: { work_date: r.date }, distinct: ['employee_id'], select: { employee_id: true } })).length })),
  );
  res.json({ data: rows.map((r) => ({ id: r.id, date: fromDbDate(r.date), name: r.name, worked_by: distinct.find((d) => d.id === r.id)?.n ?? 0 })) });
});

async function holidayLockWarning(date) {
  const p = await prisma.payrollPeriod.findUnique({ where: { period_ym: ymOf(date) } });
  if (p && (p.state === 'LOCKED' || p.state === 'PAID')) {
    return `${ymOf(date)} is ${p.state.toLowerCase()}. Its payslips are snapshots and will not change; the holiday affects only live figures.`;
  }
  return null;
}

export const createHoliday = asyncHandler(async (req, res) => {
  const b = holidaySchema.parse(req.body);
  const h = await prisma.holiday.upsert({ where: { date: toDbDate(b.date) }, update: { name: b.name, deleted_at: null }, create: { date: toDbDate(b.date), name: b.name } });
  await auditReq(req, { action: 'holiday.add', entity_type: 'holiday', entity_id: h.id, detail: b });
  res.status(201).json({ data: { id: h.id, date: b.date, name: b.name }, warning: await holidayLockWarning(b.date) });
});

export const deleteHoliday = asyncHandler(async (req, res) => {
  const h = await prisma.holiday.update({ where: { id: req.params.id }, data: { deleted_at: new Date() } });
  await auditReq(req, { action: 'holiday.remove', entity_type: 'holiday', entity_id: h.id, detail: { date: fromDbDate(h.date), name: h.name } });
  res.json({ data: { ok: true }, warning: await holidayLockWarning(fromDbDate(h.date)) });
});

export const listDepartments = asyncHandler(async (_req, res) => {
  const rows = await prisma.department.findMany({
    where: { deleted_at: null },
    orderBy: { name: 'asc' },
    include: { _count: { select: { employees: { where: { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE'] } } } } } },
  });
  res.json({ data: rows.map((d) => ({ id: d.id, name: d.name, colour: d.colour, headcount: d._count.employees })) });
});

export const createDepartment = asyncHandler(async (req, res) => {
  const b = departmentSchema.parse(req.body);
  const d = await prisma.department.create({ data: b });
  await auditReq(req, { action: 'department.create', entity_type: 'department', entity_id: d.id, detail: b });
  res.status(201).json({ data: d });
});

export const getCompany = asyncHandler(async (_req, res) => {
  res.json({ data: await prisma.company.findFirst() });
});

export const updateCompany = asyncHandler(async (req, res) => {
  const b = z
    .object({ name: z.string().min(1), address: z.string().nullable(), pan: z.string().nullable(), tan: z.string().nullable(), pf_code: z.string().nullable(), esi_code: z.string().nullable() })
    .partial()
    .strict()
    .parse(req.body);
  const c = await prisma.company.findFirst();
  const out = c ? await prisma.company.update({ where: { id: c.id }, data: b }) : await prisma.company.create({ data: { name: b.name ?? 'Company', ...b } });
  await auditReq(req, { action: 'company.update', entity_type: 'company', entity_id: out.id, detail: b });
  res.json({ data: out });
});

/** The calendar methods with a live figure — "on ₹26,000 a month, one day's pay in September is ₹1,000". */
export const listCalendarMethods = asyncHandler(async (req, res) => {
  const ym = req.query.month || ymOf(today());
  const weeklyOff = (req.query.weekly_off || 'SUN').split(',').filter(Boolean);
  const gross = Number(req.query.gross ?? 26_000_00);
  const hol = [...(await holidaysBetween(prisma, `${ym}-01`, `${ym}-31`)).keys()];
  const working = workingDaysInMonth(ym, weeklyOff, hol);
  res.json({
    data: CALENDAR_METHODS.map((m) => {
      const d = calendarDivisor(m, ym, working);
      return { method: m, divisor: d, day_rate: Math.round(gross / d) };
    }),
    meta: { month: ym, gross, working_days: working },
  });
});
