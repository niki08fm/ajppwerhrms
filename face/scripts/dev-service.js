/**
 * `npm run dev` starts the face service too when FACE_SERVICE_DEV=1 in the root
 * .env: python -m app.server from face/service (its .venv if there is one), with
 * the root .env's FACE_SERVICE_TOKEN. Otherwise it does nothing.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const envFile = path.join(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

if (process.env.FACE_SERVICE_DEV !== '1') {
  console.log('[face] FACE_SERVICE_DEV is not 1: not starting the face service (see docs/OPERATIONS.md).');
  process.exit(0);
}

const serviceDir = path.resolve(here, '../service');
const venvPython = path.join(serviceDir, '.venv/bin/python');
const python = existsSync(venvPython) ? venvPython : 'python3';
const child = spawn(python, ['-m', 'app.server'], { cwd: serviceDir, stdio: 'inherit', env: process.env });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
