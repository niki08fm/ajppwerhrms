import { Router } from 'express';
import { requireSite, requirePerm } from '../middleware/auth.js';
import { idempotent } from '../middleware/idempotency.js';
import * as tabletController from '../controllers/tablet.controller.js';

export const tabletRouter = Router();

tabletRouter.get('/tablet/summary', requireSite, tabletController.getSummary);
tabletRouter.post('/punches/identify', requireSite, tabletController.identify);
tabletRouter.post('/punches', requireSite, idempotent('punch'), tabletController.createPunch);
tabletRouter.post('/face-exceptions', requireSite, tabletController.raiseFaceException);
tabletRouter.get('/face-exceptions/:id/snapshot', requirePerm('attendance.read'), tabletController.getSnapshot);
