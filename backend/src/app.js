import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { apiRouter } from './routes/index.js';
import './jobs/handlers.js';

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

  // Face detection and recognition model files (the face/ folder), for the tablet and enrolment
  // screens: served from our own host, never an outside CDN. A missing file is a plain 404.
  const faceModels = process.env.FACE_MODELS_DIR ? path.resolve(process.env.FACE_MODELS_DIR) : fileURLToPath(new URL('../../face/models', import.meta.url));
  if (existsSync(faceModels)) {
    app.use('/face-models', express.static(faceModels, { index: false, maxAge: '30d', immutable: true }));
    app.use('/face-models', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such face model file.' } }));
  }

  app.use('/api/v1', apiRouter);

  // Production: one process serves the built frontend too, falling back to index.html for client routes.
  const webDir = process.env.SERVE_WEB_DIR ? path.resolve(process.env.SERVE_WEB_DIR) : null;
  if (webDir && existsSync(path.join(webDir, 'index.html'))) {
    app.use(express.static(webDir, { index: false, maxAge: '1h', immutable: false }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
