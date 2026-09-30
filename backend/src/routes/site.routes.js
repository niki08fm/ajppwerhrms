import { Router } from 'express';
import { requirePerm } from '../middleware/auth.js';
import * as siteController from '../controllers/site.controller.js';

export const sitesRouter = Router();

sitesRouter.get('/sites', requirePerm('attendance.read'), siteController.listSites);
sitesRouter.post('/sites', requirePerm('sites.write'), siteController.createSite);
sitesRouter.patch('/sites/:id', requirePerm('sites.write'), siteController.updateSite);
sitesRouter.post('/sites/:id/reissue-login', requirePerm('sites.write'), siteController.reissueSiteLogin);
sitesRouter.get('/sites/:id/day', requirePerm('attendance.read'), siteController.getSiteDay);
sitesRouter.get('/sites-network', requirePerm('attendance.read'), siteController.getSitesNetwork);

// ─── Projects ────────────────────────────────────────────────────────────────
sitesRouter.get('/projects', requirePerm('setup.read'), siteController.listProjects);
sitesRouter.post('/projects', requirePerm('setup.write'), siteController.createProject);
sitesRouter.patch('/projects/:id', requirePerm('setup.write'), siteController.updateProject);
sitesRouter.get('/projects/labour-cost', requirePerm('payroll.read'), siteController.getLabourCost);
