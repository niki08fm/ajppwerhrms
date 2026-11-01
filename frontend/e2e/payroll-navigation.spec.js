import { expect, test } from '@playwright/test';

const YM = '2026-09';
const totals = { headcount: 2, gross: 5_000_000, net: 4_600_000, deductions: 400_000, employer: 300_000, on_hold: 0, on_hold_net: 0, settlements: 0 };

async function mockPayroll(page, { state = 'RUN', submitted = [1, 2, 3, 4, 5, 6], held = false } = {}) {
  const errors = [], requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const period = { period_ym: YM, state, steps_submitted: submitted, step_log: [], run_at: `${YM}-30T12:00:00Z`, run_by: 'Example HR', totals, payment_ref: null };
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url()), path = url.pathname.replace('/api/v1', '');
    requests.push({ path, params: Object.fromEntries(url.searchParams) });
    let data;
    if (path === '/auth/me') data = { name: 'HR Admin', role: 'HR Admin', permissions: ['payroll.read', 'reports.export', 'people.read', 'attendance.read', 'payroll.run', 'payroll.pay'] };
    else if (path === '/lookups') data = { today: '2026-10-30', departments: [], pay_groups: [], sites: [] };
    else if (path === '/dashboard/people') data = { approvals: { total: 0 } };
    else if (path === '/payroll/periods') return route.fulfill({ json: { data: [period], meta: { suggested: YM, current: '2026-10' } } });
    else if (path === `/payroll/periods/${YM}`) data = period;
    else if (/^\/payroll\/periods\/[^/]+\/summary$/.test(path)) data = { all: { ...totals, ...(held ? { on_hold: 1, on_hold_net: 100_000 } : {}) }, AJ: totals, TP: totals, errors: 0 };
    else if (path.endsWith('/payslips.zip')) return route.fulfill({ contentType: 'application/zip', headers: { 'Content-Disposition': `attachment; filename="payslips-${YM}-aj.zip"` }, body: Buffer.from('504b0506000000000000000000000000000000000000', 'hex') });
    else if (path.includes('/report/')) {
      const key = path.split('/').at(-1);
      data = { key, columns: [{ key: 'code', label: 'Code' }, { key: 'name', label: 'Employee' }, { key: 'net', label: 'Net pay', money: true }], rows: [{ code: 'AJ001', name: 'Anita Example', net: totals.net, employee_id: 'example-employee' }], notes: [], extra: {}, totals };
      if (key === 'summary') data = { ...data, rows: [{ step: 'Gross pay', amount: totals.gross }, { step: 'Net pay', amount: totals.net, total: true }], extra: { ...totals, ctc: totals.gross + totals.employer } };
    } else if (path.endsWith('/preview')) data = { ...totals, errors: [], released_held: 0 };
    else if (path.endsWith('/held')) data = { holds: [], released: [], held_back: [], held_now: [], candidates: [], open_months: [] };
    else if (path === '/advances-loans') data = { rows: [] };
    else if (path === '/employees' || path === '/adhoc') return route.fulfill({ json: { data: [] } });
    else data = [];
    await route.fulfill({ json: { data } });
  });
  return { errors, requests };
}

test('generated month opens reports at the real generate stage instead of Adhoc', async ({ page }) => {
  const state = await mockPayroll(page);
  await page.goto(`/payroll/${YM}`);
  await page.getByRole('button', { name: 'Open all reports', exact: true }).click();
  await expect(page).toHaveURL(/step=7/);
  await expect(page.getByRole('heading', { name: 'Payroll reports and payslips', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Payslips', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /One-off items/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to overview', exact: true }).click();
  await expect(page).not.toHaveURL(/step=/);
  expect(state.errors).toEqual([]);
});

test('payslip shortcut preserves company and ZIP matches the searched month report', async ({ page }) => {
  const state = await mockPayroll(page);
  await page.goto(`/payroll/${YM}?company=AJ`);
  await page.getByRole('button', { name: 'View payslips', exact: true }).click();
  await expect(page).toHaveURL(/company=AJ.*step=7.*tab=payslips/);
  await expect(page.getByRole('tab', { name: 'Payslips', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('textbox', { name: 'Filter by name or code' }).fill('Anita');
  await expect.poll(() => state.requests.filter((request) => request.path.endsWith('/report/payslips')).at(-1)?.params.q).toBe('Anita');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download ZIP', exact: true }).click();
  expect((await download).suggestedFilename()).toBe(`payslips-${YM}-aj.zip`);
  expect(state.requests.find((request) => request.path.endsWith('/payslips.zip'))).toEqual({ path: `/payroll/periods/${YM}/payslips.zip`, params: { company: 'AJ', q: 'Anita' } });
  expect(state.errors).toEqual([]);
});

test('overview shows statutory reports by default and can collapse them', async ({ page }) => {
  await mockPayroll(page);
  await page.goto(`/payroll/${YM}`);
  await expect(page.getByText('One per person, printable', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View report', exact: true })).toHaveCount(8);
  await expect(page.getByText('For the ESIC portal', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Fewer reports', exact: true }).click();
  await expect(page.getByText('For the ESIC portal', { exact: true })).toHaveCount(0);
});

test('Adhoc remains the sixth review and generation follows all six reviews', async ({ page }) => {
  const state = await mockPayroll(page, { state: 'DRAFT', submitted: [1, 2, 3, 4, 5] });
  await page.goto(`/payroll/${YM}`);
  await page.getByRole('button', { name: /One-time adjustments.*Ready/ }).click();
  await expect(page.getByRole('heading', { name: 'Step 6 · One-time adjustments', exact: true })).toBeVisible();
  await expect(page.getByText('Add this month’s bonuses, reimbursements and other one-time earnings or deductions.', { exact: true })).toBeVisible();
  expect(state.errors).toEqual([]);
});

test('ready payroll opens Generate as stage seven and never writes on navigation', async ({ page }) => {
  const state = await mockPayroll(page, { state: 'DRAFT' });
  const writes = [];
  page.on('request', (request) => { if (request.method() !== 'GET') writes.push(request.url()); });
  await page.goto(`/payroll/${YM}`);
  await page.getByRole('button', { name: 'Generate payroll', exact: true }).click();
  await expect(page).toHaveURL(/step=7/);
  await expect(page.getByRole('heading', { name: 'Everything is reviewed. Ready to generate September 2026.', exact: true })).toBeVisible();
  await expect(page.getByText('6 of 6 steps done', { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
  expect(state.errors).toEqual([]);
});


test('all twelve reports are directly selectable without scrolling through hidden tabs',async({page})=>{
  const state=await mockPayroll(page);await page.goto(`/payroll/${YM}?company=AJ&step=7`);
  const selector=page.getByRole('combobox',{name:'Choose payroll report'});
  await expect(selector.locator('option')).toHaveCount(12);
  await expect(page.getByRole('tablist',{name:'Common payroll reports'}).getByRole('tab')).toHaveCount(4);
  for(const report of ['pf','esi','pt','tds','settlements','adhoc']){
    await selector.selectOption(report);
    await expect(page).toHaveURL(new RegExp(`company=AJ.*tab=${report}`));
    await expect.poll(()=>state.requests.some(r=>r.path.endsWith(`/report/${report}`)&&r.params.company==='AJ')).toBe(true);
  }
  await expect(selector.locator('option[value="tds"]')).toHaveText('TDS / Income tax');
  await selector.selectOption('summary');
  const details=page.locator('details').filter({has:page.getByText('Calculation details',{exact:true})});
  await expect(details).not.toHaveAttribute('open');await details.locator('summary').click();await expect(details).toHaveAttribute('open','');
});
