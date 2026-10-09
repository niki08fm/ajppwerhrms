import {
  addDays,
  addMonths,
  AJPWER_RATES,
  employeeUpdateSchema,
  isYearMonth,
  monthDates,
  POLICY_KINDS,
  POLICY_KIND_LABELS,
  POLICY_KIND_MISSING_WARNING,
  salaryRevisionSchema,
  SEED_PT_SLABS,
  SEED_TAX_REGIMES,
  statutoryUpdateSchema,
} from '@ajpwer/shared';
import { compareRegimes } from '../../backend/src/calculations/statutory/incomeTax.js';
import { createPreviewSetupData, handlePreviewSetupApi, PREVIEW_IDS, previewPayGroupView, previewSalary } from './payroll-preview-setup.js';

// Fictional examples only. The downloadable preview never reads a database or the uploaded employee report.
export const PREVIEW_TODAY = '2026-10-08';
const clone = (value) => JSON.parse(JSON.stringify(value));
const uuid = (suffix) => `40000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
const ok = (data, status = 200, meta = undefined) => ({ status, json: { data: clone(data), ...(meta ? { meta } : {}) } });
const fail = (message, status = 422, field = null, code = 'VALIDATION') => ({ status, json: { error: { code, message, field } } });
const notFound = () => fail('That sample employee was not found.', 404, null, 'NOT_FOUND');
const newId = (state) => uuid(10000 + ++state.sequence);
const nextTime = (state) => new Date(new Date(`${state.today}T10:00:00.000Z`).getTime() + ++state.sequence * 1000).toISOString();

export function appendPreviewTimeline(state, employeeId, action, detail) {
  state.timeline[employeeId] ??= [];
  state.timeline[employeeId].unshift({ id: newId(state), action, at: nextTime(state), actor: 'Preview HR', detail: clone(detail) });
}

function defaultStatutory() {
  return {
    pf_enabled: true,
    pf_restrict_to_ceiling: true,
    vpf_pct: 0,
    esi_enabled: true,
    esi_locked_until: null,
    pt_applicable: true,
    pt_state: 'Telangana',
    pt_exempt_reason: null,
    tax_regime_code: 'NEW',
    decl_80c: 0,
    decl_80d: 0,
    decl_rent_monthly: 0,
    decl_metro: false,
  };
}

export function createPayrollPreviewState() {
  const setup = createPreviewSetupData();
  const state = {
    ...setup,
    today: PREVIEW_TODAY,
    sequence: 100,
    rates: clone(AJPWER_RATES),
    pt_slabs: clone(SEED_PT_SLABS),
    regimes: Object.fromEntries(SEED_TAX_REGIMES.map((regime) => [regime.code, clone(regime)])),
    employees: [],
    salaries: {},
    timeline: {},
    holds: {},
    attendance_samples: {},
    paidPayroll: [],
  };
  const samples = [
    ['Anita Demo', 'Electrical Engineer', PREVIEW_IDS.departmentElectrical, PREVIEW_IDS.groupSite],
    ['Ravi Sample', 'Site Supervisor', PREVIEW_IDS.departmentCivil, PREVIEW_IDS.groupSite],
    ['Meera Example', 'Safety Coordinator', PREVIEW_IDS.departmentCivil, PREVIEW_IDS.groupSite],
    ['Kiran Demo', 'HR Coordinator', PREVIEW_IDS.departmentAdmin, PREVIEW_IDS.groupOffice],
    ['Dev Sample', 'Office Assistant', PREVIEW_IDS.departmentAdmin, PREVIEW_IDS.groupOffice],
  ];
  samples.forEach(([name, designation, department_id, pay_group_id], index) => {
    const id = uuid(index + 1);
    const employee = {
      id,
      code: `AJDEMO${String(index + 1).padStart(3, '0')}`,
      name,
      designation,
      department_id,
      pay_group_id,
      status: 'ACTIVE',
      joined_on: index === 1 ? '2017-01-01' : '2025-01-01',
      updated_at: `${PREVIEW_TODAY}T08:00:00.000Z`,
      gender: index === 0 || index === 2 ? 'FEMALE' : 'MALE',
      dob: null,
      phone: index === 4 ? '' : `900000000${index + 1}`,
      email: `sample${index + 1}@example.test`,
      address: 'Fictional sample address',
      blood_group: null,
      last_day: null,
      resigned_on: null,
      exit_reason: null,
      read_only: false,
      statutory: defaultStatutory(),
      identity: {
        pan: 'ABCDE1234F',
        aadhaar: `00000000000${index + 1}`,
        uan: `00000000000${index + 1}`,
        esi_number: null,
        bank_account: `00000000000${index + 1}`,
        bank_ifsc: 'TEST0000001',
        bank_name: 'Demo Bank',
      },
    };
    state.employees.push(employee);
    // Attendance is fictional too; site assignment is independent of the payroll group.
    state.attendance_samples[id] = [
      { site_id: PREVIEW_IDS.siteMain, ot_min: 60, late_min: 20, early_min: 0, open_now: true, status: 'PRESENT' },
      { site_id: PREVIEW_IDS.siteMain, ot_min: 90, late_min: 0, early_min: 0, open_now: true, status: 'PRESENT' },
      { site_id: PREVIEW_IDS.siteMain, ot_min: 0, late_min: 0, early_min: 0, open_now: false, status: 'ABSENT' },
      { site_id: PREVIEW_IDS.siteOffice, ot_min: 45, late_min: 0, early_min: 0, open_now: true, status: 'PRESENT', visited_sites: [PREVIEW_IDS.siteMain, PREVIEW_IDS.siteOffice] },
      { site_id: PREVIEW_IDS.siteOffice, ot_min: 0, late_min: 0, early_min: 45, open_now: false, status: 'PRESENT' },
    ][index];
    state.salaries[id] = [];
    state.timeline[id] = [
      {
        id: newId(state),
        action: 'employee.create',
        at: `${employee.joined_on}T04:00:00.000Z`,
        actor: 'Preview HR',
        detail: { joined_on: employee.joined_on, designation },
      },
    ];
    state.holds[id] = {
      current: null,
      history: [],
      open_months: [PREVIEW_TODAY.slice(0, 7), addMonths(PREVIEW_TODAY.slice(0, 7), 1), addMonths(PREVIEW_TODAY.slice(0, 7), 2)],
      run_months: [],
    };
    if (index === 4) return;
    const structure_id = index < 3 ? PREVIEW_IDS.structureSite : PREVIEW_IDS.structureOffice;
    const mode = index === 3 ? 'CTC' : 'GROSS';
    const amount = [3_000_000, 2_200_000, 1_800_000, 60_000_000][index];
    const initial = {
      id: newId(state),
      employee_id: id,
      mode,
      amount,
      structure_id,
      valid_from: employee.joined_on,
      valid_to: null,
      reason: 'Initial sample salary',
      created_by: 'Preview HR',
      created_at: `${employee.joined_on}T08:00:00.000Z`,
    };
    initial.monthly_gross = calculateSalary(state, employee, initial).gross;
    state.salaries[id].push(initial);
    if (index === 0) {
      // Several revisions make the card's local horizontal history useful without growing the page.
      const changes = [
        ['2025-01-01', 2_000_000, 'Initial sample salary'],
        ['2025-04-01', 2_200_000, 'Role review'],
        ['2025-07-01', 2_400_000, 'Project responsibility'],
        ['2025-10-01', 2_500_000, 'Performance review'],
        ['2026-04-01', 3_000_000, 'Annual sample review'],
      ];
      state.salaries[id] = changes.map(([valid_from, amount, reason], changeIndex) => ({
        ...initial, id: changeIndex ? newId(state) : initial.id,
        amount, monthly_gross: amount, valid_from, reason,
        created_at: `${valid_from}T08:00:00.000Z`,
      }));
      normalizeSalaryPeriods(state.salaries[id]);
      state.salaries[id].slice(1).forEach((revision, revisionIndex) => {
        state.timeline[id].unshift({
          id: newId(state), action: 'salary.revise', at: revision.created_at, actor: 'Preview HR',
          detail: {
            old: { monthly_gross: state.salaries[id][revisionIndex].monthly_gross },
            new: { monthly_gross: revision.monthly_gross, valid_from: revision.valid_from },
            reason: revision.reason,
          },
        });
      });
    }
  });
  // Synthetic paid months use the same calculator and effective salary as the sample profile.
  // Anita's current April revision stays editable; Ravi demonstrates ten years of frozen slips.
  for (const [employeeIndex, firstMonth, lastMonth] of [[0, '2025-01', '2026-03'], [1, '2017-01', '2026-07']]) {
    for (let month = firstMonth; month <= lastMonth; month = addMonths(month, 1)) {
      appendPaidPreviewMonth(state, state.employees[employeeIndex], month);
    }
  }
  state.paidPayroll.sort((a, b) => b.period_ym.localeCompare(a.period_ym));
  state.todayStaff = previewTodayPeople(state, state.today);
  return state;
}

function appendPaidPreviewMonth(state, employee, period_ym) {
  const salary = salaryOn(state, employee.id, `${period_ym}-01`);
  const calculation = calculateSalary(state, employee, { ...salary, date: `${period_ym}-01`, chosen_gross: salary.monthly_gross });
  state.paidPayroll.push({
    id: newId(state), employee_id: employee.id, period_ym, state: 'PAID',
    salary_id: salary.id, salary_snapshot: clone(salary), divisor: 26, paid_days: 26,
    lop_days: 0, net: calculation.take_home, gross: calculation.gross,
    lines: [
      ...calculation.structure.monthly.map((component) => ({ seq: component.seq, code: component.name.toUpperCase().replaceAll(' ', '_'), name: component.name, kind: 'COMPONENT', amount: component.amount })),
      ...[['PF', 'Provident fund', calculation.pf.employee], ['ESI', 'ESI', calculation.esi.employee], ['PT', 'Professional tax', calculation.pt.amount], ['TDS', 'Income tax', calculation.tds_monthly]]
        .filter(([, , amount]) => amount > 0)
        .map(([code, name, amount], deductionIndex) => ({ seq: 10 + deductionIndex, code, name, kind: 'DEDUCTION', amount })),
    ],
  });
}

function salaryOn(state, employeeId, date = state.today) {
  return (
    (state.salaries[employeeId] ?? [])
      .filter((row) => row.valid_from <= date && (!row.valid_to || row.valid_to >= date))
      .sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0] ?? null
  );
}
function salaryView(state, row) {
  if (!row) return null;
  const structure = state.structures.find((s) => s.id === row.structure_id);
  return { ...clone(row), structure: structure ? { id: structure.id, name: structure.name } : null };
}
function identityView(identity, full = false) {
  return {
    has_pan: !!identity.pan,
    has_aadhaar: !!identity.aadhaar,
    has_bank: !!identity.bank_account && !!identity.bank_ifsc,
    pan: full ? identity.pan : identity.pan ? `••••••${identity.pan.slice(-4)}` : null,
    aadhaar_masked: identity.aadhaar ? `•••• •••• ${identity.aadhaar.slice(-4)}` : null,
    uan: identity.uan,
    esi_number: identity.esi_number,
    bank_account: full ? identity.bank_account : identity.bank_account ? `••••${identity.bank_account.slice(-4)}` : null,
    bank_ifsc: identity.bank_ifsc,
    bank_name: identity.bank_name,
  };
}

export function previewEmployeeView(state, employeeOrId) {
  const employee = typeof employeeOrId === 'object' ? employeeOrId : state.employees.find((e) => e.id === employeeOrId);
  if (!employee) return null;
  const group = previewPayGroupView(state, employee.pay_group_id);
  const salary = salaryView(state, salaryOn(state, employee.id));
  const policies = POLICY_KINDS.map((kind) => {
    const selected = group.policies
      .filter((p) => p.kind === kind && p.valid_from <= state.today && (!p.valid_to || p.valid_to >= state.today))
      .sort((a, b) => b.version - a.version)[0];
    return selected
      ? { ...clone(selected), label: POLICY_KIND_LABELS[kind], missing: null }
      : { kind, id: null, label: POLICY_KIND_LABELS[kind], name: null, rules: null, missing: POLICY_KIND_MISSING_WARNING[kind] };
  });
  return {
    ...clone(employee),
    department: clone(state.departments.find((d) => d.id === employee.department_id)),
    pay_group: { id: group.id, name: group.name, calendar_method: group.calendar_method, weekly_off: clone(group.weekly_off) },
    salary,
    identity: identityView(employee.identity),
    has_bank: !!employee.identity.bank_account,
    has_uan: !!employee.identity.uan,
    pt_state: employee.statutory.pt_state,
    tax_regime: employee.statutory.tax_regime_code,
    pf_enabled: employee.statutory.pf_enabled,
    face: { enrolled: false, needs_registration: false, templates: 0 },
    onboarding: { required_left: 0, items: [], done: 0, total: 0 },
    rules: {
      pay_group: { id: group.id, name: group.name },
      calendar_method: group.calendar_method,
      weekly_off: clone(group.weekly_off),
      shift: group.shift,
      structure: salary?.structure ?? null,
      policies,
    },
  };
}

function calculateSalary(state, employee, input) {
  const structure = state.structures.find((s) => s.id === input.structure_id);
  if (!structure) throw new Error('Choose an available salary structure.');
  return previewSalary(
    { ...state, today: input.date ?? state.today },
    {
      ...input,
      components: structure.components,
      statutory: employee?.statutory ?? {},
      gender: employee?.gender ?? input.gender ?? 'MALE',
      pf_enabled: input.pf_enabled,
      esi_enabled: input.esi_enabled,
      chosen_gross: input.chosen_gross,
    },
  ).breakup;
}
function normalizeSalaryPeriods(rows) {
  rows.sort((a, b) => a.valid_from.localeCompare(b.valid_from));
  rows.forEach((row, index) => {
    row.valid_to = rows[index + 1] ? addDays(rows[index + 1].valid_from, -1) : null;
  });
  return rows;
}
function paidMonths(state, employeeId) {
  return state.paidPayroll.filter((period) => period.employee_id === employeeId && ['LOCKED', 'PAID'].includes(period.state));
}
function salaryProtection(state, employeeId, row) {
  return paidMonths(state, employeeId).find((period) =>
    period.salary_id === row.id || (row.valid_from <= monthDates(period.period_ym).at(-1) && (!row.valid_to || row.valid_to >= `${period.period_ym}-01`)),
  );
}
function protectionReason(period) {
  const month = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${period.period_ym}-01T12:00:00Z`));
  return `Used in ${period.state.toLowerCase()} payroll for ${month}.`;
}
const salarySignature = (row) => row ? JSON.stringify([row.id, row.mode, row.amount, row.monthly_gross, row.structure_id]) : null;
function payrollAffected(state, employeeId, proposedRows) {
  // Compare each effective agreement in the frozen month, rather than rejecting an innocent later revision.
  return paidMonths(state, employeeId).find((period) => monthDates(period.period_ym).some((date) => {
    const current = salaryOn(state, employeeId, date);
    const proposed = proposedRows.find((row) => row.valid_from <= date && (!row.valid_to || row.valid_to >= date));
    return salarySignature(current) !== salarySignature(proposed);
  }));
}
function historyView(state, employeeId) {
  const rows = state.salaries[employeeId] ?? [];
  const latest = rows.slice().sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0];
  return rows
    .map((row) => {
      const protectedPeriod = salaryProtection(state, employeeId, row);
      return {
        ...salaryView(state, row),
        can_edit: !protectedPeriod,
        can_delete: rows.length > 1 && !protectedPeriod,
        protection_reason: protectedPeriod ? protectionReason(protectedPeriod) : null,
        deletion_reason: rows.length === 1 ? 'Keep at least one salary revision.' : protectedPeriod ? protectionReason(protectedPeriod) : null,
        next_revision_month: protectedPeriod && row.id === latest?.id
          ? addMonths([row.valid_from.slice(0, 7), ...paidMonths(state, employeeId).map((period) => period.period_ym)].sort().at(-1), 1)
          : null,
      };
    })
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from));
}

export function previewTodayPeople(state, date = state.today) {
  const isToday = date === state.today;
  const epoch = Math.floor(Date.parse(`${date}T12:00:00Z`) / 86_400_000);
  const off = new Date(`${date}T12:00:00Z`).getUTCDay() === 0;
  return state.employees.filter((employee) => employee.status === 'ACTIVE').map((employee, index) => {
    const sample = state.attendance_samples[employee.id] ?? { site_id: state.sites[0]?.id, ot_min: 0, late_min: 0, early_min: 0, open_now: false, status: 'ABSENT' };
    const status = isToday ? sample.status : off ? 'WEEKLY_OFF' : (epoch + index * 3) % 7 === 0 ? 'ABSENT' : (epoch + index * 5) % 19 === 0 ? 'ON_LEAVE' : 'PRESENT';
    const present = status === 'PRESENT';
    const ot_min = present ? isToday ? sample.ot_min : (epoch + index) % 4 === 0 ? 60 : 0 : 0;
    const late_min = present ? isToday ? sample.late_min : (epoch + index) % 6 === 0 ? 20 : 0 : 0;
    const early_min = present && isToday ? sample.early_min : 0;
    const open_now = isToday && present && sample.open_now;
    return {
      id: employee.id, name: employee.name, code: employee.code, dept_id: employee.department_id,
      sites: present ? isToday && sample.visited_sites ? clone(sample.visited_sites) : [sample.site_id].filter(Boolean) : [],
      current_site_id: open_now ? sample.site_id : null,
      ot_min, late_min, early_min, expected: status !== 'ON_LEAVE' && status !== 'WEEKLY_OFF', open_now,
      in_min: present ? 540 + late_min : null, out_min: present && !open_now ? 1080 + ot_min - early_min : null,
      status,
      views: present ? ['in', ...(open_now ? ['onsite'] : []), ...(ot_min ? ['ot'] : []), ...(late_min ? ['late'] : []), ...(early_min ? ['early'] : [])]
        : status === 'ON_LEAVE' ? ['leave'] : status === 'ABSENT' ? ['absent'] : [],
    };
  });
}
function overviewView(state, date) {
  const people = previewTodayPeople(state, date);
  if (date === state.today) state.todayStaff = people;
  return {
    date, today: state.today, is_today: date === state.today, sites: state.sites, departments: state.departments, people,
    waiting_total: 3,
    waiting: [
      { key: 'leave', n: 2, label: 'Leave requests', names: ['Meera Example', 'Dev Sample'], to: '/approvals' },
      { key: 'punch', n: 1, label: 'Punch correction', names: ['Ravi Sample'], to: '/approvals' },
    ],
    oldest: { name: 'Meera Example', hours: 3, label: 'Leave request' }, moves: [],
  };
}
function monthView(state, ym) {
  return {
    ym, days: monthDates(ym).map((date) => {
      const people = previewTodayPeople(state, date);
      const present = people.filter((person) => person.views.includes('in')).length;
      const expected = people.filter((person) => person.expected).length;
      const future = date > state.today;
      return {
        date, future, off: new Date(`${date}T12:00:00Z`).getUTCDay() === 0,
        present, expected, rate: future || !expected ? null : Math.round(present / expected * 100),
        sites: Object.fromEntries(state.sites.map((site) => [site.id, people.filter((person) => person.views.includes('in') && person.sites.includes(site.id)).length])),
      };
    }),
  };
}
function attendanceDayView(state, employee, date) {
  const person = previewTodayPeople(state, date).find((row) => row.id === employee.id);
  const group = previewPayGroupView(state, employee.pay_group_id);
  const attendance = group.policies.find((policy) => policy.kind === 'ATTENDANCE')?.rules;
  const overtime = group.policies.find((policy) => policy.kind === 'OVERTIME')?.rules ?? null;
  const protectedPeriod = paidMonths(state, employee.id).find((period) => period.period_ym === date.slice(0, 7));
  const context = {
    kind: new Date(`${date}T12:00:00Z`).getUTCDay() === 0 ? 'WEEKLY_OFF' : 'WORKING',
    shift_start_min: group.shift?.start_min ?? 540, shift_end_min: group.shift?.end_min ?? 1080,
    standard_min: attendance?.standard_min ?? 540, grace_min: attendance?.grace_min ?? 15, ot: overtime,
  };
  const worked_min = person?.views.includes('in') ? 540 + person.ot_min - person.early_min : 0;
  const computed = { status: person?.status ?? 'ABSENT', worked_min, ot_min: person?.ot_min ?? 0, late_min: person?.late_min ?? 0, early_min: person?.early_min ?? 0, flags: [] };
  const site = state.sites.find((row) => row.id === state.attendance_samples[employee.id]?.site_id);
  const punchAt = (minute) => new Date(Date.parse(`${date}T00:00:00+05:30`) + minute * 60_000).toISOString();
  const punches = site && person && person.in_min !== null ? [['IN', person.in_min], ...(person.out_min === null ? [] : [['OUT', person.out_min]])].map(([direction, minute]) => ({
    id: `${employee.id}-${date}-${direction}`, direction, punched_at: punchAt(minute), site, method: 'MANUAL', match_score: null, flagged: false, flag_reason: null,
  })) : [];
  return {
    date, employee: { id: employee.id, code: employee.code, name: employee.name, department: state.departments.find((department) => department.id === employee.department_id) },
    context, computed, override: null, punches, in_min: person?.in_min ?? null, out_min: person?.out_min ?? null,
    frozen: { frozen: !!protectedPeriod, reason: protectedPeriod ? protectionReason(protectedPeriod) : null },
    not_in_employment: date < employee.joined_on,
  };
}
function employeeAttendanceView(state, employee, ym) {
  return {
    month: ym, today: state.today, sites: state.sites,
    days: monthDates(ym).map((date) => {
      const day = attendanceDayView(state, employee, date);
      return {
        date, ...day.computed, kind: day.context.kind,
        in_min: day.in_min, out_min: day.out_min, first_punch_min: day.in_min,
        last_punch_min: day.out_min ?? (day.in_min === null ? null : day.in_min + day.computed.worked_min),
        day_value: ['PRESENT', 'ON_LEAVE', 'WEEKLY_OFF'].includes(day.computed.status) ? 1 : 0,
        sites: previewTodayPeople(state, date).find((person) => person.id === employee.id)?.sites ?? [],
        overridden: false, frozen: day.frozen.frozen,
      };
    }),
    leave: { year: { start: '2026-01', end: '2026-12' }, types: [] },
  };
}
function taxView(state, employee) {
  const salary = salaryOn(state, employee.id);
  if (!salary) return null;
  const calculation = calculateSalary(state, employee, { ...salary, chosen_gross: salary.monthly_gross });
  const structure = calculation.structure;
  const taxable =
    structure.monthly.filter((row) => row.is_taxable).reduce((sum, row) => sum + row.amount, 0) * 12 +
    structure.yearly.filter((row) => row.is_taxable).reduce((sum, row) => sum + row.amount, 0);
  const comparison = compareRegimes({ gross: taxable, basic: structure.basic * 12, hra: structure.hra * 12 }, employee.statutory, state.regimes);
  return { current: employee.statutory.tax_regime_code, comparison, regimes: clone(state.regimes) };
}
function filteredEmployees(state, params) {
  let rows = state.employees;
  const query = (params.get('q') ?? '').trim().toLowerCase();
  if (query) rows = rows.filter((row) => [row.name, row.code, row.designation, row.phone].some((value) => String(value).toLowerCase().includes(query)));
  for (const [key, field] of [
    ['pay_group', 'pay_group_id'],
    ['dept', 'department_id'],
    ['status', 'status'],
  ]) {
    const values = (params.get(`filter[${key}]`) ?? '').split(',').filter(Boolean);
    if (values.length) rows = rows.filter((row) => values.includes(row[field]));
  }
  return rows.map((employee) => previewEmployeeView(state, employee));
}

/** In-memory API response; the caller installs the fetch override. Never contacts a server. */
export async function handlePayrollPreviewApi(state, request) {
  const method = (request.method ?? 'GET').toUpperCase();
  const path = request.path.replace(/^\/api\/v1/, '');
  const body = request.body ?? {};
  const params = request.searchParams ?? new URLSearchParams();
  try {
    if (path === '/auth/me' && method === 'GET')
      return ok({
        id: uuid(900),
        name: 'Preview HR',
        role: 'HR Admin',
        email: 'preview@example.test',
        permissions: [
          'people.read',
          'people.write',
          'salary.read',
          'salary.write',
          'pii.read',
          'setup.read',
          'setup.write',
          'payroll.read',
          'payroll.write',
          'attendance.read',
          'attendance.write',
        ],
      });
    if (path === '/auth/logout' && method === 'POST') return ok({ ok: true });
    if (path === '/dashboard/people' && method === 'GET') return ok({ approvals: { total: 3 } });
    if (path === '/dashboard/overview' && method === 'GET') return ok(overviewView(state, params.get('date') ?? state.today));
    if (path === '/dashboard/month' && method === 'GET') return ok(monthView(state, params.get('ym') ?? state.today.slice(0, 7)));
    if (path === '/attendance/day' && method === 'GET') {
      const employee = state.employees.find((row) => row.id === params.get('employee_id'));
      return employee ? ok(attendanceDayView(state, employee, params.get('date') ?? state.today)) : notFound();
    }
    const payslipMatch = /^\/payroll\/periods\/(\d{4}-\d{2})\/payslips\/([^/]+)$/.exec(path);
    if (payslipMatch && method === 'GET') {
      const period = state.paidPayroll.find((row) => row.period_ym === payslipMatch[1] && row.employee_id === payslipMatch[2]);
      return period ? ok({ ...period, employee: previewEmployeeView(state, period.employee_id), period: { ym: period.period_ym, state: period.state }, meta: { salary: clone(period.salary_snapshot) } })
        : fail('That sample payslip was not found.', 404, null, 'NOT_FOUND');
    }
    if (path === '/lookups' && method === 'GET')
      return ok({
        today: state.today,
        departments: state.departments,
        pay_groups: state.groups.map((group) => ({ id: group.id, name: group.name, calendar_method: group.calendar_method, weekly_off: group.weekly_off })),
        structures: state.structures.map((structure) => ({ id: structure.id, name: structure.name })),
        shifts: state.shifts,
        sites: state.sites,
        projects: [],
        pt_states: [...new Set(state.pt_slabs.map((row) => row.state))],
        states: [...new Set(state.pt_slabs.map((row) => row.state))],
      });
    if (path === '/employees' && method === 'GET') {
      const rows = filteredEmployees(state, params);
      return ok(rows, 200, { total: rows.length, nextCursor: null, has_more: false });
    }
    if (path === '/search' && method === 'GET') return ok(filteredEmployees(state, params));
    if (path === '/advances-loans' && method === 'GET') return ok({ rows: [], carries: [], total: 0 });
    if (path === '/leave' && method === 'GET') return ok([]);
    if (path === '/employees/salary-preview' && method === 'POST') {
      if (!['GROSS', 'CTC'].includes(body.mode) || !Number.isInteger(body.amount) || body.amount <= 0)
        return fail('Enter a positive salary amount.', 422, 'amount');
      if (!body.structure_id) return fail('Choose a salary structure for this employee.', 422, 'structure_id');
      const employee = state.employees.find((row) => row.id === body.employee_id);
      return ok(calculateSalary(state, employee, body));
    }
    const employeeMatch = /^\/employees\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (employeeMatch) {
      const employee = state.employees.find((row) => row.id === employeeMatch[1]);
      if (!employee) return notFound();
      const resource = employeeMatch[2] ?? '';
      if (!resource && method === 'GET') return ok(previewEmployeeView(state, employee));
      if (!resource && method === 'PATCH') {
        const data = employeeUpdateSchema.parse(body);
        if (data.updated_at !== employee.updated_at) return fail('The sample employee changed. Reopen the form and try again.', 409, null, 'STALE_UPDATE');
        if (data.pay_group_id && !state.groups.some((group) => group.id === data.pay_group_id))
          return fail('Choose an available pay group.', 422, 'pay_group_id');
        if (data.department_id && !state.departments.some((department) => department.id === data.department_id))
          return fail('Choose an available department.', 422, 'department_id');
        const { identity, updated_at: _updatedAt, ...core } = data;
        const changes = Object.fromEntries(
          Object.entries(core)
            .filter(([key, value]) => employee[key] !== value)
            .map(([key, value]) => [key, { from: employee[key] ?? null, to: value }]),
        );
        const previousGroup = employee.pay_group_id;
        const previousDesignation = employee.designation;
        Object.assign(employee, core);
        if (identity) Object.assign(employee.identity, identity);
        employee.updated_at = nextTime(state);
        if (core.designation !== undefined && core.designation !== previousDesignation)
          appendPreviewTimeline(state, employee.id, 'employee.designation_change', {
            from: previousDesignation,
            to: core.designation,
            effective_on: state.today,
          });
        if (core.pay_group_id && core.pay_group_id !== previousGroup)
          appendPreviewTimeline(state, employee.id, 'employee.pay_group_change', { from: previousGroup, to: core.pay_group_id });
        const { designation: _designation, pay_group_id: _group, ...otherChanges } = changes;
        if (Object.keys(otherChanges).length) appendPreviewTimeline(state, employee.id, 'employee.update', { changes: otherChanges });
        return ok(previewEmployeeView(state, employee));
      }
      if (resource === 'identity' && method === 'GET') return ok(identityView(employee.identity, true));
      if (resource === 'timeline' && method === 'GET') return ok(state.timeline[employee.id] ?? []);
      if (resource === 'pay' && method === 'GET') {
        const salary = salaryOn(state, employee.id);
        return ok({
          salary: salaryView(state, salary),
          preview: salary ? calculateSalary(state, employee, { ...salary, chosen_gross: salary.monthly_gross }) : null,
          rates: { pf: state.rates.pf, esi: state.rates.esi },
        });
      }
      if (resource === 'tax' && method === 'GET') return ok(taxView(state, employee));
      if (resource === 'salary' && method === 'GET') return ok(historyView(state, employee.id));
      const salaryMatch = /^salary(?:\/([^/]+))?$/.exec(resource);
      if (salaryMatch && ['POST', 'PATCH', 'DELETE'].includes(method)) {
        const rows = state.salaries[employee.id];
        const salaryId = salaryMatch[1];
        const existing = salaryId ? rows.find((row) => row.id === salaryId) : null;
        if ((method === 'PATCH' || method === 'DELETE') && !existing) return fail('That salary revision was not found.', 404, null, 'NOT_FOUND');
        const protectedPeriod = existing ? salaryProtection(state, employee.id, existing) : null;
        if (protectedPeriod) return fail(`${protectionReason(protectedPeriod)} Start a new salary revision after that month.`, 409, null, 'SALARY_PROTECTED');
        if (method === 'DELETE') {
          if (rows.length <= 1) return fail('Keep at least one salary revision.', 409, null, 'SALARY_LAST_REVISION');
          const originalStart = rows.map((row) => row.valid_from).sort()[0];
          const proposed = clone(rows.filter((row) => row.id !== existing.id));
          const first = proposed.sort((a, b) => a.valid_from.localeCompare(b.valid_from))[0];
          if (existing.valid_from === originalStart) first.valid_from = originalStart;
          normalizeSalaryPeriods(proposed);
          const affected = payrollAffected(state, employee.id, proposed);
          if (affected) return fail(`${protectionReason(affected)} This deletion would change that month.`, 409, null, 'SALARY_PROTECTED');
          state.salaries[employee.id] = proposed;
          appendPreviewTimeline(state, employee.id, 'salary.delete', { old: existing, neighbors: state.salaries[employee.id] });
          return ok({ id: existing.id, deleted: true });
        }
        const data = salaryRevisionSchema.parse(body);
        if (data.valid_from < employee.joined_on) return fail('The salary cannot start before the joining date.', 422, 'valid_from');
        if (rows.some((row) => row.id !== existing?.id && row.valid_from === data.valid_from))
          return fail('A salary revision already starts on that date.', 409, 'valid_from', 'SALARY_OVERLAP');
        if (method === 'POST' && rows.some((row) => row.valid_from > data.valid_from))
          return fail('A later revision already exists. Edit the relevant revision or choose a later date.', 409, 'valid_from', 'SALARY_OVERLAP');
        const calculation = calculateSalary(state, employee, { ...data, date: data.valid_from });
        if (calculation.solution?.ambiguous && ![calculation.solution.gross, calculation.solution.alternative.gross].includes(data.chosen_gross))
          return fail('This CTC has two valid monthly grosses. Choose one.', 409, 'amount', 'CTC_AMBIGUOUS');
        if (calculation.solution?.approximate) return fail('Adjust the amount to find a matching CTC.', 422, 'amount');
        const row = {
          ...(existing ?? {}),
          ...data,
          id: existing?.id ?? newId(state),
          employee_id: employee.id,
          monthly_gross: calculation.gross,
          created_by: 'Preview HR',
          created_at: existing?.created_at ?? nextTime(state),
        };
        const previous = existing ? clone(existing) : null;
        const proposed = normalizeSalaryPeriods(existing ? rows.map((item) => item.id === existing.id ? clone(row) : clone(item)) : [...clone(rows), clone(row)]);
        const affected = payrollAffected(state, employee.id, proposed);
        if (affected) return fail(`${protectionReason(affected)} Choose a new revision after that month.`, 409, 'valid_from', 'SALARY_PROTECTED');
        state.salaries[employee.id] = proposed;
        appendPreviewTimeline(state, employee.id, existing ? 'salary.edit' : 'salary.revise', { old: previous, new: row, reason: row.reason });
        return ok({ id: row.id, monthly_gross: row.monthly_gross }, existing ? 200 : 201);
      }
      if (resource === 'statutory' && method === 'PATCH') {
        const data = statutoryUpdateSchema.parse(body);
        const salary = salaryOn(state, employee.id);
        if (data.esi_enabled === true && !employee.statutory.esi_enabled && salary?.monthly_gross > state.rates.esi.ceiling)
          return fail('The salary is above the ESI ceiling.', 422, 'esi_enabled');
        const changes = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, { from: employee.statutory[key], to: value }]));
        Object.assign(employee.statutory, data);
        if (data.pt_applicable === true) employee.statutory.pt_exempt_reason = null;
        appendPreviewTimeline(state, employee.id, 'statutory.update', { changes });
        return ok({ ok: true });
      }
      if (resource === 'attendance' && method === 'GET') return ok(employeeAttendanceView(state, employee, params.get('month') ?? state.today.slice(0, 7)));
      if (resource === 'leave-balances' && method === 'GET') return ok({ year: { start: '2026-01', end: '2026-12' }, types: [] });
      if (resource === 'payslips' && method === 'GET') return ok(state.paidPayroll.filter((period) => period.employee_id === employee.id).map((period) => ({ id: period.id, period_ym: period.period_ym, state: period.state, paid_days: period.paid_days, net: period.net })));
      if (resource === 'letters' && method === 'GET') return ok([]);
      if (resource === 'exit' && method === 'GET') return ok({ status: employee.status, checklist: [], settlement: null, locked: null });
      if (resource === 'hold' && method === 'GET') return ok(state.holds[employee.id]);
      if (resource === 'hold' && method === 'POST') {
        if (!isYearMonth(body.from_ym) || String(body.reason ?? '').trim().length < 3) return fail('Choose a month and enter the hold reason.');
        if (state.holds[employee.id].current) return fail('This salary is already on hold.', 409);
        state.holds[employee.id].current = { id: newId(state), from_ym: body.from_ym, reason: body.reason.trim(), created_by: 'Preview HR', months: [] };
        appendPreviewTimeline(state, employee.id, 'salary.hold', { from_ym: body.from_ym, reason: body.reason.trim() });
        return ok(state.holds[employee.id].current, 201);
      }
      if (resource === 'hold/stop' && method === 'POST') {
        const hold = state.holds[employee.id].current;
        if (hold) {
          state.holds[employee.id].history.unshift(hold);
          state.holds[employee.id].current = null;
        }
        appendPreviewTimeline(state, employee.id, 'salary.hold_stop', {});
        return ok({ ok: true });
      }
      return null;
    }
    return await handlePreviewSetupApi(state, { ...request, method, path, body, searchParams: params });
  } catch (error) {
    return fail(error.issues?.[0]?.message ?? error.message ?? 'Check the sample values.', 422, error.issues?.[0]?.path?.join('.') ?? null);
  }
}
