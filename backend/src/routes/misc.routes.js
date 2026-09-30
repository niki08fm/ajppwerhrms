import { Router } from 'express';
import { requirePerm, requireAdmin } from '../middleware/auth.js';
import * as miscController from '../controllers/misc.controller.js';

export const miscRouter = Router();

miscRouter.get('/search', requirePerm('people.read'), miscController.search);
miscRouter.get('/lookups', requireAdmin, miscController.getLookups);

// ─── Saved views (per user) ─────────────────────────────────────────────────
miscRouter.get('/saved-views', requireAdmin, miscController.listSavedViews);
miscRouter.post('/saved-views', requireAdmin, miscController.saveView);
miscRouter.delete('/saved-views/:id', requireAdmin, miscController.deleteSavedView);
miscRouter.get('/documents', requirePerm('people.read'), miscController.getDocumentStatus);
miscRouter.post('/documents/verify', requirePerm('people.write'), miscController.verifyDocuments);
