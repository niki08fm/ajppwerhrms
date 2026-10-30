import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import JSZip from 'jszip';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../src/config/db.js';
import { invalidatePrincipal } from '../../src/middleware/auth.js';
import { app, buildFixture, runAndWait, submitSteps, YM } from './fixture.js';

let f;
const PERIOD = `/api/v1/payroll/periods/${YM}`;
const employeePath = (id = f.employees.A) => `/api/v1/employees/${id}/payslips.zip`;
const binary = (res, done) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
  res.on('error', done);
};
const files = (zip) => Object.values(zip.files).filter((file) => !file.dir);

async function generate() {
  await submitSteps(f.agent, YM, 6);
  expect((await runAndWait(f.agent, YM)).status).toBe('DONE');
}
async function archive(path, query = {}) {
  const response = await f.agent.get(path).query(query).buffer(true).parse(binary);
  expect(response.status, response.body?.toString()).toBe(200);
  expect(response.headers['content-type']).toMatch(/^application\/zip/);
  expect(response.headers['cache-control']).toBe('no-store');
  return { response, zip: await JSZip.loadAsync(response.body, { checkCRC32: true }) };
}
// Decode the standard-font text operators from PDFKit's compressed content
// streams, so assertions inspect the exported document rather than renderer inputs.
function pdfText(bytes) {
  const chunks = [];
  for (const match of bytes.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let text;
    try { text = inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1'); } catch { continue; }
    chunks.push([...text.matchAll(/<([0-9A-Fa-f]+)>/g)].map((part) => Buffer.from(part[1], 'hex').toString('latin1')).join(''));
  }
  return chunks.join('\n');
}
async function copySnapshot(slip, ym, { meta = slip.meta } = {}) {
  const period = await prisma.payrollPeriod.create({ data: { period_ym: ym, state: 'RUN' } });
  const { id, period_id, period: _period, lines, created_at, updated_at, ...data } = slip;
  return prisma.payslip.create({ data: { ...data, period_id: period.id, meta,
    lines: { create: lines.map(({ id: _id, payslip_id, created_at: _created, updated_at: _updated, ...line }) => line) } } });
}

beforeEach(async () => { f = await buildFixture(); });
afterAll(async () => { await prisma.$disconnect(); });

describe('PDF payslip ZIP downloads', () => {
  it('requires an HR session and both payroll read and export permissions for each download', async () => {
    const paths = [[`${PERIOD}/payslips.zip`, {}], [employeePath(), { year: '2026' }]];
    for (const [path, query] of paths) expect((await request(app).get(path).query(query)).status).toBe(401);
    const user = await prisma.appUser.findFirst({ where: { email: 'hr@test.in' }, include: { role: true } });
    for (const permission of ['reports.export', 'payroll.read']) {
      await prisma.role.update({ where: { id: user.role_id }, data: { permissions: user.role.permissions.filter((item) => item !== permission) } });
      invalidatePrincipal(user.id);
      for (const [path, query] of paths) expect((await f.agent.get(path).query(query)).status).toBe(403);
    }
  });

  it('validates the year, employee, month, company and search before generating files', async () => {
    for (const year of [undefined, '26', '2026-08', '1800', ['2026', '2025']]) {
      expect((await f.agent.get(employeePath()).query(year === undefined ? {} : { year })).status).toBe(422);
    }
    expect((await f.agent.get(employeePath('not-an-id')).query({ year: '2026' })).status).toBe(422);
    for (const query of [{ company: 'OTHER' }, { q: 'x'.repeat(201) }]) {
      expect((await f.agent.get(`${PERIOD}/payslips.zip`).query(query)).status).toBe(422);
    }
    expect((await f.agent.get('/api/v1/payroll/periods/2026-13/payslips.zip')).status).toBe(422);
  });

  it('explains missing employees, missing months and selections with no generated payslips', async () => {
    expect((await f.agent.get(employeePath(randomUUID())).query({ year: '2026' })).status).toBe(404);
    expect((await f.agent.get('/api/v1/payroll/periods/2025-08/payslips.zip')).status).toBe(404);
    const noYear = await f.agent.get(employeePath()).query({ year: '2026' });
    expect(noYear.status).toBe(404);
    expect(noYear.body.error.code).toBe('NO_PAYSLIPS');
    await f.agent.get(PERIOD); // A draft month exists, but it has no snapshot yet.
    const noMonth = await f.agent.get(`${PERIOD}/payslips.zip`);
    expect(noMonth.status).toBe(404);
    expect(noMonth.body.error.message).toMatch(/Generate payroll first/);
  });

  it('downloads real PDF files for every employee in the selected month and audits the export', async () => {
    await generate();
    const { response, zip } = await archive(`${PERIOD}/payslips.zip`);
    expect(response.headers['content-disposition']).toContain(`payslips-${YM}.zip`);
    expect(response.headers['x-payslip-count']).toBe('3');
    const documents = files(zip);
    expect(documents).toHaveLength(3);
    expect(documents.map((file) => file.name.split('/').at(-1)).sort()).toEqual([`T001-${YM}.pdf`, `T002-${YM}.pdf`, `T003-${YM}.pdf`]);
    for (const file of documents) {
      const pdf = await file.async('nodebuffer');
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.toString('latin1')).toContain('%%EOF');
      expect(pdf.toString('latin1')).toMatch(/\/Type\s*\/Page\b/);
      const text = pdfText(pdf);
      expect(text).toContain('PROVISIONAL');
      expect(text).toContain('NET PAY');
      expect(text).toContain('EMPLOYER CONTRIBUTIONS');
      expect(text).toContain('XXXXXX8901');
      expect(text).not.toContain('12345678901');
      expect(text).not.toContain('ABCDE1234F');
    }
    const audit = await prisma.auditLog.findFirst({ where: { action: 'export.payslips' }, orderBy: { at: 'desc' } });
    expect(audit.detail).toMatchObject({ ym: YM, rows: 3, format: 'pdf.zip' });
  });

  it('limits employee ZIP to that employee and calendar year, preserving frozen salary and masked identity', async () => {
    await generate();
    const snapshot = await prisma.payslip.findFirst({ where: { employee_id: f.employees.A }, include: { lines: true } });
    await copySnapshot(snapshot, '2025-08');
    await copySnapshot(snapshot, '2026-07');
    await prisma.employee.update({ where: { id: f.employees.A }, data: { name: 'Changed live name' } });
    const salary = await prisma.employeeSalary.findFirst({ where: { employee_id: f.employees.A } });
    await prisma.employeeSalary.update({ where: { id: salary.id }, data: { monthly_gross: 9999900n, amount: 9999900n } });
    const { response, zip } = await archive(employeePath(), { year: '2026' });
    expect(response.headers['content-disposition']).toContain('payslips-T001-2026.zip');
    expect(files(zip).map((file) => file.name.split('/').at(-1)).sort()).toEqual(['T001-2026-07.pdf', 'T001-2026-08.pdf']);
    const pdf = await files(zip)[0].async('nodebuffer');
    const text = pdfText(pdf);
    expect(text).toContain('Person A');
    expect(text).not.toContain('Changed live name');
    expect(text).not.toContain('Person B');
    const expectedNet = (Number(snapshot.net) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(text).toContain(expectedNet);
    const oldYear = await archive(employeePath(), { year: '2025' });
    expect(files(oldYear.zip)).toHaveLength(1);
    expect(files(oldYear.zip)[0].name).toContain('2025-08.pdf');
    expect(await prisma.payslip.count()).toBe(5); // Export has not created/rerun payroll.
  });

  it('matches company and name/code filters against snapshot data and keeps archive paths safe', async () => {
    await generate();
    const b = await prisma.payslip.findFirst({ where: { employee_id: f.employees.B } });
    await prisma.payslip.update({ where: { id: b.id }, data: { meta: { ...b.meta, employee: { ...b.meta.employee, code: 'TP002' } } } });
    const a = await prisma.payslip.findFirst({ where: { employee_id: f.employees.A } });
    await prisma.payslip.update({ where: { id: a.id }, data: { meta: { ...a.meta, employee: { ...a.meta.employee, code: '../../T001' } } } });
    const c = await prisma.payslip.findFirst({ where: { employee_id: f.employees.C } });
    await prisma.payslip.update({ where: { id: c.id }, data: { meta: { ...c.meta, employee: { ...c.meta.employee, code: 'T001' } } } });
    const colliding = await archive(`${PERIOD}/payslips.zip`);
    expect(files(colliding.zip)).toHaveLength(3);
    expect(new Set(files(colliding.zip).map((file) => file.name.split('/')[0])).size).toBe(3);
    const techpi = await archive(`${PERIOD}/payslips.zip`, { company: 'TP' });
    expect(files(techpi.zip)).toHaveLength(1);
    expect(files(techpi.zip)[0].name).toContain('TP002');
    const aj = await archive(`${PERIOD}/payslips.zip`, { company: 'AJ', q: 'person a' });
    expect(files(aj.zip)).toHaveLength(1);
    expect(files(aj.zip)[0].name).not.toContain('..');
    expect(files(aj.zip)[0].name.split('/')).toHaveLength(2);
    const code = await archive(`${PERIOD}/payslips.zip`, { q: 'tp002' });
    expect(files(code.zip)).toHaveLength(1);
    expect((await f.agent.get(`${PERIOD}/payslips.zip`).query({ company: 'TP', q: 'Person A' })).body.error.code).toBe('NO_PAYSLIPS');
  });

  it('labels locked payslips final, includes held salary notes and never changes the payroll snapshot', async () => {
    await generate();
    const a = await prisma.payslip.findFirst({ where: { employee_id: f.employees.A } });
    await prisma.payslip.update({ where: { id: a.id }, data: { meta: { ...a.meta, held: true } } });
    expect((await f.agent.post(`${PERIOD}/lock`)).status).toBe(200);
    const before = await prisma.payslip.findUnique({ where: { id: a.id }, include: { lines: true } });
    const { zip } = await archive(employeePath(), { year: '2026' });
    const text = pdfText(await files(zip)[0].async('nodebuffer'));
    expect(text).not.toContain('PROVISIONAL');
    expect(text).toContain('Salary on hold');
    expect(await prisma.payslip.findUnique({ where: { id: a.id }, include: { lines: true } })).toEqual(before);
  });
});
