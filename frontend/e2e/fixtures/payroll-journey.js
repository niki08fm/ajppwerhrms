export const YM = '2026-09';
export const PEOPLE = ['Anil Example', 'Bhavana Example', 'Charan Example', 'Divya Example', 'Farhan Example', 'Geetha Example', 'Hari Example', 'Indira Example'].map((name, i) => ({ id: `example-${i + 1}`, code: `AJ${String(i + 1).padStart(4, '0')}`, name, department: i < 5 ? 'Site operations' : 'Administration' }));
export const TOTALS = { headcount: 8, gross: 28460000, net: 25289000, deductions: 3171000, employer: 1874000, on_hold: 0, on_hold_net: 0, settlements: 0 };

export async function mockPayrollJourney(page, { stage = 0, generated = false, state: status, blocking = false, readOnly = false, failRun = false, failTransition = false, delayTransition = false, reportFailure = false, jobFailure = false } = {}) {
  const state = { writes: [], reads: [], errors: [], unexpected: [], reportReads: [], release: null, failRun, failTransition,
    period: { period_ym: YM, state: status ?? (generated ? 'RUN' : 'DRAFT'), steps_submitted: Array.from({ length: stage }, (_, i) => i + 1), step_log: [], totals: TOTALS, run_at: `${YM}-30T12:00:00Z`, run_by: 'Example HR', payment_ref: status === 'PAID' ? 'EXAMPLE-NEFT-001' : null } };
  await page.addInitScript(() => localStorage.setItem('theme', 'light'));
  page.on('pageerror', (error) => state.errors.push(error.message));
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api/v1', ''), method = request.method();
    if (method === 'GET') state.reads.push(path);
    if (method !== 'GET') state.writes.push({ path, body: request.postData() ? request.postDataJSON() : null });
    let data = [], meta;
    const fail = (message) => route.fulfill({ status: 409, json: { error: { code: 'CONFLICT', message } } });
    if (path === '/auth/me') data = { name: 'Example HR', role: 'HR Manager', permissions: ['people.read', 'attendance.read', 'payroll.read', 'reports.export', ...(readOnly ? [] : ['payroll.run', 'payroll.pay'])] };
    else if (path === '/dashboard/people') data = { approvals: { total: 0 } };
    else if (path === '/lookups') data = { today: '2026-10-03', sites: [], departments: [], pay_groups: [], components: [], leave_types: [] };
    else if (path === '/employees') data = PEOPLE;
    else if (path === '/payroll/periods') { data = [state.period]; meta = { suggested: YM, current: '2026-10' }; }
    else if (path === `/payroll/periods/${YM}`) data = state.period;
    else if (/^\/payroll\/periods\/[^/]+\/summary$/.test(path)) data = { all: TOTALS, AJ: TOTALS, TP: { ...TOTALS, headcount: 0, gross: 0, net: 0 }, errors: blocking ? 1 : 0 };
    else if (path.endsWith('/attendance')) data = { shortlist: [], rows: PEOPLE.map((employee, i) => ({ employee, in_run: true, partial: i === 7, present: 24, half_day: 0, absent: i === 3 ? 1 : 0, leave_days: i === 3 ? 1 : 0, off_days: 4, off_days_worked: 0, ot_min: i < 4 ? 180 : 0, paid_days: i === 7 ? 18 : 30, lop_days: 0 })) };
    else if (path.endsWith('/joiners')) data = { joiners: [{ employee: PEOPLE[7], joined_on: '2026-09-13', days_in_month: 18, excluded: false }], leavers: [], leaving_later: [], pipeline: [] };
    else if (path.endsWith('/issues')) data = { issues: blocking ? [{ employee_id: PEOPLE[2].id, name: PEOPLE[2].name, code: PEOPLE[2].code, kind: 'BANK', severity: 'BLOCKING', fix_tab: 'bank', message: 'Bank account details are missing. Add them before paying this salary.' }] : [], kinds: blocking ? [{ kind: 'BANK', label: 'Bank details', count: 1, severity: 'BLOCKING' }] : [], held_back: [] };
    else if (path === '/held-salaries') data = { holds: [], released: [] };
    else if (path.endsWith('/fnf')) data = { rows: [], closed: false };
    else if (path === '/adhoc') data = [{ id: 'example-adjustment', name: 'Project completion bonus', kind: 'EARNING', target_type: 'PEOPLE', target_ids: [PEOPLE[0].id, PEOPLE[1].id, PEOPLE[2].id], amount: 300000, total: 900000, people: 3, created_by: 'Example HR', created_at: '2026-09-29T10:00:00Z' }];
    else if (path === '/advances-loans') data = { rows: [], carries: [], totals: { outstanding: 0, active: 0 } };
    else if (path.endsWith('/preview')) data = { ...TOTALS, released_held: 0, held_back: 0, errors: [] };
    else if (/\/steps\/\d+\/submit$/.test(path)) {
      const step = Number(path.split('/').at(-2));
      if (blocking && step === 3) return fail('Add the missing bank details before confirming employee checks.');
      state.period = { ...state.period, steps_submitted: [...new Set([...state.period.steps_submitted, step])].sort() };
      data = state.period;
    } else if (path.endsWith('/run')) {
      if (state.failRun) return fail('The statutory rates changed. Refresh the preview before generating payroll.');
      data = { job_id: 'example-payroll-job' };
    } else if (path === '/jobs/example-payroll-job') {
      if (jobFailure) data = { status: 'FAILED', error: 'Employee salary data changed. Review the month before generating again.' };
      else { state.period = { ...state.period, state: 'RUN' }; data = { status: 'DONE', progress: 8, total: 8 }; }
    } else if (['lock', 'unlock', 'mark-paid', 'unmark-paid'].some((action) => path.endsWith(`/${action}`))) {
      if (delayTransition) await new Promise((resolve) => { state.release = resolve; });
      if (state.failTransition) return fail('A payroll update is still running. Your payment reference has been kept. Try again when it finishes.');
      state.period = { ...state.period, state: path.endsWith('/mark-paid') ? 'PAID' : path.endsWith('/unlock') ? 'RUN' : 'LOCKED', payment_ref: request.postDataJSON()?.payment_ref ?? null };
      data = state.period;
    } else if (path.includes('/report/')) {
      const key = path.split('/').at(-1); state.reportReads.push(key);
      if (reportFailure) return route.fulfill({ status: 503, json: { error: { message: 'This report is temporarily unavailable.' } } });
      data = { key, notes: [], extra: {}, totals: TOTALS, columns: [{ key: 'code', label: 'Employee ID' }, { key: 'name', label: 'Employee' }, { key: 'gross', label: 'Gross pay', money: true }, { key: 'deductions', label: 'Deductions', money: true }, { key: 'net', label: 'Net pay', money: true }], rows: PEOPLE.map((person) => ({ ...person, employee_id: person.id, gross: 3557500, deductions: 396375, net: 3161125 })) };
      if (key === 'summary') data = { ...data, extra: { ...TOTALS, ctc: TOTALS.gross + TOTALS.employer }, rows: [{ step: 'Gross pay', amount: TOTALS.gross }, { step: 'Employee deductions', amount: -TOTALS.deductions }, { step: 'Net pay', amount: TOTALS.net, total: true }] };
    } else if (method !== 'GET') state.unexpected.push(path);
    await route.fulfill({ json: { data, ...(meta ? { meta } : {}) } });
  });
  return state;
}
