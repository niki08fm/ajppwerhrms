import { expect, test } from '@playwright/test';

const GROUP_A = '00000000-0000-4000-8000-000000000001';
const GROUP_B = '00000000-0000-4000-8000-000000000002';
const STRUCTURE_A = '00000000-0000-4000-8000-000000000003';
const STRUCTURE_B = '00000000-0000-4000-8000-000000000004';
const DEPARTMENT = '00000000-0000-4000-8000-000000000005';
const CREATED_EMPLOYEE = '00000000-0000-4000-8000-000000000006';
const CTC = 26_400_000;
const HIGH_GROSS = 2_120_000;
const LOW_GROSS = 2_050_000;
const THRESHOLD_CTC = 27_531_600;
const THRESHOLD_GROSS = 2_100_000;
const THRESHOLD_PLAIN_GROSS = 2_164_400;

/** Fixed API figures exercise the form contract; engine tests cover the CTC calculation. */
function previewFor(body) {
  const ambiguous = body.mode === 'CTC' && body.esi_enabled !== false;
  const offset = body.amount === CTC ? 0 : 100;
  const upper = HIGH_GROSS + offset;
  const lower = LOW_GROSS + offset;
  const gross = body.mode === 'CTC' ? body.chosen_gross ?? (ambiguous ? lower : upper) : body.amount;
  const within = gross <= 2_100_000;
  const esiOn = body.esi_enabled && within;
  const pf = body.pf_enabled ? 120_000 : 0;
  const esi = esiOn ? 15_000 : 0;
  return {
    gross, esi_within_ceiling: within, esi_eligible_gross: body.mode === 'CTC' ? lower : within ? gross : null, take_home: gross - pf - esi,
    solution: ambiguous ? { ambiguous: true, gross: lower, breakdown: { esi_applies: true }, alternative: { gross: upper, breakdown: { esi_applies: false } }, approximate: false } : null,
    structure: { monthly: [{ name: 'Basic', amount: Math.round(gross / 2), colour: 'chart-1' }, { name: 'DA', amount: 0, colour: 'chart-2' }, { name: 'Special Allowance', amount: gross - Math.round(gross / 2), colour: 'chart-3' }], yearly: [], over_budget: false },
    ctc: { annual_ctc: ambiguous ? body.amount : gross * 12, monthly_cost: gross + pf + esi, employer_pf: pf, employer_esi: esi },
    pf: { employee: pf, employer_total: pf, eps: 0, employer_epf: pf, pf_wage: gross / 2, vpf: 0 },
    esi: { applicable: esiOn, employee: esi, employer: esi },
    pt: { amount: 0, state: 'Andhra Pradesh' }, pt_february: { amount: 0 },
    annual_tax: 0, tds_monthly: 0, employee_statutory: pf + esi,
  };
}

// This actual ceiling example uses Basic50%, PF12%, employerESI3.25% and
// employeeESI0.75%, with statutory contributions rounded to whole rupees.
function thresholdPreview(body) {
  const ctc = body.mode === 'CTC';
  const ambiguous = ctc && body.esi_enabled;
  const gross = ctc ? body.chosen_gross ?? (body.esi_enabled ? THRESHOLD_GROSS : THRESHOLD_PLAIN_GROSS) : body.amount;
  const within = gross <= THRESHOLD_GROSS;
  const esiOn = body.esi_enabled && within;
  const pf = body.pf_enabled ? Math.round((gross / 2) * 0.12 / 100) * 100 : 0;
  const employerEsi = esiOn ? Math.ceil(gross * 0.0325 / 100) * 100 : 0;
  const employeeEsi = esiOn ? Math.ceil(gross * 0.0075 / 100) * 100 : 0;
  const monthlyCost = gross + pf + employerEsi;
  return {
    ...previewFor({ ...body, mode: 'GROSS', amount: gross }),
    gross, take_home: gross - pf - employeeEsi, employee_statutory: pf + employeeEsi,
    esi_within_ceiling: within, esi_eligible_gross: ctc ? THRESHOLD_GROSS : within ? gross : null,
    solution: ctc ? {
      gross: body.esi_enabled ? THRESHOLD_GROSS : THRESHOLD_PLAIN_GROSS,
      breakdown: { esi_applies: !!body.esi_enabled }, ambiguous,
      alternative: ambiguous ? { gross: THRESHOLD_PLAIN_GROSS, breakdown: { esi_applies: false } } : null,
      approximate: false,
    } : null,
    ctc: { annual_ctc: monthlyCost * 12, monthly_cost: monthlyCost, employer_pf: pf, employer_esi: employerEsi },
    pf: { employee: pf, employer_total: pf, eps: 0, employer_epf: pf, pf_wage: gross / 2, vpf: 0 },
    esi: { applicable: esiOn, employee: employeeEsi, employer: employerEsi },
  };
}

async function mockSalaryEntry(page, { threshold = false } = {}) {
  const previews = [];
  const writes = [];
  const waiting = [];
  const controls = {
    previews, writes, waiting, holdAmount: null,
    release() { this.holdAmount = null; waiting.splice(0).forEach((resolve) => resolve()); },
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    let result;
    if (path === '/employees/salary-preview') {
      const body = request.postDataJSON();
      previews.push(body);
      if (body.amount === controls.holdAmount) await new Promise((resolve) => waiting.push(resolve));
      result = { data: threshold ? thresholdPreview(body) : previewFor(body) };
    } else if ((path === '/employees' || path === '/offers') && request.method() === 'POST') {
      writes.push({ path, body: request.postDataJSON() });
      result = { data: { id: CREATED_EMPLOYEE, employee_id: CREATED_EMPLOYEE, code: 'TEST001', ref: 'TEST/OFFER/001' } };
    } else if (path === '/auth/me') {
      result = { data: { name: 'HR Admin', role: 'HR Admin', permissions: ['people.read', 'people.write', 'setup.read', 'offers.read', 'offers.write'] } };
    } else if (path === '/lookups') {
      result = { data: { today: '2026-10-07', departments: [{ id: DEPARTMENT, name: 'Engineering' }], pay_groups: [{ id: GROUP_A, name: 'Site calendar' }, { id: GROUP_B, name: 'Office calendar' }], structures: [{ id: STRUCTURE_A, name: 'Salary A' }, { id: STRUCTURE_B, name: 'Salary B' }], pt_states: ['Andhra Pradesh'], shifts: [] } };
    } else if (path === '/dashboard/people') {
      result = { data: { approvals: { total: 0 } } };
    } else if (path === '/employees') {
      result = { data: [], meta: { total: 0, nextCursor: null } };
    } else if (path === `/employees/${CREATED_EMPLOYEE}`) {
      // This fixture verifies creation payloads; employee detail screens have their own tests.
      await route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Employee profile is outside this form fixture.' } } });
      return;
    } else result = { data: [] };
    await route.fulfill({ status: request.method() === 'POST' && path !== '/employees/salary-preview' ? 201 : 200, json: result });
  });
  return controls;
}

async function openForm(page, kind) {
  await page.goto(kind === 'existing' ? '/people' : '/offers');
  await page.getByRole('button', { name: kind === 'existing' ? 'Add existing employee' : 'Issue an offer', exact: true }).first().click();
  return page.getByRole('dialog');
}

async function fillIdentity(dialog, kind, { phone = true, designation = true } = {}) {
  await dialog.getByRole('textbox', { name: kind === 'existing' ? /^Full name/ : /^Name/ }).fill('Test employee');
  if (phone) await dialog.getByRole('textbox', { name: /^Phone/ }).fill('9999999999');
  if (designation) await dialog.getByRole('textbox', { name: /^Designation/ }).fill('Engineer');
  await dialog.getByRole('combobox', { name: /^Department/ }).selectOption(DEPARTMENT);
  await dialog.getByRole('combobox', { name: /^Pay group/ }).selectOption(GROUP_A);
  await dialog.getByRole('combobox', { name: /^Salary structure/ }).selectOption(STRUCTURE_B);
  if (kind === 'existing') await dialog.getByLabel(/^Joined on/).fill('2026-10-07');
  else {
    await dialog.getByLabel('Joining date', { exact: true }).fill('2026-11-06');
    await dialog.getByLabel('Offer valid till', { exact: true }).fill('2026-10-21');
  }
}

function saveButton(dialog, kind) {
  return dialog.getByRole('button', { name: kind === 'existing' ? 'Add employee' : 'Issue offer and print letter', exact: true });
}

for (const kind of ['existing', 'offer']) {
  test(`${kind} entry saves its independently chosen structure and the lower CTC option with ESI`, async ({ page }) => {
    const fixture = await mockSalaryEntry(page);
    const dialog = await openForm(page, kind);
    await fillIdentity(dialog, kind);
    await dialog.getByRole('radio', { name: 'CTC', exact: true }).click();
    await dialog.getByRole('textbox', { name: /^Annual CTC/ }).fill('264000');
    const save = saveButton(dialog, kind);
    await expect(dialog.getByText('This CTC has two valid monthly grosses.', { exact: true })).toBeVisible();
    await expect(save).toBeDisabled();
    await dialog.getByRole('radio', { name: /a month with ESI$/ }).check();
    await expect(save).toBeEnabled();
    await expect(dialog.getByRole('switch', { name: 'ESI', exact: true })).toBeChecked();
    await expect(dialog.getByRole('switch', { name: 'ESI', exact: true })).toBeEnabled();
    // Pay-group choice supplies attendance rules; it must not replace the salary structure or gross choice.
    await dialog.getByRole('combobox', { name: /^Pay group/ }).selectOption(GROUP_B);
    await expect(dialog.getByRole('combobox', { name: /^Salary structure/ })).toHaveValue(STRUCTURE_B);
    await expect(dialog.getByRole('radio', { name: /a month with ESI$/ })).toBeChecked();
    const matching = fixture.previews.filter((body) => body.chosen_gross === LOW_GROSS).at(-1);
    expect(matching).toMatchObject({ mode: 'CTC', amount: CTC, structure_id: STRUCTURE_B, chosen_gross: LOW_GROSS, esi_enabled: true });
    expect(matching).not.toHaveProperty('pay_group_id');
    await save.click();
    await expect.poll(() => fixture.writes.length).toBe(1);
    const body = fixture.writes[0].body;
    expect(body).toMatchObject({ pay_group_id: GROUP_B, esi_enabled: true, pf_enabled: true });
    expect(kind === 'existing' ? body.salary : body).toMatchObject({ mode: 'CTC', amount: CTC, structure_id: STRUCTURE_B, chosen_gross: LOW_GROSS });
  });
}

test('changing salary blocks immediate save through debounce and fetch and uses the new ESI eligibility', async ({ page }) => {
  const fixture = await mockSalaryEntry(page);
  const dialog = await openForm(page, 'existing');
  await fillIdentity(dialog, 'existing');
  const annual = dialog.getByRole('textbox', { name: /^Annual gross/ });
  const save = saveButton(dialog, 'existing');
  await annual.fill('360000'); // ₹30,000 monthly: ESI above the ceiling.
  await expect(save).toBeEnabled();
  await expect(dialog.getByRole('switch', { name: 'ESI', exact: true })).toBeDisabled();
  fixture.holdAmount = 2_000_000;
  await annual.fill('240000'); // ₹20,000 monthly: ESI becomes eligible again.
  await expect(save).toBeDisabled();
  await expect.poll(() => fixture.waiting.length).toBeGreaterThan(0);
  await expect(save).toBeDisabled();
  expect(fixture.writes).toHaveLength(0);
  fixture.release();
  await expect(save).toBeEnabled();
  await expect(dialog.getByRole('switch', { name: 'ESI', exact: true })).toBeChecked();
  await save.click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  expect(fixture.writes[0].body).toMatchObject({ esi_enabled: true, salary: { mode: 'GROSS', amount: 2_000_000, structure_id: STRUCTURE_B } });
});

test('existing employee creation remains blocked until required phone and designation are entered', async ({ page }) => {
  await mockSalaryEntry(page);
  const dialog = await openForm(page, 'existing');
  await fillIdentity(dialog, 'existing', { phone: false, designation: false });
  await dialog.getByRole('textbox', { name: /^Annual gross/ }).fill('240000');
  const save = saveButton(dialog, 'existing');
  await expect(dialog.getByText('Monthly gross', { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  await dialog.getByRole('textbox', { name: /^Phone/ }).fill('9999999999');
  await expect(save).toBeDisabled();
  await dialog.getByRole('textbox', { name: /^Designation/ }).fill('Engineer');
  await expect(save).toBeEnabled();
});

test('changing an offer amount clears its previous ambiguous gross choice', async ({ page }) => {
  const fixture = await mockSalaryEntry(page);
  const dialog = await openForm(page, 'offer');
  await fillIdentity(dialog, 'offer');
  await dialog.getByRole('radio', { name: 'CTC', exact: true }).click();
  const annual = dialog.getByRole('textbox', { name: /^Annual CTC/ });
  await annual.fill('264000');
  await dialog.getByRole('radio', { name: /a month with ESI$/ }).check();
  const save = saveButton(dialog, 'offer');
  await expect(save).toBeEnabled();
  await annual.fill('264012');
  await expect(save).toBeDisabled();
  await expect(dialog.getByRole('radio', { name: /a month with ESI$/ })).not.toBeChecked();
  await expect(save).toBeDisabled();
  expect(fixture.previews.at(-1)).not.toHaveProperty('chosen_gross');
  await dialog.getByRole('radio', { name: /a month with ESI$/ }).check();
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  expect(fixture.writes[0].body).toMatchObject({ amount: CTC + 1200, chosen_gross: LOW_GROSS + 100, esi_enabled: true });
});

test('the ₹21,000 gross ceiling stays ESI eligible when converted to CTC and ESI can be turned back on', async ({ page }) => {
  const fixture = await mockSalaryEntry(page, { threshold: true });
  const dialog = await openForm(page, 'existing');
  await fillIdentity(dialog, 'existing');
  await dialog.getByRole('textbox', { name: /^Annual gross/ }).fill('252000');
  const save = saveButton(dialog, 'existing');
  await expect(save).toBeEnabled();
  const employerPf = dialog.getByRole('row').filter({ has: page.getByRole('cell', { name: /^PF — company share/ }) });
  const employerEsi = dialog.getByRole('row').filter({ has: page.getByRole('cell', { name: /^ESI — company share/ }) });
  const cost = dialog.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Cost to company (CTC)', exact: true }) });
  await expect(employerPf.getByRole('cell').nth(1)).toHaveText('₹1,260');
  await expect(employerEsi.getByRole('cell').nth(1)).toHaveText('₹683');
  await expect(cost.getByRole('cell').nth(2)).toHaveText('₹2,75,316');

  await dialog.getByRole('radio', { name: 'CTC', exact: true }).click();
  await dialog.getByRole('textbox', { name: /^Annual CTC/ }).fill('275316');
  await expect(dialog.getByText('This CTC has two valid monthly grosses.', { exact: true })).toBeVisible();
  const withEsi = dialog.getByRole('radio', { name: /a month with ESI$/ });
  const withoutEsi = dialog.getByRole('radio', { name: /a month without ESI$/ });
  await expect(withEsi).toHaveAccessibleName(/₹21,000 a month with ESI$/);
  await expect(withoutEsi).toHaveAccessibleName(/₹21,644 a month without ESI$/);
  const choices = await dialog.getByRole('radio', { name: /a month (with|without) ESI$/ }).all();
  await expect(choices[0]).toHaveAccessibleName(/with ESI$/);
  await expect(save).toBeDisabled();
  await expect(dialog.getByText('Monthly gross', { exact: true }).locator('..')).toContainText('₹21,000');
  const esiSwitch = dialog.getByRole('switch', { name: 'ESI', exact: true });
  await expect(esiSwitch).toBeEnabled();
  await expect(esiSwitch).toBeChecked();

  await withEsi.check();
  await expect(save).toBeEnabled();
  await esiSwitch.click();
  await expect(esiSwitch).not.toBeChecked();
  await expect(dialog.getByText('Monthly gross', { exact: true }).locator('..')).toContainText('₹21,644');
  await expect(dialog.getByRole('radio', { name: /a month (with|without) ESI$/ })).toHaveCount(0);
  await expect(esiSwitch).toBeEnabled(); // Eligibility metadata survives the currently disabled ESI flag.
  await esiSwitch.click();
  await expect(esiSwitch).toBeChecked();
  await expect(withEsi).toBeVisible();
  await expect(withEsi).not.toBeChecked();
  await expect(save).toBeDisabled();
  await expect(dialog.getByText('Monthly gross', { exact: true }).locator('..')).toContainText('₹21,000');
  await withEsi.check();
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  expect(fixture.writes[0].body).toMatchObject({
    pf_enabled: true, esi_enabled: true,
    salary: { mode: 'CTC', amount: THRESHOLD_CTC, chosen_gross: THRESHOLD_GROSS, structure_id: STRUCTURE_B },
  });
});

test('the same CTC can explicitly choose the higher gross without saving ESI as enabled', async ({ page }) => {
  const fixture = await mockSalaryEntry(page, { threshold: true });
  const dialog = await openForm(page, 'offer');
  await fillIdentity(dialog, 'offer');
  await dialog.getByRole('radio', { name: 'CTC', exact: true }).click();
  await dialog.getByRole('textbox', { name: /^Annual CTC/ }).fill('275316');
  const save = saveButton(dialog, 'offer');
  await expect(save).toBeDisabled();
  await expect(dialog.getByRole('radio', { name: /a month with ESI$/ })).toBeVisible();
  await expect(dialog.getByText('Monthly gross', { exact: true }).locator('..')).toContainText('₹21,000');
  await dialog.screenshot({ path: '/tmp/esi-first-ctc-offer.png' });
  await dialog.getByRole('radio', { name: /a month without ESI$/ }).check();
  await expect(save).toBeEnabled();
  await expect(dialog.getByText('Monthly gross', { exact: true }).locator('..')).toContainText('₹21,644');
  const employerEsi = dialog.getByRole('row').filter({ has: page.getByRole('cell', { name: /^ESI — company share/ }) });
  await expect(employerEsi.getByRole('cell').nth(1)).toHaveText('—');
  await save.click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  expect(fixture.writes[0].body).toMatchObject({
    mode: 'CTC', amount: THRESHOLD_CTC, chosen_gross: THRESHOLD_PLAIN_GROSS,
    structure_id: STRUCTURE_B, pf_enabled: true, esi_enabled: false,
  });
});

test('changing mode or structure clears a previous CTC choice and requires a fresh explicit selection', async ({ page }) => {
  const fixture = await mockSalaryEntry(page);
  const dialog = await openForm(page, 'existing');
  await fillIdentity(dialog, 'existing');
  await dialog.getByRole('radio', { name: 'CTC', exact: true }).click();
  await dialog.getByRole('textbox', { name: /^Annual CTC/ }).fill('264000');
  const withEsi = dialog.getByRole('radio', { name: /a month with ESI$/ });
  const save = saveButton(dialog, 'existing');
  await withEsi.check();
  await expect(save).toBeEnabled();
  await dialog.getByRole('combobox', { name: /^Salary structure/ }).selectOption(STRUCTURE_A);
  await expect(withEsi).not.toBeChecked();
  await expect(save).toBeDisabled();
  await expect.poll(() => fixture.previews.at(-1)?.structure_id).toBe(STRUCTURE_A);
  expect(fixture.previews.at(-1)).not.toHaveProperty('chosen_gross');
  await withEsi.check();
  await expect(save).toBeEnabled();
  await dialog.getByRole('radio', { name: 'Gross', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: /^Annual gross/ })).toHaveValue('264000');
  await expect(save).toBeEnabled();
  await dialog.getByRole('radio', { name: 'CTC', exact: true }).click();
  await expect(withEsi).toBeVisible();
  await expect(withEsi).not.toBeChecked();
  await expect(save).toBeDisabled();
  await expect(dialog.getByRole('radio', { name: 'CTC', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(fixture.writes).toHaveLength(0);
});
