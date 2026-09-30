import path from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { attachAdmin, attachSite } from './lib/auth';
import { env } from './lib/env';
import { AppError, errorHandler } from './lib/errors';
import { logger } from './lib/logger';
import { authRouter } from './modules/auth';
import { employeesRouter } from './modules/employees';
import { offersRouter } from './modules/offers';
import { attendanceRouter } from './modules/attendance';
import { tabletRouter } from './modules/tablet';
import { leaveRouter } from './modules/leave';
import { setupRouter } from './modules/setup';
import { sitesRouter } from './modules/sites';
import { payrollRouter } from './modules/payroll';
import { moneyRouter } from './modules/money';
import { auditRouter } from './modules/audit';
import { dashboardRouter } from './modules/dashboard';
import { miscRouter } from './modules/misc';
import './jobs/handlers';

export function createApp() {
  const app = express();
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: env.WEB_ORIGIN.split(','), credentials: true }));
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  if (env.NODE_ENV !== 'test') {
    app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/v1/health' } }));
  }

  app.get('/api/v1/health', (_req, res) => res.json({ data: { ok: true, at: new Date().toISOString() } }));

  const v1 = express.Router();
  v1.use(attachAdmin, attachSite);
  v1.use('/auth', authRouter);
  v1.use('/', tabletRouter);
  v1.use('/employees', employeesRouter);
  v1.use('/offers', offersRouter);
  v1.use('/', attendanceRouter);
  v1.use('/leave', leaveRouter);
  v1.use('/', setupRouter);
  v1.use('/', sitesRouter);
  v1.use('/', payrollRouter);
  v1.use('/', moneyRouter);
  v1.use('/audit', auditRouter);
  v1.use('/', dashboardRouter);
  v1.use('/', miscRouter);
  v1.use((_req, _res, next) => next(new AppError('NOT_FOUND', 'No such endpoint.', 404)));
  app.use('/api/v1', v1);

  // Single-container deployment: serve the built web app and fall back to index.html for client routes.
  const webDir = process.env.SERVE_WEB_DIR ? path.resolve(process.env.SERVE_WEB_DIR) : null;
  if (webDir && existsSync(path.join(webDir, 'index.html'))) {
    app.use(express.static(webDir, { index: false, maxAge: '1h', immutable: false }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
