import { Router } from 'express';
import { requirePerm, requireSite } from '../middleware/auth.js';
import { frames } from '../middleware/upload.js';
import * as tabletController from '../controllers/tablet.controller.js';

export const tabletRouter = Router();

tabletRouter.get('/tablet/summary', requireSite, tabletController.getSummary);
tabletRouter.get('/tablet/sites', requireSite, tabletController.listOtherSites);
tabletRouter.get('/tablet/employees', requireSite, tabletController.searchEmployees);

// Face v2 punches (face/INTEGRATION.md §3): start → frames (retry = same request_id) → confirm / not me / change site; after the try limit → manual.
tabletRouter.post('/punches/sessions', requireSite, tabletController.startSession);
tabletRouter.post('/punches/sessions/:id/frames', requireSite, frames, tabletController.uploadFrames);
tabletRouter.post('/punches/sessions/:id/confirm', requireSite, tabletController.confirmPunch);
tabletRouter.post('/punches/sessions/:id/not-me', requireSite, tabletController.notMe);
tabletRouter.post('/punches/sessions/:id/change-site', requireSite, tabletController.changeSite);
tabletRouter.post('/punches/sessions/:id/manual', requireSite, tabletController.manualRequest);

tabletRouter.get('/face-exceptions/:id/snapshot', requirePerm('attendance.read'), tabletController.getSnapshot);
tabletRouter.get('/face-exceptions/:id/crops/:n', requirePerm('attendance.read'), tabletController.getCrop);
