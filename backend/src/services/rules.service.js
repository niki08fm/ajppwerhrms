import { esiRatesSchema, gratuityRatesSchema, parsePolicyRules, pfRatesSchema } from '@ajpwer/shared';
import { AppError } from '../utils/errors.js';
import { fromDbDate, n, toDbDate } from '../utils/dbDates.js';

/** The statutory rates row valid on a date: latest valid_from ≤ date. */
export async function ratesOn(db, date) {
  const row = await db.statutoryRates.findFirst({
    where: { valid_from: { lte: toDbDate(date) }, deleted_at: null },
    orderBy: { valid_from: 'desc' },
  });
  if (!row) throw new AppError('NOT_FOUND', `No statutory rates are set up for ${date}. Add them under Setup → Statutory rules.`, 409);
  return {
    id: row.id,
    valid_from: fromDbDate(row.valid_from),
    pf: pfRatesSchema.parse(row.pf),
    esi: esiRatesSchema.parse(row.esi),
    gratuity: gratuityRatesSchema.parse(row.gratuity),
    recovery_cap_pct: Number(row.recovery_cap_pct),
  };
}

export async function ratesById(db, id) {
  const row = await db.statutoryRates.findUniqueOrThrow({ where: { id } });
  return {
    id: row.id,
    valid_from: fromDbDate(row.valid_from),
    pf: pfRatesSchema.parse(row.pf),
    esi: esiRatesSchema.parse(row.esi),
    gratuity: gratuityRatesSchema.parse(row.gratuity),
    recovery_cap_pct: Number(row.recovery_cap_pct),
  };
}

export async function ptSlabs(db) {
  const rows = await db.ptSlab.findMany({ where: { deleted_at: null } });
  return rows.map((r) => ({
    state: r.state,
    gender_scope: r.gender_scope,
    upto_amount: r.upto_amount === null ? null : n(r.upto_amount),
    amount: n(r.amount),
    feb_amount: r.feb_amount === null ? null : n(r.feb_amount),
  }));
}

/** Both regimes as valid on a date. */
export async function regimesOn(db, date) {
  const rows = await db.taxRegime.findMany({
    where: { valid_from: { lte: toDbDate(date) }, deleted_at: null },
    include: { slabs: { where: { deleted_at: null } } },
    orderBy: { valid_from: 'desc' },
  });
  const pick = (code) => {
    const r = rows.find((x) => x.code === code) ?? null;
    if (!r) throw new AppError('NOT_FOUND', `The ${code.toLowerCase()} tax regime is not set up for ${date}.`, 409);
    return {
      code,
      name: r.name,
      valid_from: fromDbDate(r.valid_from),
      std_deduction: n(r.std_deduction),
      rebate_limit: n(r.rebate_limit),
      rebate_max: r.rebate_max === null ? null : n(r.rebate_max),
      marginal_relief: r.marginal_relief,
      allows_80c: r.allows_80c,
      allows_hra: r.allows_hra,
      cess_pct: Number(r.cess_pct),
      slabs: r.slabs.map((s) => ({ upto_amount: s.upto_amount === null ? null : n(s.upto_amount), rate: Number(s.rate) })),
    };
  };
  return { NEW: pick('NEW'), OLD: pick('OLD') };
}

export function toComponentDefs(rows) {
  return rows
    .map((c) => ({
      id: c.id,
      seq: c.seq,
      name: c.name,
      calc_type: c.calc_type,
      calc_value: Number(c.calc_value),
      max_amount: c.max_amount === null ? null : Number(c.max_amount),
      frequency: c.frequency,
      pay_month: c.pay_month,
      is_taxable: c.is_taxable,
      counts_as_wages: c.counts_as_wages,
      colour: c.colour,
    }))
    .sort((a, b) => a.seq - b.seq);
}

export async function structureComponents(db, structureId) {
  const rows = await db.salaryComponent.findMany({ where: { structure_id: structureId, deleted_at: null }, orderBy: { seq: 'asc' } });
  return toComponentDefs(rows);
}

export function toAttachedPolicy(p) {
  return {
    id: p.id,
    policy_key: p.policy_key,
    kind: p.kind,
    name: p.name,
    version: p.version,
    valid_from: fromDbDate(p.valid_from),
    valid_to: fromDbDate(p.valid_to),
    rules: parsePolicyRules(p.kind, p.rules),
  };
}

export async function payGroupRules(db, payGroupId) {
  const g = await db.payGroup.findUniqueOrThrow({
    where: { id: payGroupId },
    include: { shift: true, policies: { where: { deleted_at: null }, include: { policy: true } } },
  });
  return {
    id: g.id,
    name: g.name,
    calendar_method: g.calendar_method,
    weekly_off: g.weekly_off,
    shift: g.shift,
    structure_id: g.structure_id,
    policies: g.policies.filter((x) => !x.policy.deleted_at).map((x) => toAttachedPolicy(x.policy)),
  };
}

/** Cache of pay group rules for bulk work (a payroll run, the register). */
export function payGroupRulesCache(db) {
  const cache = new Map();
  return (id) => {
    let p = cache.get(id);
    if (!p) {
      p = payGroupRules(db, id);
      cache.set(id, p);
    }
    return p;
  };
}

export async function holidaysBetween(db, from, to) {
  const rows = await db.holiday.findMany({ where: { date: { gte: toDbDate(from), lte: toDbDate(to) }, deleted_at: null } });
  return new Map(rows.map((h) => [fromDbDate(h.date), h.name]));
}

/** The salary record valid on a date. */
export async function salaryOn(db, employeeId, date) {
  const row = await db.employeeSalary.findFirst({
    where: {
      employee_id: employeeId,
      deleted_at: null,
      valid_from: { lte: toDbDate(date) },
      OR: [{ valid_to: null }, { valid_to: { gte: toDbDate(date) } }],
    },
    orderBy: { valid_from: 'desc' },
  });
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    amount: n(row.amount),
    monthly_gross: n(row.monthly_gross),
    structure_id: row.structure_id,
    valid_from: fromDbDate(row.valid_from),
    valid_to: fromDbDate(row.valid_to),
  };
}
