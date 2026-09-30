import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().default(4000),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  COOKIE_SECURE: bool,
  COOKIE_DOMAIN: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  TRUST_PROXY: z.coerce.number().int().default(0),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required — copy .env.example to .env and fill it in'),
  REDIS_URL: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  JWT_SECRET: z.string().min(24, 'JWT_SECRET must be at least 24 characters'),
  SITE_JWT_SECRET: z.string().min(24, 'SITE_JWT_SECRET must be at least 24 characters'),
  ADMIN_SESSION_HOURS: z.coerce.number().default(8),
  SITE_SESSION_HOURS: z.coerce.number().default(24),
  PII_ENCRYPTION_KEY: z.string().refine((k) => {
    try {
      return Buffer.from(k, 'base64').length === 32;
    } catch {
      return false;
    }
  }, 'PII_ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)'),
  FACE_MATCH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.55),
  GPS_MAX_ACCURACY_M: z.coerce.number().default(50),
  // Place search on the site form goes through our proxy to Nominatim (OpenStreetMap).
  NOMINATIM_URL: z.string().url().default('https://nominatim.openstreetmap.org'),
  NOMINATIM_USER_AGENT: z.string().min(3).default('AJPWER-Workforce/1.0'),
  NOMINATIM_EMAIL: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  LATE_SYNC_FLAG_MIN: z.coerce.number().default(60),
  CLOCK_SKEW_FLAG_MIN: z.coerce.number().default(5),
  UPLOAD_DIR: z.string().default('./uploads'),
  EXPORT_DIR: z.string().default('./exports'),
  RETENTION_GATE_SNAPSHOT_DAYS: z.coerce.number().default(30),
  RETENTION_PUNCH_DAYS: z.coerce.number().default(1095),
  RETENTION_PAYROLL_YEARS: z.coerce.number().default(7),
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
    // eslint-disable-next-line no-console
    console.error(`\nInvalid environment configuration:\n${lines}\n\nSee .env.example.\n`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = load();
export const isProd = env.NODE_ENV === 'production';
