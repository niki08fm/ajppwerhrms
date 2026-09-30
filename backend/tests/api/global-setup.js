import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Reset the test database once per run: every migration, no seed. */
export default function setup() {
  const envFile = path.resolve(__dirname, '../../../.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required for API tests (see .env.example)');
  execSync('npx prisma migrate reset --force --skip-seed --skip-generate', {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
