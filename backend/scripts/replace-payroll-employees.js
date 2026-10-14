#!/usr/bin/env node
/** Replace local payroll test employees after validation and a verified private backup. Dry-run by default. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { devNull } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readEmployeeReport } from '../src/services/employee-import.service.js';
import { developmentReplacementTarget, planPayrollEmployeeReplacement, payrollReplacementSummary,
  replacePayrollEmployeeData } from '../src/services/payroll-test-data.service.js';

const BACKEND_ROOT = fileURLToPath(new URL('../', import.meta.url));
const REPOSITORY_ROOT = path.dirname(BACKEND_ROOT.replace(/[\\/]$/, ''));
const DEFAULT_PRIVATE_DIR = path.join(BACKEND_ROOT, 'uploads', 'payroll-test-data');

function requirePrivateOutputLocation(target) {
  const relative = path.relative(REPOSITORY_ROOT, target);
  if (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
    && !relative.startsWith(`backend${path.sep}uploads${path.sep}`)
    && !relative.startsWith(`backend${path.sep}exports${path.sep}`)) {
    throw new Error('Backups, mappings and import reports must be outside Git or under ignored backend/uploads or backend/exports.');
  }
}

function runPostgresClient(binary, args, pgEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: { ...process.env, ...pgEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let tooLarge = false;
    child.stdout.on('data', (chunk) => {
      if (output.length + chunk.length > 2_000_000) { tooLarge = true; child.kill(); }
      else output += chunk.toString();
    });
    // PostgreSQL messages may contain connection details. Do not forward them into shared logs.
    child.stderr.on('data', () => undefined);
    child.once('error', (error) => reject(new Error(`${path.basename(binary)} is unavailable (${error.code ?? 'client error'}). Existing data was not changed.`)));
    child.once('close', (code) => {
      if (code !== 0 || tooLarge) reject(new Error(`${path.basename(binary)} failed${Number.isInteger(code) ? ` (exit ${code})` : ''}. Existing data was not changed.`));
      else resolve(output);
    });
  });
}

async function privateDirectory(directory, { privateParent = true } = {}) {
  const target = path.resolve(directory);
  requirePrivateOutputLocation(path.join(target, '.private-output'));
  await mkdir(target, { recursive: true, mode: 0o700 });
  // Reject symlinked directory roots; backups/mappings must be private local files.
  if (await realpath(target) !== target) throw new Error('Choose a backup directory without symlinked path components.');
  if (privateParent && ((await lstat(target)).mode & 0o077) !== 0) {
    throw new Error('Choose a private backup subdirectory with permissions 0700; shared directory permissions were not changed.');
  }
  return target;
}

async function postgresBackup(target, { directory, pgDump, pgRestore }) {
  const privateDir = await privateDirectory(directory);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(privateDir, `payroll-before-replacement-${stamp}-${randomUUID()}.dump`);
  const placeholder = await open(backupPath, 'wx', 0o600);
  await placeholder.close();
  const pgEnv = { PGHOST: target.host, PGPORT: target.port, PGUSER: target.user,
    PGPASSWORD: target.password, PGDATABASE: target.database, PGCONNECT_TIMEOUT: '10' };
  try {
    await runPostgresClient(pgDump, ['--format=custom', '--file', backupPath, '--no-password'], pgEnv);
    await chmod(backupPath, 0o600);
    const contents = await runPostgresClient(pgRestore, ['--list', backupPath], pgEnv);
    const database = /^;\s*dbname:\s*(.+?)\s*$/m.exec(contents)?.[1];
    if (database !== target.database || !contents.includes('TABLE DATA public employee ')
      || !contents.includes('TABLE DATA public statutory_rates ')) {
      throw new Error('The PostgreSQL backup did not verify the expected database and tables. Existing data was not changed.');
    }
    // Read every compressed archive block without restoring data or exposing SQL/PII in logs.
    await runPostgresClient(pgRestore, ['--file', devNull, backupPath], pgEnv);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(backupPath)) hash.update(chunk);
    const receipt = { path: backupPath, database: target.database, sha256: hash.digest('hex'), verified: true };
    await writeFile(`${backupPath}.json`, JSON.stringify({ ...receipt, created_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return receipt;
  } catch (error) {
    await rm(backupPath, { force: true });
    throw error;
  }
}

async function savePrivateJson(file, value) {
  const target = path.resolve(file);
  await privateDirectory(path.dirname(target), { privateParent: false });
  // An existing file must not become a writable alias for another private file.
  await writeFile(target, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return target;
}

async function main() {
  const { values } = parseArgs({ options: {
    file: { type: 'string' },
    'pay-group': { type: 'string', default: 'Head office' },
    structure: { type: 'string', default: 'Employee' },
    'fallback-structure': { type: 'string', default: 'Site staff' },
    'replace-development-data': { type: 'boolean', default: false },
    database: { type: 'string' },
    'backup-dir': { type: 'string', default: DEFAULT_PRIVATE_DIR },
    'pg-dump': { type: 'string', default: process.env.PG_DUMP ?? 'pg_dump' },
    'pg-restore': { type: 'string', default: process.env.PG_RESTORE ?? 'pg_restore' },
    mapping: { type: 'string' },
    report: { type: 'string' },
    help: { type: 'boolean', default: false },
  } });
  if (values.help || !values.file) {
    console.log('Usage: npm run db:replace:payroll-employees -- --file /private/employees.xlsx [--pay-group "Head office"] [--structure Employee]');
    console.log('Dry-run is the default. Apply: --replace-development-data --database EXACT_LOCAL_DATABASE_NAME [--backup-dir PRIVATE_DIRECTORY]. Stop the backend and workers first.');
    console.log('PostgreSQL clients: --pg-dump PATH --pg-restore PATH (or PG_DUMP / PG_RESTORE). Optional private JSON output: --mapping PATH --report PATH.');
    if (!values.help) process.exitCode = 1;
    return;
  }
  // Validate the entire workbook before connecting, backing up, or changing any database record.
  const workbook = await readEmployeeReport(path.resolve(values.file), { ignoreEmployeeNumbers: true });
  const diagnostics = { total_rows: workbook.total_rows, active_rows: workbook.active_rows,
    skipped_rows: workbook.skipped_rows, warnings: workbook.warnings, errors: workbook.errors };
  if (workbook.errors.length || !workbook.records.length) {
    console.log(JSON.stringify(diagnostics, null, 2));
    throw new Error('Employee workbook validation failed. Existing data was not changed.');
  }
  const apply = values['replace-development-data'];
  // The same local/development restrictions also apply to the read-only manifest.
  const url = new URL(process.env.DATABASE_URL ?? '');
  const targetOptions = { databaseUrl: process.env.DATABASE_URL, nodeEnv: process.env.NODE_ENV ?? 'development',
    confirmedDatabase: apply ? values.database : decodeURIComponent(url.pathname.replace(/^\//, '')), replaceDevelopmentData: true };
  const target = developmentReplacementTarget(targetOptions);
  const { PrismaClient } = await import('@prisma/client');
  const db = new PrismaClient();
  try {
    const options = { report: workbook, payGroupName: values['pay-group'], structureName: values.structure,
      fallbackStructureName: values['fallback-structure'] };
    const plan = await planPayrollEmployeeReplacement(db, options);
    console.log(JSON.stringify({ mode: apply ? 'replace' : 'dry-run', database: target.database,
      ...diagnostics, ...payrollReplacementSummary(plan) }, null, 2));
    if (!apply) {
      if (values.report) await savePrivateJson(values.report, { ...diagnostics, ...payrollReplacementSummary(plan) });
      console.log('Dry-run finished. No database changes were made. Salary and attendance are not supplied; payroll will wait for these records.');
      return;
    }
    const backup = await postgresBackup(target, { directory: values['backup-dir'], pgDump: values['pg-dump'], pgRestore: values['pg-restore'] });
    console.log(`Verified private PostgreSQL backup: ${backup.path}`);
    const mappingPath = values.mapping ?? `${backup.path}.employee-codes.json`;
    const createdFiles = [];
    let result;
    try {
      result = await replacePayrollEmployeeData(db, { ...options, targetOptions, backup, plan, beforeCommit: async (preview) => {
        createdFiles.push(await savePrivateJson(mappingPath, { generated_codes: true, employees: preview.code_map }));
        const { code_map: _privateMapping, ...summary } = preview;
        if (values.report) createdFiles.push(await savePrivateJson(values.report, { ...diagnostics, ...summary }));
      } });
    } catch (error) {
      for (const file of createdFiles) await rm(file, { force: true });
      throw error;
    }
    const { code_map: _privateMapping, ...summary } = result;
    console.log(JSON.stringify({ ...summary, mapping_saved: true }, null, 2));
    console.log('Active profiles imported with generated AJ employee codes. No salary or attendance values were invented. Restart the backend before testing.');
  } finally { await db.$disconnect(); }
}

main().catch((error) => {
  const message = error.name?.startsWith('Prisma')
    ? `Database replacement failed${error.code ? ` (${error.code})` : ''}. The replacement transaction was not committed.`
    : error.message;
  console.error(message);
  process.exitCode = 1;
});
