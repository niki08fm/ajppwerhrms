import { z } from 'zod';
import { Prisma } from '@prisma/client';
import {
  addDays,
  CALENDAR_METHODS,
  holidaySchema,
  isoDate,
  istDate,
  lastOfMonth,
  parsePolicyRules,
  payGroupPatchSchema,
  payGroupSchema,
  POLICY_KINDS,
  POLICY_KIND_MISSING_WARNING,
  policyCreateSchema,
  policyVersionSchema,
  policyVersionPatchSchema,
  ptSlabsReplaceSchema,
  shiftSchema,
  statutoryRatesCreateSchema,
  taxRegimePublishSchema,
  SEED_TAX_REGIMES,
  STATUTORY_MINIMUM_RATES,
  structureCreateSchema,
  uuid,
  ymOf,
} from '@ajpwer/shared';
import { calendarDivisor, salaryPreview, findOverlaps, validateStructure, workingDaysInMonth } from '../calculations/index.js';
import { audit, auditReq, who } from '../utils/audit.js';
import { fromDbDate, n, toDbDate } from '../utils/dbDates.js';
import { AppError, notFound } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { prisma } from '../config/db.js';
import { holidaysBetween, ptSlabs, ratesOn, regimesOn, toAttachedPolicy, toComponentDefs } from '../services/rules.service.js';
import { clipToLink, effectiveFrom, movePayGroup } from '../services/assignment-dates.service.js';
import { randomUUID } from 'node:crypto';
import { addDepartment, changeDepartment, listDepartmentSettings, removeDepartment } from '../services/department.service.js';
import { editPolicyVersion, lockPolicyRulesRead, policyHistoryProtection, publishPolicyVersion, removePolicyVersion } from '../services/policy-history.service.js';

import {lockAssignments} from '../services/master-data-lock.js';

const today = () => istDate(new Date());

const SAMPLE_GROSS = 24_000_00;

// ─── Policies ────────────────────────────────────────────────────────────────

function policyView(p, protection) {
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
    ...(protection ?? {}),
  };
}

export const listPolicies = asyncHandler(async (req, res) => {
  const kind = req.query.kind;
  const rows = await prisma.policy.findMany({
    where: { deleted_at: null, ...(kind ? { kind } : {}) },
    include: { pay_groups: { where: { deleted_at: null }, include: { pay_group: { select: { id: true, name: true } } } } },
    orderBy: [{ kind: 'asc' }, { name: 'asc' }, { version: 'desc' }],
  });
  const protection = await policyHistoryProtection(prisma, rows);
  res.json({ data: rows.map((row) => policyView(row, protection.get(row.id))) });
});

export const listPolicyVersions = asyncHandler(async (req, res) => {
  const rows = await prisma.policy.findMany({
    where: { policy_key: uuid.parse(req.params.key), deleted_at: null },
    include: { pay_groups: { where: { deleted_at: null }, include: { pay_group: { select: { id: true, name: true } } } } },
    orderBy: { version: 'desc' },
  });
  if (!rows.length) throw notFound('That policy');
  const protection = await policyHistoryProtection(prisma, rows);
  res.json({ data: rows.map((row) => policyView(row, protection.get(row.id))) });
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

/** Publish dated rules; frozen pay is checked before closing an older version. */
export const createPolicyVersion = asyncHandler(async (req, res) => {
  const b = policyVersionSchema.parse(req.body);
  const key = uuid.parse(req.params.key);
  const created = await prisma.$transaction((tx) => publishPolicyVersion(tx, key, b, who(req)));
  res.status(201).json({ data: policyView(created) });
});

const policyVersionNumber = z.coerce.number().int().positive();
export const updatePolicyVersion = asyncHandler(async (req, res) => {
  const key = uuid.parse(req.params.key);
  const version = policyVersionNumber.parse(req.params.version);
  const body = policyVersionPatchSchema.parse(req.body);
  const updated = await prisma.$transaction((tx) => editPolicyVersion(tx, key, version, body, who(req)));
  res.json({ data: policyView(updated) });
});

export const deletePolicyVersion = asyncHandler(async (req, res) => {
  const key = uuid.parse(req.params.key);
  const version = policyVersionNumber.parse(req.params.version);
  const deleted = await prisma.$transaction((tx) => removePolicyVersion(tx, key, version, who(req)));
  res.json({ data: deleted });
});

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
async function sampleInputs(sample) {
  const date = today();
  const [rates, slabs, regimes, ptState] = await Promise.all([
    ratesOn(prisma, date).catch(() => ({ ...STATUTORY_MINIMUM_RATES })),
    ptSlabs(prisma, date),
    regimesOn(prisma, date).catch(() => null),
    sample.pt_state ? Promise.resolve(sample.pt_state) : commonPtState(),
  ]);
  return { date, rates, slabs, regimes, ptState };
}

async function sampleAt(components, sample, inputs = null) {
  const { date, rates, slabs, regimes, ptState } = inputs ?? await sampleInputs(sample);
  const regime = regimes?.NEW ?? SEED_TAX_REGIMES.find((r) => r.code === 'NEW');
  const breakup = salaryPreview({
    mode: sample.mode,
    amount: sample.amount,
    chosen_gross: sample.chosen_gross,
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

async function structureView(id, options = {}) {
  const s = options.row ?? await prisma.salaryStructure.findFirst({
    where: { id, deleted_at:null },
    include: { components: { where: { deleted_at: null }, orderBy: { seq: 'asc' } } },
  });
  if(!s)throw notFound('That salary structure');
  const components = toComponentDefs(s.components);
  const d = toDbDate(today());
  // Any payslip reference through a salary row already implies used=true.
  const [used, people, at] = await Promise.all([
    options.used !== undefined ? options.used : prisma.employeeSalary.count({ where: { structure_id: id } }).then((n) => n > 0),
    options.people !== undefined ? options.people : prisma.employeeSalary.count({ where: { structure_id: id, deleted_at: null, employee:{deleted_at:null,status:{not:'EXITED'}}, valid_from: { lte: d }, OR: [{ valid_to: null }, { valid_to: { gte: d } }] } }),
    sampleAt(components, AT_SAMPLE_GROSS, options.inputs),
  ]);
  const sample = at.breakup.structure;
  return {
    id: s.id,
    name: s.name,
    created_at: s.created_at,
    duplicated_from: s.duplicated_from,
    components,
    /** People paid on this structure today */
    people,
    immutable: used,
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
  const rows = await prisma.salaryStructure.findMany({ where: { deleted_at: null }, orderBy: [{ name: 'asc' }, { created_at: 'desc' }], include: { components: { where: { deleted_at: null }, orderBy: { seq: 'asc' } } } });
  if (!rows.length) return res.json({ data: [] });
  const ids = rows.map((row) => row.id);
  const d = toDbDate(today());
  const [usedRows, peopleRows, inputs] = await Promise.all([
    prisma.employeeSalary.groupBy({ by: ['structure_id'], where: { structure_id: { in: ids } }, _count: { _all: true } }),
    prisma.employeeSalary.groupBy({ by: ['structure_id'], where: { structure_id: { in: ids }, deleted_at: null, employee:{deleted_at:null,status:{not:'EXITED'}}, valid_from: { lte: d }, OR: [{ valid_to: null }, { valid_to: { gte: d } }] }, _count: { _all: true } }),
    sampleInputs(AT_SAMPLE_GROSS),
  ]);
  const used = new Set(usedRows.map((row) => row.structure_id));
  const people = new Map(peopleRows.map((row) => [row.structure_id, row._count._all]));
  res.json({ data: await Promise.all(rows.map((row) => structureView(row.id, { row, used: used.has(row.id), people: people.get(row.id) ?? 0, inputs }))) });
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
          chosen_gross: z.number().int().min(0).optional(),
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

const payGroupViewInclude = {
  shift: true,
  // Current links; links ended by a dated change show as history.
  policies: { where: { deleted_at: null }, include: { policy: true } },
  _count: { select: { employees: { where: { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE', 'ONBOARDING'] } } } } },
};

async function payGroupView(id, options = {}) {
  const g = options.row ?? await prisma.payGroup.findUniqueOrThrow({
    where: { id },
    include: payGroupViewInclude,
  });
  const date = today();
  const live = g.policies.filter((x) => !x.policy.deleted_at);
  const attached = live.filter((x) => !x.effective_to).map((x) => clipToLink(toAttachedPolicy(x.policy), x)).filter(Boolean);
  const ended = live.filter((x) => x.effective_to).map((x) => ({ ...clipToLink(toAttachedPolicy(x.policy), x), ended_on: fromDbDate(x.effective_to) })).filter((x) => x.kind);
  const kindsNow = new Set(attached.filter((p) => p.valid_from <= date && (!p.valid_to || p.valid_to >= date)).map((p) => p.kind));
  const ym = ymOf(date);
  const hol = options.holidays ?? [...(await holidaysBetween(prisma, `${ym}-01`, lastOfMonth(ym))).keys()];
  return {
    id: g.id,
    name: g.name,
    frequency: g.frequency,
    pay_day: g.pay_day,
    calendar_method: g.calendar_method,
    weekly_off: g.weekly_off,
    shift: g.shift,
    policies: attached.sort((a, b) => a.kind.localeCompare(b.kind) || b.version - a.version),
    policy_history: ended.sort((a, b) => a.kind.localeCompare(b.kind) || b.ended_on.localeCompare(a.ended_on)),
    headcount: g._count.employees,
    divisor_this_month: calendarDivisor(g.calendar_method, ym, workingDaysInMonth(ym, g.weekly_off, hol)),
    warnings: [
      ...POLICY_KINDS.filter((k) => !kindsNow.has(k)).map((k) => ({ kind: k, message: POLICY_KIND_MISSING_WARNING[k] })),
      ...findOverlaps(attached).map((o) => ({ kind: o.kind, message: `${o.a} and ${o.b} overlap from ${o.from}${o.to ? ` to ${o.to}` : ''}; the one starting later applies.` })),
    ],
  };
}

export const listPayGroups = asyncHandler(async (_req, res) => {
  const ym = ymOf(today());
  const [rows, holidays] = await Promise.all([
    prisma.payGroup.findMany({ where: { deleted_at: null }, orderBy: { name: 'asc' }, include: payGroupViewInclude }),
    holidaysBetween(prisma, `${ym}-01`, lastOfMonth(ym)),
  ]);
  res.json({ data: await Promise.all(rows.map((row) => payGroupView(row.id, { row, holidays: [...holidays.keys()] }))) });
});

export const getPayGroup = asyncHandler(async (req, res) => {
  res.json({ data: await payGroupView(req.params.id) });
});

export const createPayGroup = asyncHandler(async (req, res) => {
  const b = payGroupSchema.parse(req.body);
  const { actor, ip } = who(req);
  const g = await prisma.$transaction(async (tx) => {
    await lockPolicyRulesRead(tx);
    await validateGroupPolicies(tx, b.policy_ids);
    const created = await tx.payGroup.create({
      data: {
        name: b.name,
        frequency: b.frequency,
        pay_day: b.pay_day,
        calendar_method: b.calendar_method,
        weekly_off: b.weekly_off,
        shift_id: b.shift_id,
        policies: { create: b.policy_ids.map((policy_id) => ({ policy_id })) },
      },
    });
    await audit(tx, { actor, ip, action: 'pay_group.create', entity_type: 'pay_group', entity_id: created.id, detail: b });
    return created;
  });
  res.status(201).json({ data: await payGroupView(g.id) });
});

/** A group selects one policy lineage per kind; all dated versions can stay attached. */
async function validateGroupPolicies(db, ids) {
  if (!ids.length) return;
  const policies = await db.policy.findMany({ where: { id: { in: ids }, deleted_at: null }, select: { id: true, kind: true, policy_key: true } });
  if (policies.length !== ids.length) throw new AppError('VALIDATION', 'Choose existing policies without duplicates.', 422, 'policy_ids');
  const byKind = new Map();
  for (const policy of policies) {
    const selected = byKind.get(policy.kind);
    if (selected && selected !== policy.policy_key) {
      throw new AppError('VALIDATION', 'Choose one policy for each kind. Versions of the same policy can stay attached.', 422, 'policy_ids');
    }
    byKind.set(policy.kind, policy.policy_key);
  }
}

export const updatePayGroup = asyncHandler(async (req, res) => {
  const b = payGroupPatchSchema.parse(req.body);
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    await lockAssignments(tx);
    await lockPolicyRulesRead(tx);
    const before = await tx.payGroup.findFirst({ where: { id: req.params.id, deleted_at: null }, include: { policies: { where: { deleted_at: null } } } });
    if (!before) throw notFound('That pay group');
    const { policy_ids, policies_effective_from, ...core } = b;
    if (policy_ids) await validateGroupPolicies(tx, policy_ids);
    if (Object.keys(core).length) await tx.payGroup.update({ where: { id: before.id }, data: core });
    if (policy_ids) {
      // A change to the attached policies applies from a date and never reaches locked or paid payroll.
      const from = await effectiveFrom(tx, policies_effective_from, { field: 'policies_effective_from' });
      const currentLinks = before.policies.filter((p) => !p.effective_to);
      const current = new Set(currentLinks.map((p) => p.policy_id));
      const next = new Set(policy_ids);
      for (const link of currentLinks.filter((p) => !next.has(p.policy_id))) {
        const started = fromDbDate(link.effective_from);
        if (!from || (started && started >= from)) await tx.payGroupPolicy.update({ where: { id: link.id }, data: { deleted_at: new Date() } });
        else await tx.payGroupPolicy.update({ where: { id: link.id }, data: { effective_to: toDbDate(addDays(from, -1)) } });
      }
      for (const pid of policy_ids) {
        if (current.has(pid)) continue;
        const existing = await tx.payGroupPolicy.findUnique({ where: { pay_group_id_policy_id: { pay_group_id: before.id, policy_id: pid } } });
        if (existing && !existing.deleted_at && existing.effective_to) {
          // Re-attaching a policy this group stopped using: only when no dates fall between.
          if (from && addDays(fromDbDate(existing.effective_to), 1) < from) {
            throw new AppError('POLICY_GAP', 'This pay group stopped using that policy earlier. Re-attach it from the day after it ended, or publish a new version of it.', 409, 'policy_ids');
          }
          await tx.payGroupPolicy.update({ where: { id: existing.id }, data: { effective_to: null } });
        } else if (existing) {
          await tx.payGroupPolicy.update({ where: { id: existing.id }, data: { deleted_at: null, effective_from: from ? toDbDate(from) : null, effective_to: null } });
        } else {
          await tx.payGroupPolicy.create({ data: { pay_group_id: before.id, policy_id: pid, effective_from: from ? toDbDate(from) : null } });
        }
      }
      b.policies_effective_from = from;
    }
    await audit(tx, {
      actor, ip, action: 'pay_group.update', entity_type: 'pay_group', entity_id: before.id,
      detail: { before: { ...before, policies: before.policies.map((p) => p.policy_id) }, after: b },
    });
  });
  res.json({ data: await payGroupView(req.params.id) });
});

const groupMemberFields = { id: true, code: true, name: true, status: true, pay_group_id: true };

export const listPayGroupEmployees = asyncHandler(async (req, res) => {
  const group = await prisma.payGroup.findFirst({ where: { id: req.params.id, deleted_at: null }, select: { id: true } });
  if (!group) throw notFound('That pay group');
  const employees = await prisma.employee.findMany({
    where: { pay_group_id: group.id, deleted_at: null }, select: groupMemberFields, orderBy: [{ name: 'asc' }, { code: 'asc' }],
  });
  res.json({ data: employees });
});

/** Membership changes attendance/pay rules only; employee salary history stays intact. */
export const movePayGroupEmployees = asyncHandler(async (req, res) => {
  const { employee_ids: inputIds, effective_from: requestedFrom } = z.object({ employee_ids: z.array(z.string().uuid()).min(1).max(1000), effective_from: isoDate.optional() }).strict().parse(req.body);
  const ids = [...new Set(inputIds)].sort();
  const { actor, ip } = who(req);
  const result = await prisma.$transaction(async (tx) => {
    await lockAssignments(tx);
    const group = await tx.payGroup.findFirst({ where: { id: req.params.id, deleted_at: null }, select: { id: true } });
    if (!group) throw notFound('That pay group');
    // Lock in stable order so overlapping membership requests audit the actual prior group.
    await tx.$queryRaw(Prisma.sql`SELECT id FROM employee WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`);
    const employees = await tx.employee.findMany({ where: { id: { in: ids }, deleted_at: null }, select: groupMemberFields });
    if (employees.length !== ids.length) throw new AppError('VALIDATION', 'One or more selected employees no longer exist. Refresh the list and try again.', 422, 'employee_ids');
    const exited = employees.find((employee) => employee.status === 'EXITED');
    if (exited) throw new AppError('FORBIDDEN', `${exited.name} has exited. Their profile is read-only.`, 403);
    const moving = employees.filter((employee) => employee.pay_group_id !== group.id);
    // Moves start on the 1st of a month after any locked or paid payroll.
    const from = moving.length ? await effectiveFrom(tx, requestedFrom, { monthStart: true }) : null;
    for (const employee of moving) {
      await movePayGroup(tx, employee, group.id, from, actor);
      await audit(tx, {
        actor, ip, action: 'employee.pay_group_change', entity_type: 'employee', entity_id: employee.id,
        detail: { from: employee.pay_group_id, to: group.id, effective_from: from },
      });
    }
    return {
      moved: moving.length, unchanged: employees.length - moving.length, effective_from: from,
      employees: employees.map((employee) => ({ ...employee, pay_group_id: group.id })),
    };
  });
  res.json({ data: result });
});

// ─── Statutory ───────────────────────────────────────────────────────────────
export const getStatutoryRates = asyncHandler(async (_req, res) => {
  const rows = await prisma.statutoryRates.findMany({ where: { deleted_at: null }, orderBy: { valid_from: 'desc' } });
  const date = today();
  const current = rows.find((r) => fromDbDate(r.valid_from) <= date) ?? null;
  res.json({ data: { current: current ? { ...current, valid_from: fromDbDate(current.valid_from) } : null, versions: rows.map((r) => ({ ...r, valid_from: fromDbDate(r.valid_from) })) } });
});

/**
 * Rates are versioned: a change inserts a new row with its effective date. Old runs keep the
 * row they used. A date inside locked or paid payroll is refused, as is changing a row a run used.
 */
export const publishStatutoryRates = asyncHandler(async (req, res) => {
  const b = statutoryRatesCreateSchema.parse(req.body);
  const { actor, ip } = who(req);
  const row = await prisma.$transaction(async (tx) => {
    await effectiveFrom(tx, b.valid_from, { field: 'valid_from' });
    const existing = await tx.statutoryRates.findUnique({ where: { valid_from: toDbDate(b.valid_from) } });
    if (existing && !existing.deleted_at) {
      const used = await tx.payrollPeriod.count({ where: { statutory_rates_id: existing.id } });
      if (used) throw new AppError('CONFLICT', `The rates effective ${b.valid_from} were used by a payroll run. Publish new rates with a later effective date.`, 409);
    }
    const r = existing
      ? await tx.statutoryRates.update({ where: { id: existing.id }, data: { pf: b.pf, esi: b.esi, recovery_cap_pct: b.recovery_cap_pct, deleted_at: null } })
      : await tx.statutoryRates.create({ data: { valid_from: toDbDate(b.valid_from), pf: b.pf, esi: b.esi, recovery_cap_pct: b.recovery_cap_pct, created_by: actor } });
    await audit(tx, {
      actor,
      ip,
      action: 'statutory_rates.publish',
      entity_type: 'statutory_rates',
      entity_id: r.id,
      detail: { ...b, replaced: existing && !existing.deleted_at ? { pf: existing.pf, esi: existing.esi } : null },
    });
    return r;
  });
  res.json({ data: { ...row, valid_from: fromDbDate(row.valid_from) } });
});

/** Remove a mistaken rates row: never one a payroll run used, one inside frozen payroll, or the earliest. */
export const deleteStatutoryRates = asyncHandler(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    const row = await tx.statutoryRates.findFirst({ where: { id, deleted_at: null } });
    if (!row) throw notFound('Those rates');
    const date = fromDbDate(row.valid_from);
    await effectiveFrom(tx, date, { field: 'valid_from' });
    if (await tx.payrollPeriod.count({ where: { statutory_rates_id: id } })) throw new AppError('CONFLICT', `The rates effective ${date} were used by a payroll run and stay on record.`, 409);
    const earlier = await tx.statutoryRates.count({ where: { deleted_at: null, valid_from: { lt: row.valid_from } } });
    if (!earlier) throw new AppError('CONFLICT', 'These are the earliest rates on record; months before the next rates would have none. Publish corrected rates on the same date instead.', 409);
    await tx.statutoryRates.update({ where: { id }, data: { deleted_at: new Date() } });
    await audit(tx, { actor, ip, action: 'statutory_rates.delete', entity_type: 'statutory_rates', entity_id: id, detail: { valid_from: date, pf: row.pf, esi: row.esi } });
  });
  res.json({ data: { id, deleted: true } });
});

export const listPtSlabs = asyncHandler(async (_req, res) => {
  const [slabs, heads] = await Promise.all([
    prisma.ptSlab.findMany({ where: { deleted_at: null }, orderBy: [{ state: 'asc' }, { valid_from: 'desc' }, { gender_scope: 'asc' }, { upto_amount: { sort: 'asc', nulls: 'last' } }] }),
    prisma.employeeStatutory.groupBy({ by: ['pt_state'], _count: true, where: { employee: { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE'] } } } }),
  ]);
  const date = today();
  const view = (s) => ({ id: s.id, gender_scope: s.gender_scope, upto_amount: s.upto_amount === null ? null : n(s.upto_amount), amount: n(s.amount), feb_amount: s.feb_amount === null ? null : n(s.feb_amount) });
  const states = [...new Set([...slabs.map((s) => s.state), ...heads.map((h) => h.pt_state)])].sort();
  res.json({
    data: states.map((state) => {
      const rows = slabs.filter((s) => s.state === state);
      const starts = [...new Set(rows.map((s) => fromDbDate(s.valid_from)))].sort().reverse();
      const current = starts.find((d) => d <= date) ?? null;
      return {
        state,
        headcount: heads.find((h) => h.pt_state === state)?._count ?? 0,
        // The slabs in force today; `versions` lists every dated set, newest first.
        valid_from: current,
        slabs: rows.filter((s) => fromDbDate(s.valid_from) === current).map(view),
        versions: starts.map((d) => ({ valid_from: d, slabs: rows.filter((s) => fromDbDate(s.valid_from) === d).map(view) })),
      };
    }),
  });
});

/**
 * Publish a state's slabs from a date (by default the first month not locked or paid).
 * Earlier sets keep applying to earlier months; a set dated on or after the new one is replaced.
 */
export const replacePtSlabs = asyncHandler(async (req, res) => {
  const b = ptSlabsReplaceSchema.parse(req.body);
  const { actor, ip } = who(req);
  const from = await prisma.$transaction(async (tx) => {
    const requested = await effectiveFrom(tx, b.valid_from);
    const existing = await tx.ptSlab.findMany({ where: { state: b.state, deleted_at: null } });
    // With no frozen payroll the new set simply replaces every earlier one, as before.
    const start = requested ?? '2000-01-01';
    const replaced = requested ? existing.filter((o) => fromDbDate(o.valid_from) >= start) : existing;
    if (replaced.length) await tx.ptSlab.updateMany({ where: { id: { in: replaced.map((o) => o.id) } }, data: { deleted_at: new Date() } });
    await tx.ptSlab.createMany({
      data: b.slabs.map((s) => ({
        state: b.state,
        gender_scope: s.gender_scope,
        upto_amount: s.upto_amount === null ? null : BigInt(s.upto_amount),
        amount: BigInt(s.amount),
        feb_amount: s.feb_amount === null ? null : BigInt(s.feb_amount),
        valid_from: toDbDate(start),
      })),
    });
    await audit(tx, {
      actor,
      ip,
      action: 'pt_slabs.replace',
      entity_type: 'pt_slab',
      entity_id: null,
      detail: { state: b.state, valid_from: start, old: replaced.map((o) => ({ valid_from: fromDbDate(o.valid_from), upto: n(o.upto_amount), amount: n(o.amount) })), new: b.slabs },
    });
    return start;
  });
  res.json({ data: { ok: true, valid_from: from } });
});

/**
 * Publish a regime's rates for a tax year (valid from 1 April). Refused once that year's
 * payroll is locked or paid. Re-publishing the same year corrects it in place.
 */
export const publishTaxRegime = asyncHandler(async (req, res) => {
  const b = taxRegimePublishSchema.parse(req.body);
  const { actor, ip } = who(req);
  const fy = Number(b.valid_from.slice(0, 4));
  const row = await prisma.$transaction(async (tx) => {
    const frozen = await tx.payrollPeriod.count({ where: { deleted_at: null, state: { in: ['LOCKED', 'PAID'] }, period_ym: { gte: `${fy}-04`, lte: `${fy + 1}-03` } } });
    if (frozen) throw new AppError('PAYROLL_FROZEN', `Payroll in tax year ${fy}-${String(fy + 1).slice(2)} is already locked or paid. Its tax rates cannot change; unlock those months first.`, 409, 'valid_from');
    const data = {
      name: b.name,
      std_deduction: BigInt(b.std_deduction),
      rebate_limit: BigInt(b.rebate_limit),
      rebate_max: b.rebate_max === null ? null : BigInt(b.rebate_max),
      marginal_relief: b.marginal_relief,
      allows_80c: b.allows_80c,
      allows_hra: b.allows_hra,
      cess_pct: b.cess_pct,
      deleted_at: null,
    };
    const existing = await tx.taxRegime.findUnique({ where: { code_valid_from: { code: b.code, valid_from: toDbDate(b.valid_from) } }, include: { slabs: { where: { deleted_at: null } } } });
    const r = existing
      ? await tx.taxRegime.update({ where: { id: existing.id }, data })
      : await tx.taxRegime.create({ data: { ...data, code: b.code, valid_from: toDbDate(b.valid_from) } });
    if (existing) await tx.taxSlab.updateMany({ where: { regime_id: r.id, deleted_at: null }, data: { deleted_at: new Date() } });
    await tx.taxSlab.createMany({ data: b.slabs.map((x) => ({ regime_id: r.id, upto_amount: x.upto_amount === null ? null : BigInt(x.upto_amount), rate: x.rate })) });
    await audit(tx, {
      actor, ip, action: 'tax_regime.publish', entity_type: 'tax_regime', entity_id: r.id,
      detail: { ...b, replaced: existing ? { std_deduction: n(existing.std_deduction), rebate_limit: n(existing.rebate_limit), slabs: existing.slabs.map((x) => ({ upto_amount: x.upto_amount === null ? null : n(x.upto_amount), rate: Number(x.rate) })) } : null },
    });
    return r;
  });
  res.status(201).json({ data: { id: row.id, code: row.code, valid_from: fromDbDate(row.valid_from) } });
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
  res.json({ data: await listDepartmentSettings(prisma) });
});

export const createDepartment = asyncHandler(async (req, res) => {
  const d = await addDepartment(prisma, req.body, who(req));
  res.status(201).json({ data: d });
});

export const updateDepartment = asyncHandler(async (req, res) => {
  const d = await changeDepartment(prisma, uuid.parse(req.params.id), req.body, who(req));
  res.json({ data: d });
});

export const deleteDepartment = asyncHandler(async (req, res) => {
  res.json({ data: await removeDepartment(prisma, uuid.parse(req.params.id), who(req)) });
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
