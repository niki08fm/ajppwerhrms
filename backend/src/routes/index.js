import { Router } from 'express';
import { attachAdmin, attachSite } from '../middleware/auth.js';
import { AppError } from '../utils/errors.js';
import { authRouter } from './auth.routes.js';
import { tabletRouter } from './tablet.routes.js';
import { employeesRouter } from './employee.routes.js';
import { offersRouter } from './offer.routes.js';
import { attendanceRouter } from './attendance.routes.js';
import { leaveRouter } from './leave.routes.js';
import { setupRouter } from './setup.routes.js';
import { sitesRouter } from './site.routes.js';
import { geoRouter } from './geo.routes.js';
import { payrollRouter } from './payroll.routes.js';
import { moneyRouter } from './money.routes.js';
import { auditRouter } from './audit.routes.js';
import { dashboardRouter } from './dashboard.routes.js';
import { miscRouter } from './misc.routes.js';

/** Every API route, mounted under /api/v1 by app.js. */
export const apiRouter = Router();

// Resolve who is signed in (HR admin or site tablet) before any route runs.
apiRouter.use(attachAdmin, attachSite);

apiRouter.use('/auth', authRouter);
apiRouter.use('/', tabletRouter);
apiRouter.use('/employees', employeesRouter);
apiRouter.use('/offers', offersRouter);
apiRouter.use('/', attendanceRouter);
apiRouter.use('/leave', leaveRouter);
apiRouter.use('/', setupRouter);
apiRouter.use('/', sitesRouter);
apiRouter.use('/geo', geoRouter);
apiRouter.use('/', payrollRouter);
apiRouter.use('/', moneyRouter);
apiRouter.use('/audit', auditRouter);
apiRouter.use('/', dashboardRouter);
apiRouter.use('/', miscRouter);

apiRouter.use((_req, _res, next) => next(new AppError('NOT_FOUND', 'No such endpoint.', 404)));
