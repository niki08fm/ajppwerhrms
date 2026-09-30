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
  // Face v2: the Python face service on this machine (face/service). See face/INTEGRATION.md.
  FACE_SERVICE_URL: z.string().url('FACE_SERVICE_URL is required — the face service address, e.g. http://127.0.0.1:8100'),
  FACE_SERVICE_TOKEN: z.string().min(24, 'FACE_SERVICE_TOKEN must be at least 24 characters, and the same value the face service uses'),
  FACE_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(8000),
  FACE_MATCH_MIN: z.coerce.number().min(0).max(1).default(0.4),
  FACE_MATCH_MARGIN: z.coerce.number().min(0).max(1).default(0.05),
  FACE_LIVE_MIN: z.coerce.number().min(0).max(1).default(0.7),
  FACE_TURN_MIN_DEG: z.coerce.number().min(0).max(60).default(15),
  FACE_SAME_PERSON_MIN: z.coerce.number().min(0).max(1).default(0.3),
  FACE_DUPLICATE_MIN: z.coerce.number().min(0).max(1).default(0.5),
  FACE_LEARN_MIN: z.coerce.number().min(0).max(1).default(0.55),
  FACE_ROLLING_MAX: z.coerce.number().int().min(0).max(20).default(5),
  FACE_MAX_TRIES: z.coerce.number().int().min(1).max(20).default(5),
  FACE_CHALLENGE_SECONDS: z.coerce.number().int().min(10).default(60),
  FACE_CONFIRM_SECONDS: z.coerce.number().int().min(10).default(60),
  FACE_TRAVEL_MAX_MIN: z.coerce.number().int().min(0).max(1440).default(180),
  GPS_MAX_ACCURACY_M: z.coerce.number().default(50),
  // Place search on the site form goes through our proxy to Nominatim (OpenStreetMap).
  NOMINATIM_URL: z.string().url().default('https://nominatim.openstreetmap.org'),
  NOMINATIM_USER_AGENT: z.string().min(3).default('AJPWER-Workforce/1.0'),
  NOMINATIM_EMAIL: z
    .string()
    .optional()
    .transform((v) => v || undefined),
  CLOCK_SKEW_FLAG_MIN: z.coerce.number().default(5),
  UPLOAD_DIR: z.string().default('./uploads'),
  EXPORT_DIR: z.string().default('./exports'),
  RETENTION_GATE_SNAPSHOT_DAYS: z.coerce.number().default(30),
  RETENTION_PUNCH_DAYS: z.coerce.number().default(1095),
  RETENTION_PAYROLL_YEARS: z.coerce.number().default(7),
  RETENTION_PUNCH_ATTEMPT_DAYS: z.coerce.number().default(365),
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
