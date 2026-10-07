#!/usr/bin/env node
/** Load active employee profiles into a fresh development database, without pay or attendance. */
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readEmployeeReport } from '../src/services/employee-import.service.js';

async function saveReport(file, report) {
  if (!file) return;
  const target = path.resolve(file);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}

async function main() {
  const { values } = parseArgs({
    options: {
      file: { type: 'string' },
      'pay-group': { type: 'string', default: 'Head office' },
      check: { type: 'boolean', default: false },
      report: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || !values.file) {
    console.log('Usage: npm run db:import:employees -- --file /private/path/employees.xlsx [--pay-group "Head office"] [--check] [--report /private/path/report.json]');
    if (!values.help) process.exitCode = 1;
    return;
  }

  const result = await readEmployeeReport(path.resolve(values.file));
  // Reports identify source row and field, never personal values or encryption keys.
  const report = {
    total_rows: result.total_rows,
    active_rows: result.active_rows,
    skipped_rows: result.skipped_rows,
    ready_rows: result.records.length,
    imported_rows: 0,
    warnings: result.warnings,
    errors: result.errors,
    salary_rows: 0,
    attendance_rows: 0,
  };
  await saveReport(values.report, report);
  console.log(`Workbook checked: ${report.active_rows} active rows; ${report.skipped_rows} other rows skipped; ${report.warnings.length} field warnings; ${report.errors.length} errors.`);
  if (result.errors.length) {
    console.log(JSON.stringify({ errors: result.errors }));
    process.exitCode = 1;
    return;
  }
  if (!result.records.length) throw new Error('No active employees were found. Nothing was imported.');
  if (values.check) {
    console.log('Validation passed. No database changes made. Salary and attendance are not present in this report.');
    return;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('This employee test-data import is for development databases.');

  const { PrismaClient } = await import('@prisma/client');
  const { encryptPII, maskAadhaar } = await import('../src/utils/crypto.js');
  const { toDbDate } = await import('../src/utils/dbDates.js');
  const db = new PrismaClient();
  try {
    const imported = await db.$transaction(async (tx) => {
      // Serialise imports so two invocations cannot both accept an empty target.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ajpwer-employee-report-import'))`;
      if (await tx.employee.count()) throw new Error('The target already contains employees. Use a separate, freshly configured preview database; no existing data was changed.');
      if (!(await tx.company.findFirst())) throw new Error('Company setup is missing. Run db:seed:setup on this preview database first.');
      const group = await tx.payGroup.findFirst({ where: { name: values['pay-group'], deleted_at: null } });
      if (!group) throw new Error('The selected pay group is missing. Run db:seed:setup or configure the group first.');

      const departments = new Map();
      let imported = 0;
      for (const person of result.records) {
        if (!departments.has(person.department)) {
          const department = await tx.department.upsert({
            where: { name: person.department },
            update: {},
            create: { name: person.department, colour: `chart-${departments.size % 5 + 1}` },
          });
          departments.set(person.department, department.id);
        }
        const identity = person.identity;
        await tx.employee.create({
          data: {
            code: person.code,
            name: person.name,
            status: 'ACTIVE',
            joined_on: toDbDate(person.joined_on),
            gender: person.gender,
            phone: person.phone,
            email: person.email,
            address: person.address,
            dob: person.dob ? toDbDate(person.dob) : null,
            designation: person.designation,
            department_id: departments.get(person.department),
            pay_group_id: group.id,
            activated_at: new Date(),
            statutory: {
              create: {
                pf_enabled: person.statutory.pf_enabled,
                esi_enabled: person.statutory.esi_enabled,
                pt_state: person.statutory.pt_state,
              },
            },
            identity: {
              create: {
                pan_enc: encryptPII(identity.pan),
                aadhaar_enc: encryptPII(identity.aadhaar),
                aadhaar_masked: maskAadhaar(identity.aadhaar),
                uan: identity.uan,
                esi_number: identity.esi_number,
                bank_account_enc: encryptPII(identity.bank_account),
                bank_last4: identity.bank_account?.slice(-4) ?? null,
                bank_ifsc: identity.bank_ifsc,
                bank_name: identity.bank_name,
              },
            },
          },
        });
        imported++;
      }
      await tx.auditLog.create({
        data: {
          actor: 'development-employee-import',
          action: 'employee.import',
          entity_type: 'employee',
          detail: { imported_rows: imported, active_only: true, salary_rows: 0, attendance_rows: 0 },
        },
      });
      return imported;
    }, { maxWait: 10_000, timeout: 120_000 });
    report.imported_rows = imported;
    await saveReport(values.report, report);
    console.log(`Imported ${imported} active AJ Power employees. Source employee numbers retained. No salary or attendance data created.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  // Prisma errors can include record values; report only their code.
  const message = error.name?.startsWith('Prisma')
    ? `Database import failed${error.code ? ` (${error.code})` : ''}. The import transaction was not committed.`
    : error.message;
  console.error(message);
  process.exitCode = 1;
});
