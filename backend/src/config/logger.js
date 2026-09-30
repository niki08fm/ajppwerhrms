import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.pan', '*.aadhaar', '*.bank_account', '*.embedding'],
    censor: '[redacted]',
  },
  transport: process.env.NODE_ENV === 'development' && !process.env.LOG_JSON ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } : undefined,
});
