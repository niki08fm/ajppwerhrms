import pino from 'pino';

/** Never written to a log: session cookies, passwords (site tablet ones included), identity numbers, face data. */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'password',
  '*.password',
  '*.password_hash',
  'req.body.password',
  '*.pan',
  '*.aadhaar',
  '*.bank_account',
  '*.embedding',
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: {
    paths: REDACT_PATHS,
    censor: '[redacted]',
  },
  transport: process.env.NODE_ENV === 'development' && !process.env.LOG_JSON ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } : undefined,
});
