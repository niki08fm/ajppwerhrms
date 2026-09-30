import { Router } from 'express';
import { requirePerm } from '../middleware/auth.js';
import * as auditController from '../controllers/audit.controller.js';

export const auditRouter = Router();

auditRouter.get('/', requirePerm('audit.read'), auditController.listAuditLog);
auditRouter.get('/facets', requirePerm('audit.read'), auditController.getFacets);
auditRouter.get('/export', requirePerm('audit.read', 'reports.export'), auditController.exportAuditLog);
