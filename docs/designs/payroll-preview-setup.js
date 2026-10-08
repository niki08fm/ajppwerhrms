import {
  addDays, AJPWER_LEAVE_RULES, AJPWER_RATES, CALENDAR_METHODS, dayName, monthDates,
  parsePolicyRules, payGroupPatchSchema, payGroupSchema, POLICY_KINDS,
  POLICY_KIND_MISSING_WARNING, policyCreateSchema, policyVersionSchema,
  SEED_PT_SLABS, SEED_TAX_REGIMES, STATUTORY_GRATUITY_RULES, structureCreateSchema,
} from '@ajpwer/shared';
import { salaryPreview } from '../../backend/src/calculations/pay/preview.js';
import { validateStructure } from '../../backend/src/calculations/pay/structure.js';
import { calendarDivisor } from '../../backend/src/calculations/pay/lop.js';

// Fictional preview configuration only. No database, real employee identifiers, or network calls.
const uuid = (suffix) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
export const PREVIEW_IDS = {
  groupSite: uuid(101), groupOffice: uuid(102), structureSite: uuid(201), structureOffice: uuid(202),
  shift: uuid(301), departmentElectrical: uuid(401), departmentCivil: uuid(402), departmentAdmin: uuid(403),
  siteMain: uuid(701), siteOffice: uuid(702),
};
const TODAY = '2026-10-08';
const clone = (value) => JSON.parse(JSON.stringify(value));
const dateOf = (state) => state.today ?? TODAY;
const ok = (data, status = 200) => ({ status, json: { data } });
const fail = (message, status = 422, field = null, code = 'VALIDATION') => ({ status, json: { error: { code, message, field } } });
const notFound = (name) => fail(`${name} was not found in this preview.`, 404, null, 'NOT_FOUND');
const newId = (state) => {
  state.sequence = (state.sequence ?? 100) + 1;
  return uuid(10_000 + state.sequence);
};
const workingDays = (ym, weeklyOff) => monthDates(ym).filter((day) => !weeklyOff.includes(dayName(day))).length;

function component(seq, name, calc_type, calc_value, counts_as_wages = false) {
  return { seq, name, calc_type, calc_value, max_amount: null, frequency: 'MONTHLY', pay_month: null, is_taxable: true, counts_as_wages, colour: `chart-${seq}` };
}

export function createPreviewSetupData() {
  const definitions = [
    ['ATTENDANCE', 'Site attendance', { standard_min: 540, half_day_min: 0, half_day_upto_min: 240, grace_min: 15 }],
    ['OVERTIME', 'Site overtime', { multiplier: 2, base: 'COMPONENTS', components: ['basic', 'hra', 'da'], divisor: null, hours_per_day: 8, after_min: 30, rounding_min: 30, monthly_cap_min: 3000, counts_from: 'SHIFT_END' }],
    ['WEEKOFF_PAY', 'Paid weekly off', { paid: true, sandwich: false }],
    ['HOLIDAY_PAY', 'Paid holidays', { paid: true, sandwich: false }],
    ['HOLIDAY_WORK', 'Off-day work pay', { holiday: { mode: 'PAY', rate_pct: 200, base: 'GROSS', min_minutes: 240 }, weekly_off: { mode: 'PAY', rate_pct: 200, base: 'GROSS', min_minutes: 240 } }],
    ['LEAVE', 'Company leave', AJPWER_LEAVE_RULES],
    ['GRATUITY', 'Statutory gratuity', STATUTORY_GRATUITY_RULES],
    ['OVERTIME', 'Office overtime', { multiplier: 1.5, base: 'GROSS', divisor: null, hours_per_day: 8, after_min: 30, rounding_min: 30, monthly_cap_min: null, counts_from: 'STANDARD_DAY' }],
  ];
  const policies = definitions.map(([kind, name, rules], index) => ({
    id: uuid(501 + index), policy_key: uuid(601 + index), kind, name, version: 1,
    valid_from: '2026-01-01', valid_to: null, status: 'ACTIVE', rules: clone(rules),
    created_by: 'Preview HR', created_at: `${TODAY}T08:00:00.000Z`,
  }));
  return {
    sites: [{ id: PREVIEW_IDS.siteMain, name: 'Main site' }, { id: PREVIEW_IDS.siteOffice, name: 'Office' }],
    shifts: [{ id: PREVIEW_IDS.shift, name: 'Day shift', start_min: 540, end_min: 1080, break_min: 60, crosses_midnight: false }],
    departments: [
      { id: PREVIEW_IDS.departmentElectrical, name: 'Electrical', colour: 'chart-1' },
      { id: PREVIEW_IDS.departmentCivil, name: 'Civil', colour: 'chart-2' },
      { id: PREVIEW_IDS.departmentAdmin, name: 'Administration', colour: 'chart-3' },
    ],
    policies,
    groups: [
      { id: PREVIEW_IDS.groupSite, name: 'Site workforce', frequency: 'MONTHLY', pay_day: 7, calendar_method: 'FIXED_26', weekly_off: ['SUN'], shift_id: PREVIEW_IDS.shift, policy_ids: policies.slice(0, 7).map((p) => p.id) },
      { id: PREVIEW_IDS.groupOffice, name: 'Office staff', frequency: 'MONTHLY', pay_day: 7, calendar_method: 'ACTUAL', weekly_off: ['SAT', 'SUN'], shift_id: PREVIEW_IDS.shift, policy_ids: policies.filter((p) => p.name !== 'Site overtime').map((p) => p.id) },
    ],
    structures: [
      { id: PREVIEW_IDS.structureSite, name: 'Site salary · Basic, HRA and DA', duplicated_from: null, created_at: `${TODAY}T08:00:00.000Z`, components: [component(1, 'Basic', 'PCT_GROSS', 50, true), component(2, 'HRA', 'PCT_GROSS', 20), component(3, 'DA', 'PCT_GROSS', 10, true), component(4, 'Special Allowance', 'BALANCE', 0)] },
      { id: PREVIEW_IDS.structureOffice, name: 'Office salary · DA included', duplicated_from: null, created_at: `${TODAY}T08:00:00.000Z`, components: [component(1, 'Basic', 'PCT_GROSS', 50, true), component(2, 'HRA', 'PCT_BASIC', 40), component(3, 'DA', 'FIXED', 0, true), component(4, 'Special Allowance', 'BALANCE', 0)] },
    ],
  };
}

export function previewSalary(state, input) {
  const statutory = input.statutory ?? {};
  const ptState = input.pt_state ?? statutory.pt_state ?? 'Telangana';
  const rates = clone(state.rates ?? AJPWER_RATES);
  const breakup = salaryPreview({
    mode: input.mode ?? 'GROSS', amount: input.amount, components: input.components,
    ...(input.chosen_gross !== undefined ? { chosen_gross: input.chosen_gross } : {}),
    pf: { pf_enabled: input.pf_enabled ?? statutory.pf_enabled ?? true, pf_restrict_to_ceiling: statutory.pf_restrict_to_ceiling ?? true, vpf_pct: statutory.vpf_pct ?? 0 },
    esi_enabled: input.esi_enabled ?? statutory.esi_enabled ?? true,
    pt: { pt_applicable: statutory.pt_applicable ?? true, pt_state: ptState, gender: input.gender ?? 'MALE' },
    rates,
    pt_slabs: clone(SEED_PT_SLABS),
    regime: clone(SEED_TAX_REGIMES.find((r) => r.code === (statutory.tax_regime_code ?? 'NEW'))),
    declarations: { decl_80c: statutory.decl_80c ?? 0, decl_80d: statutory.decl_80d ?? 0, decl_rent_monthly: statutory.decl_rent_monthly ?? 0, decl_metro: statutory.decl_metro ?? false },
    month: Number(dateOf(state).slice(5, 7)),
  });
  return { breakup, rates, pt_state: ptState, ctc_basis: breakup.ctc.ctc_basis };
}

export function previewStructureView(state, id) {
  const structure = state.structures.find((s) => s.id === id);
  if (!structure) return null;
  const at = previewSalary(state, { mode: 'GROSS', amount: 2_400_000, components: structure.components });
  const salaries = Object.values(state.salaries ?? {}).flat().filter((s) => !s.deleted_at && s.structure_id === id);
  return {
    ...clone(structure),
    people: salaries.filter((s) => s.valid_from <= dateOf(state) && (!s.valid_to || s.valid_to >= dateOf(state))).length,
    immutable: salaries.length > 0,
    sample: { ...at.breakup.structure, gross: 2_400_000, annual_ctc: at.breakup.ctc.annual_ctc },
    validation: validateStructure(structure.components, 2_400_000, at.ctc_basis),
  };
}

export function previewPolicyView(state, id) {
  const policy = state.policies.find((p) => p.id === id);
  return policy ? { ...clone(policy), pay_groups: state.groups.filter((g) => g.policy_ids.includes(id)).map((g) => ({ id: g.id, name: g.name })) } : null;
}

export function previewPayGroupView(state, id) {
  const group = typeof id === 'object' ? id : state.groups.find((g) => g.id === id);
  if (!group) return null;
  const ym = dateOf(state).slice(0, 7);
  const policies = state.policies.filter((p) => group.policy_ids.includes(p.id));
  const inForce = new Set(policies.filter((p) => p.valid_from <= dateOf(state) && (!p.valid_to || p.valid_to >= dateOf(state))).map((p) => p.kind));
  return {
    ...clone(group), shift: clone(state.shifts.find((s) => s.id === group.shift_id)),
    policies: policies.map((p) => clone(p)).sort((a, b) => a.kind.localeCompare(b.kind) || b.version - a.version),
    headcount: (state.employees ?? []).filter((e) => e.pay_group_id === group.id && ['ACTIVE', 'NOTICE', 'ONBOARDING'].includes(e.status)).length,
    divisor_this_month: calendarDivisor(group.calendar_method, ym, workingDays(ym, group.weekly_off)),
    warnings: POLICY_KINDS.filter((kind) => !inForce.has(kind)).map((kind) => ({ kind, message: POLICY_KIND_MISSING_WARNING[kind] })),
  };
}
export const setupGroupView = previewPayGroupView;

function groupPoliciesError(state, ids) {
  if (new Set(ids).size !== ids.length) return fail('Select each policy only once.', 422, 'policy_ids');
  const selected = ids.map((id) => state.policies.find((p) => p.id === id));
  if (selected.some((p) => !p)) return fail('One of the selected policies is unavailable.', 422, 'policy_ids');
  for (const kind of POLICY_KINDS) {
    if (new Set(selected.filter((p) => p.kind === kind).map((p) => p.policy_key)).size > 1) return fail('Choose one policy or None for each kind.', 422, 'policy_ids');
  }
  return null;
}

function memberView(employee) {
  return { id: employee.id, name: employee.name, code: employee.code, status: employee.status, pay_group_id: employee.pay_group_id };
}

/** Return null for routes owned by the preview's employee/profile module. */
export async function handlePreviewSetupApi(state, request) {
  const { method, path, body = {}, searchParams = new URLSearchParams() } = request;
  try {
    if (method === 'GET' && path === '/calendar-methods') {
      const month = searchParams.get('month') || dateOf(state).slice(0, 7);
      const weeklyOff = (searchParams.get('weekly_off') ?? 'SUN').split(',').filter(Boolean);
      const gross = Number(searchParams.get('gross') || 2_600_000);
      const days = workingDays(month, weeklyOff);
      return { status: 200, json: { data: CALENDAR_METHODS.map((m) => ({ method: m, divisor: calendarDivisor(m, month, days), day_rate: Math.round(gross / calendarDivisor(m, month, days)) })), meta: { month, gross, working_days: days } } };
    }
    if (method === 'GET' && path === '/shifts') return ok(clone(state.shifts));
    if (method === 'GET' && path === '/departments') return ok(clone(state.departments));
    if (method === 'GET' && path === '/pay-groups') return ok(state.groups.map((g) => previewPayGroupView(state, g.id)));
    if (method === 'POST' && path === '/pay-groups') {
      const data = payGroupSchema.parse(body);
      const invalid = groupPoliciesError(state, data.policy_ids);
      if (invalid) return invalid;
      if (!state.shifts.some((s) => s.id === data.shift_id)) return fail('Choose an available shift.', 422, 'shift_id');
      const group = { ...data, id: newId(state) };
      state.groups.push(group);
      return ok(previewPayGroupView(state, group.id), 201);
    }
    const members = /^\/pay-groups\/([^/]+)\/employees$/.exec(path);
    if (members) {
      const group = state.groups.find((g) => g.id === members[1]);
      if (!group) return notFound('That pay group');
      if (method === 'GET') return ok((state.employees ?? []).filter((e) => e.pay_group_id === group.id).map(memberView));
      if (method === 'POST') {
        const ids = body.employee_ids;
        if (!Array.isArray(ids) || !ids.length) return fail('Select at least one employee.', 422, 'employee_ids');
        const employees = [...new Set(ids)].map((id) => state.employees.find((e) => e.id === id));
        if (employees.some((e) => !e)) return notFound('A selected employee');
        if (employees.some((e) => e.status === 'EXITED' || e.read_only)) return fail('Exited employees are read only.', 403, null, 'FORBIDDEN');
        let moved = 0;
        for (const employee of employees) {
          if (employee.pay_group_id === group.id) continue;
          const from = employee.pay_group_id;
          employee.pay_group_id = group.id;
          employee.updated_at = new Date().toISOString();
          state.timeline ??= {};
          state.timeline[employee.id] ??= [];
          state.timeline[employee.id].unshift({ id: `preview-event-${++state.sequence}`, action: 'employee.pay_group_change', at: `${dateOf(state)}T10:00:00.000Z`, actor: 'Preview HR', detail: { from, to: group.id } });
          moved++;
        }
        return ok({ moved, unchanged: employees.length - moved, employees: employees.map(memberView) });
      }
    }
    const groupMatch = /^\/pay-groups\/([^/]+)$/.exec(path);
    if (groupMatch) {
      const group = state.groups.find((g) => g.id === groupMatch[1]);
      if (!group) return notFound('That pay group');
      if (method === 'GET') return ok(previewPayGroupView(state, group.id));
      if (method === 'PATCH') {
        const data = payGroupPatchSchema.parse(body);
        const invalid = groupPoliciesError(state, data.policy_ids ?? group.policy_ids);
        if (invalid) return invalid;
        if (data.shift_id && !state.shifts.some((s) => s.id === data.shift_id)) return fail('Choose an available shift.', 422, 'shift_id');
        Object.assign(group, data);
        return ok(previewPayGroupView(state, group.id));
      }
    }
    if (method === 'GET' && path === '/policies') {
      const kind = searchParams.get('kind');
      return ok(state.policies.filter((p) => !kind || p.kind === kind).map((p) => previewPolicyView(state, p.id)).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || b.version - a.version));
    }
    if (method === 'POST' && path === '/policies') {
      const data = policyCreateSchema.parse(body);
      const rules = parsePolicyRules(data.kind, data.rules);
      const policy = { ...data, rules, id: newId(state), policy_key: newId(state), version: 1, valid_to: null, status: 'ACTIVE', created_by: 'Preview HR', created_at: new Date().toISOString() };
      state.policies.push(policy);
      return ok(previewPolicyView(state, policy.id), 201);
    }
    const policyVersions = /^\/policies\/([^/]+)\/versions$/.exec(path);
    if (policyVersions) {
      const rows = state.policies.filter((p) => p.policy_key === policyVersions[1]).sort((a, b) => b.version - a.version);
      if (!rows.length) return notFound('That policy');
      if (method === 'GET') return ok(rows.map((p) => previewPolicyView(state, p.id)));
      if (method === 'POST') {
        const data = policyVersionSchema.parse(body);
        const latest = rows[0];
        const rules = parsePolicyRules(latest.kind, data.rules);
        if (data.valid_from <= latest.valid_from) return fail(`The new version must start after ${latest.valid_from}.`, 422, 'valid_from');
        latest.valid_to = addDays(data.valid_from, -1);
        const next = { ...clone(latest), ...data, rules, id: newId(state), version: latest.version + 1, valid_to: null, created_at: new Date().toISOString() };
        state.policies.push(next);
        for (const group of state.groups.filter((g) => g.policy_ids.includes(latest.id))) group.policy_ids.push(next.id);
        return ok(previewPolicyView(state, next.id), 201);
      }
    }
    if (method === 'GET' && path === '/structures') return ok(state.structures.map((s) => previewStructureView(state, s.id)));
    if (method === 'POST' && path === '/structures/validate') {
      const components = structureCreateSchema.shape.components.parse(body.components);
      const sample = body.sample ?? { mode: 'GROSS', amount: 2_400_000 };
      if (!['GROSS', 'CTC'].includes(sample.mode) || !Number.isInteger(sample.amount) || sample.amount < 1) return fail('Enter a positive sample salary.', 422, 'sample');
      const at = previewSalary(state, { ...sample, components });
      return ok({ ...validateStructure(components, at.breakup.gross, at.ctc_basis), breakup: at.breakup, rates: at.rates, pt_state: at.pt_state });
    }
    if (method === 'POST' && path === '/structures') {
      const data = structureCreateSchema.parse(body);
      const at = previewSalary(state, { mode: 'GROSS', amount: 2_400_000, components: data.components });
      const validation = validateStructure(data.components, 2_400_000, at.ctc_basis);
      if (validation.errors.length) return fail(validation.errors[0], 422, 'components');
      const structure = { ...data, id: newId(state), duplicated_from: data.duplicated_from ?? null, created_at: new Date().toISOString() };
      state.structures.push(structure);
      return ok(previewStructureView(state, structure.id), 201);
    }
    const structureMatch = /^\/structures\/([^/]+)$/.exec(path);
    if (structureMatch && method === 'GET') {
      const structure = previewStructureView(state, structureMatch[1]);
      return structure ? ok(structure) : notFound('That salary structure');
    }
    return null;
  } catch (error) {
    return fail(error.issues?.[0]?.message ?? error.message ?? 'Check the preview settings.', 422, error.issues?.[0]?.path?.join('.') ?? null);
  }
}
