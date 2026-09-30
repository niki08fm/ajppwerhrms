import { existsSync } from 'node:fs';
import path from 'node:path';

const envFile = path.resolve(__dirname, '../../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
delete process.env.REDIS_URL; // jobs run in-process under test
process.env.JWT_SECRET ??= 'test-secret-test-secret-test-secret';
process.env.SITE_JWT_SECRET ??= 'site-secret-site-secret-site-secret';
process.env.PII_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
