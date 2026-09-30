import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  documentCreateSchema,
  employeeCoreSchema,
  employeeIdentitySchema,
  employeeUpdateSchema,
  faceEnrolSchema,
  formatYearMonth,
  isoDate,
  istDate,
  LETTER_KINDS,
  ONBOARDING_TASKS,
  resignSchema,
  salaryRevisionSchema,
  SALARY_MODES,
  statutoryUpdateSchema,
  TAX_REGIMES,
  yearMonth,
  ymOf,
} from '@ajpwer/shared';
import { compareRegimes, ctcForGross, expandStructure, calendarDivisor, usesCtc, workingDaysInMonth } from '../calculations/index.js';
import { audit, auditReq, diff, who } from '../utils/audit.js';
import { documentsDir } from '../middleware/upload.js';
import { encryptPII, maskAadhaar } from '../utils/crypto.js';
import { fromDbDate, n, toDbDate } from '../utils/dbDates.js';
import { AppError, notFound } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { filterOne, filterValues, keysetOrder, keysetWhere, page, parseList, toCSV } from '../utils/list.js';
import { prisma } from '../config/db.js';
import { computeMonth1, computeMonths } from '../services/attendance.service.js';
import { employeeView, loadEmployee, markTask, nextEmployeeCode, rulesThatApply } from '../services/employee.service.js';
import { leaveBalances } from '../services/leave.service.js';
import { computePayslip, loadRecoveries } from '../services/payslip.service.js';
import { payContext } from '../services/payroll.service.js';
import { ratesOn, regimesOn, salaryOn, structureComponents, holidaysBetween } from '../services/rules.service.js';
import { ctcBasisOf, insertSalary, previewSalary, resolveMonthlyGross } from '../services/salary.service.js';
import { upsertSettlement } from '../services/settlement.service.js';

const today = () => istDate(new Date());

// ─── List ────────────────────────────────────────────────────────────────────

const SORTS = [
  { key: 'name', field: 'name', type: 'string' },
  { key: 'code', field: 'code', type: 'string' },
  { key: 'joined', field: 'joined_on', type: 'date' },
  { key: 'status', field: 'status', type: 'string' },
  { key: 'designation', field: 'designation', type: 'string' },
];

export function employeeWhere(q, f) {
  const and = [{ deleted_at: null }];
  if (q) {
    and.push({
      OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }, { designation: { contains: q, mode: 'insensitive' } }, { phone: { contains: q } }],
    });
  }
  const dept = filterValues(f, 'dept');
  if (dept.length) and.push({ department_id: { in: dept } });
  const pg = filterValues(f, 'pay_group');
  if (pg.length) and.push({ pay_group_id: { in: pg } });
  const status = filterValues(f, 'status');
  if (status.length) and.push({ status: { in: status } });
  const pt = filterValues(f, 'pt_state');
  if (pt.length) and.push({ statutory: { pt_state: { in: pt } } });
  const regime = filterOne(f, 'regime');
  if (regime) and.push({ statutory: { tax_regime_code: regime } });
  const bank = filterOne(f, 'bank');
  if (bank === 'has') and.push({ identity: { bank_account_enc: { not: null } } });
  if (bank === 'none') and.push({ OR: [{ identity: null }, { identity: { bank_account_enc: null } }] });
  const pf = filterOne(f, 'pf');
  if (pf === 'on') and.push({ statutory: { pf_enabled: true } });
  if (pf === 'off') and.push({ statutory: { pf_enabled: false } });
  const uan = filterOne(f, 'uan');
  if (uan === 'none') and.push({ OR: [{ identity: null }, { identity: { uan: null } }] });
  const from = filterOne(f, 'joined_from');
  if (from) and.push({ joined_on: { gte: toDbDate(from) } });
  const to = filterOne(f, 'joined_to');
  if (to) and.push({ joined_on: { lte: toDbDate(to) } });
  return { AND: and };
}

const listInclude = {
  department: { select: { id: true, name: true, colour: true } },
  pay_group: { select: { id: true, name: true } },
  statutory: { select: { pt_state: true, tax_regime_code: true, pf_enabled: true } },
  identity: { select: { bank_account_enc: true, uan: true } },
};

function listRow(e) {
  return {
    id: e.id,
    code: e.code,
    name: e.name,
    phone: e.phone,
    gender: e.gender,
    designation: e.designation,
    department: e.department,
    pay_group: e.pay_group,
    status: e.status,
    joined_on: fromDbDate(e.joined_on),
    last_day: fromDbDate(e.last_day),
    pt_state: e.statutory?.pt_state ?? null,
    tax_regime: e.statutory?.tax_regime_code ?? null,
    pf_enabled: e.statutory?.pf_enabled ?? null,
    has_bank: !!e.identity?.bank_account_enc,
    has_uan: !!e.identity?.uan,
  };
}

export const listEmployees = asyncHandler(async (req, res) => {
  const p = parseList(req, SORTS, 'name');
  const where = employeeWhere(p.q, p.filter);
  const [rows, total] = await Promise.all([
    prisma.employee.findMany({
      where: { AND: [where, keysetWhere(p) ?? {}] },
      orderBy: keysetOrder(p),
      take: p.limit + 1,
      include: listInclude,
    }),
    prisma.employee.count({ where }),
  ]);
  res.json(page(rows, p, total, listRow));
});

export const exportEmployees = asyncHandler(async (req, res) => {
  const p = parseList(req, SORTS, 'name');
  const where = employeeWhere(p.q, p.filter);
  const rows = await prisma.employee.findMany({ where, orderBy: keysetOrder(p), include: listInclude, take: 50_000 });
  const data = rows.map(listRow).map((r) => ({ ...r, department: r.department.name, pay_group: r.pay_group.name, has_bank: r.has_bank ? 'yes' : 'no', has_uan: r.has_uan ? 'yes' : 'no' }));
  const csv = toCSV(data, [
    { key: 'code', label: 'Employee code' },
    { key: 'name', label: 'Name' },
    { key: 'designation', label: 'Designation' },
    { key: 'department', label: 'Department' },
    { key: 'pay_group', label: 'Pay group' },
    { key: 'status', label: 'Status' },
    { key: 'joined_on', label: 'Joined' },
    { key: 'phone', label: 'Phone' },
    { key: 'pt_state', label: 'PT state' },
    { key: 'tax_regime', label: 'Tax regime' },
    { key: 'has_bank', label: 'Bank on file' },
    { key: 'has_uan', label: 'UAN on file' },
  ]);
  await auditReq(req, { action: 'export.people', entity_type: 'employee', detail: { rows: data.length, filter: p.filter, q: p.q } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="people-${today()}.csv"`);
  res.send(csv);
});

// ─── Create (direct, for existing staff; new hires go through offers) ────────

const createSchema = employeeCoreSchema
  .extend({
    joined_on: isoDate,
    status: z.enum(['ONBOARDING', 'ACTIVE']).default('ONBOARDING'),
    salary: z.object({ mode: z.enum(SALARY_MODES), amount: z.number().int().min(1), chosen_gross: z.number().int().optional() }).strict(),
    pt_state: z.string().min(1),
    tax_regime_code: z.enum(TAX_REGIMES).default('NEW'),
    identity: employeeIdentitySchema.optional(),
  })
  .strict();

function identityData(i) {
  const out = {};
  if (i.pan !== undefined) out.pan_enc = encryptPII(i.pan);
  if (i.aadhaar !== undefined) {
    out.aadhaar_enc = encryptPII(i.aadhaar);
    out.aadhaar_masked = maskAadhaar(i.aadhaar);
  }
  if (i.uan !== undefined) out.uan = i.uan;
  if (i.esi_number !== undefined) out.esi_number = i.esi_number;
  if (i.bank_account !== undefined) {
    out.bank_account_enc = encryptPII(i.bank_account);
    out.bank_last4 = i.bank_account ? i.bank_account.slice(-4) : null;
  }
  if (i.bank_ifsc !== undefined) out.bank_ifsc = i.bank_ifsc;
  if (i.bank_name !== undefined) out.bank_name = i.bank_name;
  return out;
}

export const createEmployee = asyncHandler(async (req, res) => {
  const b = createSchema.parse(req.body);
  const group = await prisma.payGroup.findFirst({ where: { id: b.pay_group_id, deleted_at: null } });
  if (!group) throw notFound('Pay group');
  const { monthly_gross } = await resolveMonthlyGross(prisma, {
    mode: b.salary.mode,
    amount: b.salary.amount,
    structure_id: group.structure_id,
    date: b.joined_on,
    gender: b.gender,
    pt_state: b.pt_state,
    chosen_gross: b.salary.chosen_gross,
  });
  const { actor, ip } = who(req);
  const created = await prisma.$transaction(async (tx) => {
    const code = await nextEmployeeCode(tx);
    const e = await tx.employee.create({
      data: {
        code,
        name: b.name,
        dob: b.dob ? toDbDate(b.dob) : null,
        gender: b.gender,
        phone: b.phone,
        email: b.email ?? null,
        address: b.address ?? null,
        blood_group: b.blood_group ?? null,
        department_id: b.department_id,
        designation: b.designation,
        pay_group_id: b.pay_group_id,
        notice_days: b.notice_days,
        joined_on: toDbDate(b.joined_on),
        status: b.status,
        activated_at: b.status === 'ACTIVE' ? new Date() : null,
        statutory: { create: { pt_state: b.pt_state, tax_regime_code: b.tax_regime_code, esi_enabled: monthly_gross <= 2_100_000 } },
        identity: { create: identityData(b.identity ?? {}) },
        salaries: {
          create: {
            valid_from: toDbDate(b.joined_on),
            mode: b.salary.mode,
            amount: BigInt(b.salary.amount),
            monthly_gross: BigInt(monthly_gross),
            structure_id: group.structure_id,
            reason: 'Initial salary',
            created_by: actor,
          },
        },
      },
    });
    await markTask(tx, e.id, 'PAY', actor);
    await audit(tx, { actor, ip, action: 'employee.create', entity_type: 'employee', entity_id: e.id, detail: { code, name: b.name, status: b.status } });
    return e;
  });
  res.status(201).json({ data: { id: created.id, code: created.code } });
});

// ─── Bulk actions ────────────────────────────────────────────────────────────

const bulkSchema = z
  .object({
    ids: z.array(z.string().uuid()).optional(),
    /** "Select all N matching": the list's current query string */
    match: z.object({ q: z.string().nullable().optional(), filter: z.record(z.union([z.string(), z.array(z.string())])).optional() }).optional(),
    action: z.enum(['pay_group', 'pt_state', 'tax_regime']),
    value: z.string().min(1),
    confirm: z.boolean().default(false),
  })
  .strict()
  .refine((v) => v.ids?.length || v.match, { message: 'Select at least one person' });

export const bulkAction = asyncHandler(async (req, res) => {
  const b = bulkSchema.parse(req.body);
  const where = b.ids?.length ? { id: { in: b.ids }, deleted_at: null } : employeeWhere(b.match?.q ?? null, b.match?.filter ?? {});
  const people = await prisma.employee.findMany({ where, include: { statutory: true, pay_group: true }, take: 5000 });
  const ym = ymOf(today());
  let changes = [];
  if (b.action === 'pay_group') {
    const target = await prisma.payGroup.findFirst({ where: { id: b.value, deleted_at: null } });
    if (!target) throw notFound('Pay group');
    const hol = [...(await holidaysBetween(prisma, `${ym}-01`, `${ym}-31`)).keys()];
    const divisorOf = (g) => calendarDivisor(g.calendar_method, ym, workingDaysInMonth(ym, g.weekly_off, hol));
    changes = await Promise.all(
      people
        .filter((p) => p.pay_group_id !== target.id)
        .map(async (p) => {
          const sal = await salaryOn(prisma, p.id, today());
          const g = sal?.monthly_gross ?? 0;
          const before = Math.round(g / divisorOf(p.pay_group));
          const after = Math.round(g / divisorOf(target));
          return { id: p.id, code: p.code, name: p.name, from: p.pay_group.name, to: target.name, note: `Day rate ₹${Math.round(before / 100)} → ₹${Math.round(after / 100)}` };
        }),
    );
  } else if (b.action === 'pt_state') {
    changes = people.filter((p) => p.statutory?.pt_state !== b.value).map((p) => ({ id: p.id, code: p.code, name: p.name, from: p.statutory?.pt_state ?? '—', to: b.value }));
  } else {
    if (!['NEW', 'OLD'].includes(b.value)) throw new AppError('VALIDATION', 'Regime is NEW or OLD.', 422, 'value');
    changes = people.filter((p) => p.statutory?.tax_regime_code !== b.value).map((p) => ({ id: p.id, code: p.code, name: p.name, from: p.statutory?.tax_regime_code ?? '—', to: b.value }));
  }
  if (!b.confirm) return res.json({ data: { preview: true, count: changes.length, selected: people.length, changes: changes.slice(0, 200) } });

  const { actor, ip } = who(req);
  await prisma.$transaction(
    async (tx) => {
      for (const c of changes) {
        if (b.action === 'pay_group') await tx.employee.update({ where: { id: c.id }, data: { pay_group_id: b.value } });
        if (b.action === 'pt_state') await tx.employeeStatutory.update({ where: { employee_id: c.id }, data: { pt_state: b.value } });
        if (b.action === 'tax_regime') await tx.employeeStatutory.update({ where: { employee_id: c.id }, data: { tax_regime_code: b.value } });
        // One audit entry per person, not one for the batch.
        await audit(tx, { actor, ip, action: `employee.bulk.${b.action}`, entity_type: 'employee', entity_id: c.id, detail: { from: c.from, to: c.to } });
      }
    },
    { timeout: 120_000 },
  );
  res.json({ data: { applied: changes.length } });
});

// ─── Salary preview (offer form, revision dialog, pay tab) ────────────────────

const previewSchema = z
  .object({
    mode: z.enum(SALARY_MODES),
    amount: z.number().int().min(1),
    structure_id: z.string().uuid().optional(),
    pay_group_id: z.string().uuid().optional(),
    employee_id: z.string().uuid().optional(),
    date: isoDate.optional(),
    gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
    pt_state: z.string().optional(),
    chosen_gross: z.number().int().optional(),
  })
  .strict();

export const getSalaryPreview = asyncHandler(async (req, res) => {
  const b = previewSchema.parse(req.body);
  const e = b.employee_id ? await loadEmployee(prisma, b.employee_id) : null;
  let structureId = b.structure_id;
  if (!structureId && b.pay_group_id) structureId = (await prisma.payGroup.findUniqueOrThrow({ where: { id: b.pay_group_id } })).structure_id;
  if (!structureId && e) structureId = e.pay_group.structure_id;
  if (!structureId) throw new AppError('VALIDATION', 'Pick a pay group or salary structure.', 422, 'structure_id');
  const st = e?.statutory;
  const preview = await previewSalary(prisma, {
    mode: b.mode,
    amount: b.amount,
    structure_id: structureId,
    date: b.date ?? today(),
    gender: b.gender ?? e?.gender ?? 'MALE',
    pt_state: b.pt_state ?? st?.pt_state ?? 'Andhra Pradesh',
    pt_applicable: st?.pt_applicable,
    pf_enabled: st?.pf_enabled,
    pf_restrict_to_ceiling: st?.pf_restrict_to_ceiling,
    vpf_pct: st ? Number(st.vpf_pct) : 0,
    esi_enabled: st?.esi_enabled,
    tax_regime_code: st?.tax_regime_code,
    declarations: st ? { decl_80c: n(st.decl_80c), decl_80d: n(st.decl_80d), decl_rent_monthly: n(st.decl_rent_monthly), decl_metro: st.decl_metro } : undefined,
    chosen_gross: b.chosen_gross,
  });
  res.json({ data: preview });
});

// ─── One person ──────────────────────────────────────────────────────────────

async function mustLoad(id) {
  const e = await loadEmployee(prisma, id);
  if (!e) throw notFound('That person');
  return e;
}

function assertWritable(e) {
  if (e.status === 'EXITED') throw new AppError('FORBIDDEN', `${e.name} has exited. Their profile is read-only.`, 403);
}

export const getEmployee = asyncHandler(async (req, res) => {
  const e = await mustLoad(req.params.id);
  // Every read of the PII table is logged, not just writes.
  await auditReq(req, { action: 'pii.read', entity_type: 'employee_identity', entity_id: e.id, detail: { employee_id: e.id, masked: true } });
  const view = await employeeView(prisma, e, today(), false);
  const rules = await rulesThatApply(prisma, e.pay_group_id, today());
  res.json({ data: { ...view, rules } });
});

/** Unmasked identity — separate permission, separately logged. */
export const getIdentity = asyncHandler(async (req, res) => {
  const e = await mustLoad(req.params.id);
  await auditReq(req, { action: 'pii.read', entity_type: 'employee_identity', entity_id: e.id, detail: { employee_id: e.id, masked: false } });
  const view = await employeeView(prisma, e, today(), true);
  res.json({ data: view.identity });
});

export const updateEmployee = asyncHandler(async (req, res) => {
  const b = employeeUpdateSchema.parse(req.body);
  const e = await mustLoad(req.params.id);
  assertWritable(e);
  const seen = e.updated_at?.toISOString() ?? e.created_at.toISOString();
  // Optimistic concurrency: two HR users editing one person must not silently overwrite each other.
  if (b.updated_at !== seen) {
    throw new AppError('STALE_UPDATE', 'Someone else changed this person since you opened the form. Reload to see their changes, then edit again.', 409);
  }
  const { identity, updated_at: _u, ...core } = b;
  const data = { ...core };
  if (core.dob !== undefined) data.dob = core.dob ? toDbDate(core.dob) : null;
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    // Guard the concurrency check inside the transaction too.
    const n1 = await tx.employee.updateMany({ where: { id: e.id, updated_at: e.updated_at ?? undefined }, data: data });
    if (n1.count === 0) throw new AppError('STALE_UPDATE', 'Someone else changed this person since you opened the form. Reload and try again.', 409);
    const changes = diff(e, core);
    if (Object.keys(changes).length) await audit(tx, { actor, ip, action: 'employee.update', entity_type: 'employee', entity_id: e.id, detail: { changes } });
    if (core.pay_group_id && core.pay_group_id !== e.pay_group_id) {
      await audit(tx, { actor, ip, action: 'employee.pay_group_change', entity_type: 'employee', entity_id: e.id, detail: { from: e.pay_group_id, to: core.pay_group_id } });
    }
    if (identity) {
      const idData = identityData(identity);
      await tx.employeeIdentity.upsert({ where: { employee_id: e.id }, update: idData, create: { employee_id: e.id, ...idData } });
      await audit(tx, { actor, ip, action: 'pii.write', entity_type: 'employee_identity', entity_id: e.id, detail: { employee_id: e.id, fields: Object.keys(identity) } });
      const merged = { ...(e.identity ?? {}), ...idData };
      if (merged.pan_enc && merged.aadhaar_enc) await markTask(tx, e.id, 'IDENTITY', actor);
      if (merged.bank_account_enc && merged.bank_ifsc) await markTask(tx, e.id, 'BANK', actor);
    }
    const after = await tx.employee.findUniqueOrThrow({ where: { id: e.id } });
    if (after.dob && after.address && after.phone) await markTask(tx, e.id, 'PERSONAL', actor);
  });
  const fresh = await mustLoad(e.id);
  res.json({ data: await employeeView(prisma, fresh, today(), false) });
});

// ─── Salary ──────────────────────────────────────────────────────────────────
export const getSalaryHistory = asyncHandler(async (req, res) => {
  const rows = await prisma.employeeSalary.findMany({
    where: { employee_id: req.params.id, deleted_at: null },
    include: { structure: { select: { id: true, name: true } } },
    orderBy: { valid_from: 'desc' },
  });
  res.json({
    data: rows.map((r) => ({
      id: r.id,
      valid_from: fromDbDate(r.valid_from),
      valid_to: fromDbDate(r.valid_to),
      mode: r.mode,
      amount: n(r.amount),
      monthly_gross: n(r.monthly_gross),
      structure: r.structure,
      reason: r.reason,
      created_by: r.created_by,
      created_at: r.created_at,
    })),
  });
});

export const reviseSalary = asyncHandler(async (req, res) => {
  const b = salaryRevisionSchema.parse(req.body);
  const e = await mustLoad(req.params.id);
  assertWritable(e);
  if (b.valid_from < fromDbDate(e.joined_on)) throw new AppError('VALIDATION', 'A revision cannot take effect before the joining date.', 422, 'valid_from');
  const structureId = b.structure_id ?? e.pay_group.structure_id;
  const st = e.statutory;
  const { monthly_gross } = await resolveMonthlyGross(prisma, {
    mode: b.mode,
    amount: b.amount,
    structure_id: structureId,
    date: b.valid_from,
    gender: e.gender,
    pt_state: st.pt_state,
    pf_enabled: st.pf_enabled,
    pf_restrict_to_ceiling: st.pf_restrict_to_ceiling,
    vpf_pct: Number(st.vpf_pct),
    esi_enabled: st.esi_enabled,
    chosen_gross: b.chosen_gross,
  });
  const { actor, ip } = who(req);
  const result = await prisma.$transaction(async (tx) => {
    const r = await insertSalary(tx, e.id, b.valid_from, { mode: b.mode, amount: b.amount, monthly_gross, structure_id: structureId, reason: b.reason }, actor);
    await audit(tx, {
      actor,
      ip,
      action: 'salary.revise',
      entity_type: 'employee',
      entity_id: e.id,
      detail: {
        old: r.current ? { mode: r.current.mode, amount: n(r.current.amount), monthly_gross: n(r.current.monthly_gross), valid_from: fromDbDate(r.current.valid_from) } : null,
        new: { mode: b.mode, amount: b.amount, monthly_gross, valid_from: b.valid_from, structure_id: structureId },
        reason: b.reason,
      },
    });
    return r.created;
  });
  res.status(201).json({ data: { id: result.id, monthly_gross } });
});

/** Switch between gross and CTC agreement. Pay stays identical; the record is restated. */
export const restateSalary = asyncHandler(async (req, res) => {
  const { mode } = z
    .object({ mode: z.enum(SALARY_MODES) })
    .strict()
    .parse(req.body);
  const e = await mustLoad(req.params.id);
  assertWritable(e);
  const cur = await salaryOn(prisma, e.id, today());
  if (!cur) throw new AppError('VALIDATION', 'No current salary to restate.', 409);
  if (cur.mode === mode) return res.json({ data: { unchanged: true } });
  const st = e.statutory;
  const rates = await ratesOn(prisma, today());
  const components = await structureComponents(prisma, cur.structure_id);
  // Restating to CTC keeps "% of CTC" components exactly where they were: the agreed CTC is the figure they already ran on.
  const worked = ctcForGross(cur.monthly_gross, {
    components,
    pf: { pf_enabled: st.pf_enabled, pf_restrict_to_ceiling: st.pf_restrict_to_ceiling, vpf_pct: Number(st.vpf_pct) },
    esi_enabled: st.esi_enabled,
    rates: { pf: rates.pf, esi: rates.esi },
  });
  const amount = mode === 'GROSS' ? cur.monthly_gross : usesCtc(components) ? worked.ctc_basis : worked.annual_ctc;
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    await insertSalary(
      tx,
      e.id,
      today(),
      { mode, amount, monthly_gross: cur.monthly_gross, structure_id: cur.structure_id, reason: `Restated as ${mode === 'CTC' ? 'annual CTC' : 'monthly gross'}; pay unchanged` },
      actor,
    );
    await audit(tx, {
      actor,
      ip,
      action: 'salary.restate',
      entity_type: 'employee',
      entity_id: e.id,
      detail: { from: { mode: cur.mode, amount: cur.amount }, to: { mode, amount }, monthly_gross: cur.monthly_gross },
    });
  });
  res.json({ data: { mode, amount, monthly_gross: cur.monthly_gross } });
});

// ─── Statutory ───────────────────────────────────────────────────────────────
export const updateStatutory = asyncHandler(async (req, res) => {
  const b = statutoryUpdateSchema.parse(req.body);
  const e = await mustLoad(req.params.id);
  assertWritable(e);
  const before = e.statutory;
  const data = { ...b };
  if (b.decl_80c !== undefined) data.decl_80c = BigInt(b.decl_80c);
  if (b.decl_80d !== undefined) data.decl_80d = BigInt(b.decl_80d);
  if (b.decl_rent_monthly !== undefined) data.decl_rent_monthly = BigInt(b.decl_rent_monthly);
  if (b.pt_applicable === true) data.pt_exempt_reason = null;
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    await tx.employeeStatutory.update({ where: { employee_id: e.id }, data });
    const changes = diff({ ...before, vpf_pct: Number(before.vpf_pct) }, b);
    await audit(tx, { actor, ip, action: 'statutory.update', entity_type: 'employee', entity_id: e.id, detail: { changes } });
    await markTask(tx, e.id, 'STATUTORY', actor);
  });
  res.json({ data: { ok: true } });
});

/** Everything the pay and statutory tab shows, at full pay. */
export const getPay = asyncHandler(async (req, res) => {
  const e = await mustLoad(req.params.id);
  const date = today() > fromDbDate(e.joined_on) ? today() : fromDbDate(e.joined_on);
  const cur = await salaryOn(prisma, e.id, date);
  if (!cur) return res.json({ data: null });
  const st = e.statutory;
  const preview = await previewSalary(prisma, {
    mode: cur.mode,
    amount: cur.amount,
    structure_id: cur.structure_id,
    date,
    gender: e.gender,
    pt_state: st.pt_state,
    pt_applicable: st.pt_applicable,
    pf_enabled: st.pf_enabled,
    pf_restrict_to_ceiling: st.pf_restrict_to_ceiling,
    vpf_pct: Number(st.vpf_pct),
    esi_enabled: st.esi_enabled,
    tax_regime_code: st.tax_regime_code,
    declarations: { decl_80c: n(st.decl_80c), decl_80d: n(st.decl_80d), decl_rent_monthly: n(st.decl_rent_monthly), decl_metro: st.decl_metro },
    chosen_gross: cur.monthly_gross,
  });
  const rates = await ratesOn(prisma, date);
  res.json({ data: { salary: cur, preview, rates: { pf: rates.pf, esi: rates.esi } } });
});

export const getTax = asyncHandler(async (req, res) => {
  const e = await mustLoad(req.params.id);
  const date = today() > fromDbDate(e.joined_on) ? today() : fromDbDate(e.joined_on);
  const cur = await salaryOn(prisma, e.id, date);
  if (!cur) return res.json({ data: null });
  const components = await structureComponents(prisma, cur.structure_id);
  const st = e.statutory;
  const s = expandStructure(components, cur.monthly_gross, ctcBasisOf(cur, components, st, await ratesOn(prisma, date)));
  const taxable = s.monthly.filter((c) => c.is_taxable).reduce((a, c) => a + c.amount, 0) * 12 + s.yearly.filter((c) => c.is_taxable).reduce((a, c) => a + c.amount, 0);
  const regimes = await regimesOn(prisma, date);
  const cmp = compareRegimes(
    { gross: taxable, basic: s.basic * 12, hra: s.hra * 12 },
    { decl_80c: n(st.decl_80c), decl_80d: n(st.decl_80d), decl_rent_monthly: n(st.decl_rent_monthly), decl_metro: st.decl_metro },
    regimes,
  );
  res.json({ data: { current: st.tax_regime_code, comparison: cmp, regimes } });
});

// ─── Attendance, payslips, leave, timeline ───────────────────────────────────
export const getAttendance = asyncHandler(async (req, res) => {
  const month = yearMonth.parse(req.query.month ?? ymOf(today()));
  const e = await mustLoad(req.params.id);
  const m = await computeMonth1(prisma, e, month);
  const sites = await prisma.site.findMany({ select: { id: true, name: true, code: true } });
  res.json({ data: { month, totals: m.result.totals, days: m.result.days, offday_work: m.result.offday_work, sites } });
});

export const getPayslipPreview = asyncHandler(async (req, res) => {
  const month = yearMonth.parse(req.query.month ?? ymOf(today()));
  const e = await mustLoad(req.params.id);
  const ctx = await payContext(prisma, month);
  const months = await computeMonths(prisma, [e], month);
  const rec = await loadRecoveries(prisma, [e.id], month);
  const p = await computePayslip(prisma, e, month, months.get(e.id), ctx, rec.get(e.id) ?? null);
  res.json({ data: { month, live: true, ...p } });
});

export const listPayslips = asyncHandler(async (req, res) => {
  const rows = await prisma.payslip.findMany({
    where: { employee_id: req.params.id },
    include: { period: { select: { period_ym: true, state: true } } },
    orderBy: { period: { period_ym: 'desc' } },
  });
  res.json({
    data: rows.map((r) => ({
      id: r.id,
      period_ym: r.period.period_ym,
      state: r.period.state,
      gross: n(r.gross),
      net: n(r.net),
      total_deductions: n(r.total_deductions),
      paid_days: Number(r.paid_days),
      lop_days: Number(r.lop_days),
    })),
  });
});

export const getLeaveBalances = asyncHandler(async (req, res) => {
  const e = await mustLoad(req.params.id);
  res.json({ data: await leaveBalances(prisma, e, today()) });
});

export const getTimeline = asyncHandler(async (req, res) => {
  const id = req.params.id;
  const rows = await prisma.auditLog.findMany({
    where: { OR: [{ entity_id: id }, { detail: { path: ['employee_id'], equals: id } }] },
    orderBy: { at: 'desc' },
    take: 200,
  });
  res.json({ data: rows });
});

// ─── Onboarding ──────────────────────────────────────────────────────────────
export const updateOnboardingTask = asyncHandler(async (req, res) => {
  const { done } = z
    .object({ done: z.boolean().default(true) })
    .strict()
    .parse(req.body ?? {});
  const e = await mustLoad(req.params.id);
  assertWritable(e);
  const task = ONBOARDING_TASKS.find((t) => t.code === req.params.task);
  if (!task) throw notFound('That checklist step');
  const { actor, ip } = who(req);
  if (done) {
    // A step that needs data opens the thing it is about rather than being ticked blind.
    const idn = e.identity;
    const missing =
      (task.code === 'PERSONAL' && (!e.dob || !e.address) && 'Date of birth and address are needed.') ||
      (task.code === 'IDENTITY' && (!idn?.pan_enc || !idn?.aadhaar_enc) && 'PAN and Aadhaar are needed.') ||
      (task.code === 'BANK' && (!idn?.bank_account_enc || !idn?.bank_ifsc) && 'A bank account and IFSC are needed.') ||
      (task.code === 'FACE' && e.faces.length === 0 && 'Enrol the face first.') ||
      (task.code === 'JOINING_LETTER' && !(await prisma.letter.findFirst({ where: { employee_id: e.id, kind: 'JOINING', issued_on: { not: null } } })) && 'Issue the joining letter first.');
    if (missing) throw new AppError('VALIDATION', missing, 409, task.code, { opens: task.opens });
    await markTask(prisma, e.id, task.code, actor);
  } else {
    await prisma.onboardingTask.updateMany({ where: { employee_id: e.id, task_code: task.code }, data: { done_at: null, done_by: null } });
  }
  await audit(prisma, { actor, ip, action: done ? 'onboarding.done' : 'onboarding.undone', entity_type: 'employee', entity_id: e.id, detail: { task: task.code } });
  const fresh = await mustLoad(e.id);
  res.json({ data: (await employeeView(prisma, fresh, today(), false)).onboarding });
});

export const activate = asyncHandler(async (req, res) => {
  const e = await mustLoad(req.params.id);
  if (e.status !== 'ONBOARDING') throw new AppError('INVALID_TRANSITION', `Only someone in onboarding can be activated; ${e.name} is ${e.status}.`, 409);
  const view = await employeeView(prisma, e, today(), false);
  if (view.onboarding.required_left > 0) {
    throw new AppError('BLOCKING_ISSUES', `${view.onboarding.required_left} required onboarding step${view.onboarding.required_left > 1 ? 's' : ''} remain.`, 409);
  }
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    await tx.employee.update({ where: { id: e.id }, data: { status: 'ACTIVE', activated_at: new Date() } });
    await audit(tx, { actor, ip, action: 'employee.activate', entity_type: 'employee', entity_id: e.id, detail: { from: 'ONBOARDING', to: 'ACTIVE' } });
  });
  res.json({ data: { status: 'ACTIVE' } });
});

// ─── Exit ────────────────────────────────────────────────────────────────────
export const resign = asyncHandler(async (req, res) => {
  const b = resignSchema.parse(req.body);
  const e = await mustLoad(req.params.id);
  if (e.status !== 'ACTIVE' && e.status !== 'NOTICE') throw new AppError('INVALID_TRANSITION', `Only an active employee can be put on notice; ${e.name} is ${e.status}.`, 409);
  if (b.last_day < b.resigned_on) throw new AppError('VALIDATION', 'The last day cannot be before the resignation date.', 422, 'last_day');
  const served = b.notice_served_days ?? Math.min(e.notice_days, Math.max(0, Math.round((Date.parse(b.last_day) - Date.parse(b.resigned_on)) / 86_400_000) + 1));
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    await tx.employee.update({
      where: { id: e.id },
      data: { status: 'NOTICE', resigned_on: toDbDate(b.resigned_on), last_day: toDbDate(b.last_day), notice_served_days: served, exit_reason: b.exit_reason },
    });
    await audit(tx, { actor, ip, action: 'employee.resign', entity_type: 'employee', entity_id: e.id, detail: { ...b, notice_served_days: served } });
  });
  const s = await upsertSettlement(prisma, e.id);
  res.json({ data: { status: 'NOTICE', settlement_id: s.id } });
});

// ─── Face enrolment ──────────────────────────────────────────────────────────
export const enrolFace = asyncHandler(async (req, res) => {
  const b = faceEnrolSchema.parse(req.body);
  const e = await mustLoad(req.params.id);
  assertWritable(e);
  const emb = Buffer.from(new Float32Array(b.embedding).buffer);
  const { actor, ip } = who(req);
  await prisma.$transaction(async (tx) => {
    await tx.employeeFace.updateMany({ where: { employee_id: e.id, deleted_at: null }, data: { deleted_at: new Date() } });
    await tx.employeeFace.create({ data: { employee_id: e.id, embedding: emb, model_version: b.model_version, consent_at: new Date() } });
    await markTask(tx, e.id, 'FACE', actor);
    await audit(tx, { actor, ip, action: 'face.enrol', entity_type: 'employee', entity_id: e.id, detail: { model_version: b.model_version, consent: true } });
  });
  res.status(201).json({ data: { enrolled: true } });
});

export const removeFace = asyncHandler(async (req, res) => {
  const e = await mustLoad(req.params.id);
  await prisma.employeeFace.updateMany({ where: { employee_id: e.id, deleted_at: null }, data: { deleted_at: new Date(), embedding: Buffer.alloc(0) } });
  await auditReq(req, { action: 'face.delete', entity_type: 'employee', entity_id: e.id });
  res.json({ data: { enrolled: false } });
});

// ─── Documents ───────────────────────────────────────────────────────────────
export const listDocuments = asyncHandler(async (req, res) => {
  const rows = await prisma.document.findMany({ where: { employee_id: req.params.id, deleted_at: null }, orderBy: { collected_on: 'desc' } });
  res.json({ data: rows.map((d) => ({ ...d, collected_on: fromDbDate(d.collected_on), expires_on: fromDbDate(d.expires_on), has_file: !!d.file_key })) });
});

export const uploadDocument = asyncHandler(async (req, res) => {
  const fields = { ...req.body };
  if (fields.expires_on === '') fields.expires_on = null;
  const b = documentCreateSchema.parse(fields);
  const e = await mustLoad(req.params.id);
  assertWritable(e);
  const doc = await prisma.document.create({
    data: {
      employee_id: e.id,
      doc_type: b.doc_type,
      collected_on: toDbDate(b.collected_on),
      expires_on: b.expires_on ? toDbDate(b.expires_on) : null,
      file_key: req.file ? path.basename(req.file.path) : null,
      file_name: req.file?.originalname ?? null,
    },
  });
  await auditReq(req, { action: 'document.add', entity_type: 'employee', entity_id: e.id, detail: { doc_type: b.doc_type, document_id: doc.id } });
  res.status(201).json({ data: doc });
});

export const verifyDocument = asyncHandler(async (req, res) => {
  const d = await prisma.document.update({ where: { id: req.params.docId }, data: { verified_at: new Date() } });
  await auditReq(req, { action: 'document.verify', entity_type: 'employee', entity_id: req.params.id, detail: { document_id: d.id, doc_type: d.doc_type } });
  res.json({ data: d });
});

export const downloadDocument = asyncHandler(async (req, res) => {
  const d = await prisma.document.findFirst({ where: { id: req.params.docId, employee_id: req.params.id, deleted_at: null } });
  if (!d?.file_key) throw notFound('That file');
  const file = path.join(documentsDir, path.basename(d.file_key));
  if (!existsSync(file)) throw notFound('That file');
  await auditReq(req, { action: 'document.read', entity_type: 'employee', entity_id: req.params.id, detail: { document_id: d.id } });
  res.setHeader('Content-Disposition', `inline; filename="${(d.file_name ?? d.file_key).replace(/"/g, '')}"`);
  createReadStream(file).pipe(res);
});

// ─── Letters ─────────────────────────────────────────────────────────────────
export const listLetters = asyncHandler(async (req, res) => {
  const rows = await prisma.letter.findMany({ where: { employee_id: req.params.id, deleted_at: null }, orderBy: { created_at: 'desc' } });
  res.json({ data: rows.map((l) => ({ ...l, issued_on: fromDbDate(l.issued_on) })) });
});

/** A letter freezes the figures it states, so it reprints years later exactly as issued. */
export const createLetter = asyncHandler(async (req, res) => {
  const { kind, issue } = z
    .object({ kind: z.enum(LETTER_KINDS), issue: z.boolean().default(true) })
    .strict()
    .parse(req.body);
  const e = await mustLoad(req.params.id);
  const company = await prisma.company.findFirst();
  const date = today() > fromDbDate(e.joined_on) ? today() : fromDbDate(e.joined_on);
  const cur = await salaryOn(prisma, e.id, kind === 'RELIEVING' || kind === 'EXPERIENCE' ? (fromDbDate(e.last_day) ?? date) : date);
  const preview = cur
    ? await previewSalary(prisma, { mode: cur.mode, amount: cur.amount, structure_id: cur.structure_id, date, gender: e.gender, pt_state: e.statutory.pt_state, chosen_gross: cur.monthly_gross })
    : null;
  const count = await prisma.letter.count();
  const ref = `AJPWER/${kind.slice(0, 3)}/${date.slice(0, 4)}/${String(count + 1).padStart(5, '0')}`;
  const snapshot = {
    company: company ? { name: company.name, address: company.address } : null,
    employee: { code: e.code, name: e.name, designation: e.designation, department: e.department.name, joined_on: fromDbDate(e.joined_on), last_day: fromDbDate(e.last_day), address: e.address },
    pay_group: e.pay_group.name,
    salary:
      cur && preview
        ? {
            mode: cur.mode,
            amount: cur.amount,
            monthly_gross: preview.gross,
            annual_ctc: preview.ctc.annual_ctc,
            components: preview.structure.monthly.map((c) => ({ name: c.name, amount: c.amount })),
            yearly: preview.structure.yearly.map((c) => ({ name: c.name, amount: c.amount })),
            employer_pf: preview.ctc.employer_pf,
            employer_esi: preview.ctc.employer_esi,
            take_home: preview.take_home,
          }
        : null,
    generated_on: today(),
  };
  const { actor, ip } = who(req);
  const letter = await prisma.$transaction(async (tx) => {
    const l = await tx.letter.create({ data: { employee_id: e.id, kind, ref, issued_on: issue ? toDbDate(today()) : null, snapshot: JSON.parse(JSON.stringify(snapshot)) } });
    if (kind === 'JOINING' && issue) await markTask(tx, e.id, 'JOINING_LETTER', actor);
    await audit(tx, { actor, ip, action: 'letter.issue', entity_type: 'employee', entity_id: e.id, detail: { kind, ref } });
    return l;
  });
  res.status(201).json({ data: letter });
});

export const getLetter = asyncHandler(async (req, res) => {
  const l = await prisma.letter.findFirst({ where: { id: req.params.letterId, employee_id: req.params.id } });
  if (!l) throw notFound('That letter');
  res.json({ data: { ...l, issued_on: fromDbDate(l.issued_on) } });
});

// Month helper for the UI (so the client never reads a clock for IST).
export const getTodayMeta = asyncHandler(async (_req, res) => {
  res.json({ data: { today: today(), month: ymOf(today()), label: formatYearMonth(ymOf(today())) } });
});
