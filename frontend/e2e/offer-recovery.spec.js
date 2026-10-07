import { expect, test } from '@playwright/test';

const EMPLOYEE = '00000000-0000-4000-8000-000000000061';
const OFFER = '00000000-0000-4000-8000-000000000062';
const GROUP = { id: '00000000-0000-4000-8000-000000000063', name: 'Office calendar', calendar_method: 'ACTUAL', weekly_off: ['SUN'] };
const STRUCTURE = { id: '00000000-0000-4000-8000-000000000064', name: 'Employee salary' };
const DEPARTMENT = { id: '00000000-0000-4000-8000-000000000065', name: 'Engineering', colour: 'chart-1' };
const rates = {
  pf: { employee_pct: 12, employer_pct: 12, ceiling: 1_500_000, eps_pct: 8.33, eps_wage_ceiling: 1_500_000 },
  esi: { employee_pct: 0.75, employer_pct: 3.25, ceiling: 2_100_000 },
};

function salaryPreview(gross = 3_000_000) {
  return {
    gross, take_home: gross, tds_monthly: 0, annual_tax: 0, employee_statutory: 0,
    structure: { monthly: [{ name: 'Basic', amount: gross, calc_type: 'PCT_GROSS', calc_value: 100, colour: 'chart-1' }], yearly: [], over_budget: false },
    pf: { pf_wage: gross, employee: 0, employer_total: 0, employer_epf: 0, eps: 0, vpf: 0 },
    esi: { applicable: false, employee: 0, employer: 0 }, esi_within_ceiling: false,
    pt: { state: 'Andhra Pradesh', amount: 0 }, pt_february: { amount: 0 },
    ctc: { employer_pf: 0, employer_esi: 0, monthly_cost: gross, annual_ctc: gross * 12 }, solution: null,
  };
}

/** All records and mutations are fictional; the running frontend never reaches a database. */
async function mockOffers(page, { existingOffer = false, letterFailure = false } = {}) {
  const state = {
    exists: existingOffer, status: 'OFFER', salary: null, offerPosts: [],
    reads: { employee: 0, pay: 0, history: 0 }, letterReads: 0,
  };
  const employee = () => ({
    id: EMPLOYEE, code: 'AJTEST61', name: 'Example Offered Employee', designation: 'Engineer',
    gender: 'FEMALE', phone: '9000000000', status: state.status, joined_on: '2026-10-01',
    updated_at: '2026-10-07T00:00:00.000Z', read_only: false,
    department: DEPARTMENT, pay_group: GROUP, salary: state.salary,
    identity: {}, face: { enrolled: false }, onboarding: { required_left: 0, total: 0, done: 0, items: [] },
    statutory: { pf_enabled: false, pf_restrict_to_ceiling: true, vpf_pct: 0, esi_enabled: false, pt_applicable: true, pt_state: 'Andhra Pradesh', tax_regime_code: 'NEW', decl_80c: 0, decl_80d: 0, decl_rent_monthly: 0, decl_metro: false },
    rules: { pay_group: GROUP, calendar_method: 'ACTUAL', weekly_off: ['SUN'], shift: { name: 'Office', start_min: 540, end_min: 1080 }, policies: [] },
    offer: { id: OFFER, ref: 'TEST/OFFER/061', mode: 'GROSS', amount: 3_000_000, structure_id: STRUCTURE.id },
  });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const method = request.method();
    let data;
    if (path === '/auth/me') {
      data = { name: 'Test HR', role: 'HR Admin', permissions: ['people.read', 'people.write', 'salary.read', 'salary.write', 'setup.read', 'offers.read', 'offers.write'] };
    } else if (path === '/lookups') {
      data = { today: '2026-10-07', departments: [DEPARTMENT], pay_groups: [GROUP], structures: [STRUCTURE], pt_states: ['Andhra Pradesh'], sites: [], shifts: [] };
    } else if (path === '/dashboard/people') data = { approvals: { total: 0 } };
    else if (path === '/employees/salary-preview') data = salaryPreview(request.postDataJSON().amount);
    else if (path === '/offers' && method === 'POST') {
      state.offerPosts.push(request.postDataJSON());
      state.exists = true;
      data = { employee_id: EMPLOYEE, offer_id: OFFER, code: 'AJTEST61', ref: 'TEST/OFFER/061' };
    } else if (path === '/offers') data = state.exists ? [employee()] : [];
    else if (path === `/offers/${OFFER}/accept` && method === 'POST') {
      state.status = 'ACCEPTED';
      data = { status: state.status };
    } else if (path === `/offers/${OFFER}/onboard` && method === 'POST') {
      state.status = 'ONBOARDING';
      state.salary = { id: 'test-initial-salary', mode: 'GROSS', amount: 3_000_000, monthly_gross: 3_000_000, valid_from: '2026-10-01', valid_to: null, structure_id: STRUCTURE.id, structure: STRUCTURE, reason: 'As offered (TEST/OFFER/061)', can_edit: true, can_delete: false };
      data = { status: state.status };
    } else if (path === `/employees/${EMPLOYEE}`) {
      state.reads.employee++;
      data = employee();
    } else if (path === `/employees/${EMPLOYEE}/pay`) {
      state.reads.pay++;
      data = { salary: state.salary, preview: state.salary ? salaryPreview() : null, rates };
    } else if (path === `/employees/${EMPLOYEE}/salary`) {
      state.reads.history++;
      data = state.salary ? [state.salary] : [];
    } else if (path === `/employees/${EMPLOYEE}/letters`) {
      state.letterReads++;
      if (letterFailure) {
        await route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Test letter lookup unavailable.' } } });
        return;
      }
      data = [];
    } else if (path.endsWith('/hold')) data = { current: null, history: [], open_months: [], run_months: [] };
    else if (path.endsWith('/leave-balances')) data = { types: [] };
    else if (path.endsWith('/attendance')) data = { days: [] };
    else if (path === '/advances-loans') data = { rows: [] };
    else {
      await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: `Unexpected test endpoint: ${path}` } } });
      return;
    }
    await route.fulfill({ status: method === 'POST' && path === '/offers' ? 201 : 200, json: { data } });
  });
  return state;
}

test('a successful offer closes the issue dialog when its letter lookup fails', async ({ page }) => {
  const state = await mockOffers(page, { letterFailure: true });
  await page.goto('/offers');
  await page.getByRole('button', { name: 'Issue an offer', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Issue an offer', exact: true });
  await dialog.getByRole('textbox', { name: /^Name/ }).fill('Example Offered Employee');
  await dialog.getByRole('textbox', { name: /^Phone/ }).fill('9000000000');
  await dialog.getByRole('textbox', { name: /^Designation/ }).fill('Engineer');
  await dialog.getByRole('combobox', { name: /^Department/ }).selectOption(DEPARTMENT.id);
  await dialog.getByRole('combobox', { name: /^Pay group/ }).selectOption(GROUP.id);
  await dialog.getByRole('combobox', { name: /^Salary structure/ }).selectOption(STRUCTURE.id);
  await dialog.getByRole('textbox', { name: /^Annual gross/ }).fill('360000');
  await dialog.getByLabel('Joining date', { exact: true }).fill('2026-10-01');
  await dialog.getByLabel('Offer valid till', { exact: true }).fill('2026-10-21');
  const issue = dialog.getByRole('button', { name: 'Issue offer and print letter', exact: true });
  await expect(issue).toBeEnabled();
  await issue.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/Offer issued, but the letter could not be opened\./)).toBeVisible();
  await expect(page.getByRole('link', { name: /Example Offered Employee/ })).toHaveCount(1);
  // The saved form is gone: printing failure leaves no submit/retry button that can create a duplicate.
  await expect(page.getByRole('button', { name: 'Issue offer and print letter', exact: true })).toHaveCount(0);
  expect(state.letterReads).toBe(1);
  expect(state.offerPosts).toHaveLength(1);
});

test('accepting and onboarding refresh a previously cached profile, pay and salary history', async ({ page }) => {
  const state = await mockOffers(page, { existingOffer: true });
  await page.goto(`/people/${EMPLOYEE}?tab=salary`);
  const salary = page.getByRole('tabpanel', { name: 'Salary and statutory' });
  await expect(salary.getByRole('heading', { name: 'No salary yet', exact: true })).toHaveCount(2);
  await expect.poll(() => state.reads).toEqual({ employee: 1, pay: 1, history: 1 });
  // Use client navigation/back throughout, so these queries stay cached rather than reloading the app.
  await page.evaluate(() => { window.__offerRecoveryNavigationMarker = 'cached-profile'; });
  await page.getByRole('link', { name: 'Hiring and onboarding', exact: true }).click();
  await page.getByRole('button', { name: 'Mark accepted', exact: true }).click();
  await expect(page.getByRole('tab', { name: /^Accepted/ })).toHaveAttribute('data-state', 'active');
  await page.goBack();
  await expect(page.getByText('Accepted', { exact: true })).toBeVisible();
  await expect.poll(() => state.reads).toEqual({ employee: 2, pay: 2, history: 2 });
  await expect(salary.getByRole('heading', { name: 'No salary yet', exact: true })).toHaveCount(2);

  await page.getByRole('link', { name: 'Hiring and onboarding', exact: true }).click();
  await page.getByRole('tab', { name: /^Accepted/ }).click();
  await page.getByRole('button', { name: 'Start onboarding', exact: true }).click();
  await expect(page.getByRole('tab', { name: /^Onboarding/ })).toHaveAttribute('data-state', 'active');
  await page.goBack();
  await expect(page.getByText('Onboarding', { exact: true })).toBeVisible();
  await expect(salary.getByRole('heading', { name: 'Salary breakup · Employee salary', exact: true })).toBeVisible();
  await expect(salary).toContainText('As offered (TEST/OFFER/061)');
  await expect(salary.getByRole('heading', { name: 'No salary yet', exact: true })).toHaveCount(0);
  await expect.poll(() => state.reads).toEqual({ employee: 3, pay: 3, history: 3 });
  await expect(page.getByRole('button', { name: /^Monthly gross/ })).toContainText('30,000');
  expect(await page.evaluate(() => window.__offerRecoveryNavigationMarker)).toBe('cached-profile');
  expect(state.offerPosts).toHaveLength(0);
});
