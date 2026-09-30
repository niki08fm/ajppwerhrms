import { Router } from 'express';
import { requirePerm } from '../middleware/auth.js';
import * as setupController from '../controllers/setup.controller.js';

export const setupRouter = Router();

setupRouter.get('/policies', requirePerm('setup.read'), setupController.listPolicies);
setupRouter.get('/policies/:key/versions', requirePerm('setup.read'), setupController.listPolicyVersions);
setupRouter.post('/policies', requirePerm('setup.write'), setupController.createPolicy);
setupRouter.post('/policies/:key/versions', requirePerm('setup.write'), setupController.createPolicyVersion);
setupRouter.all(['/policies/:id', '/policies/:key/versions/:v'], setupController.rejectPolicyEdit);
setupRouter.get('/structures', requirePerm('setup.read'), setupController.listStructures);
setupRouter.get('/structures/:id', requirePerm('setup.read'), setupController.getStructure);
setupRouter.post('/structures/validate', requirePerm('setup.read'), setupController.validateStructureDraft);
setupRouter.post('/structures', requirePerm('setup.write'), setupController.createStructure);
setupRouter.get('/pay-groups', requirePerm('setup.read'), setupController.listPayGroups);
setupRouter.get('/pay-groups/:id', requirePerm('setup.read'), setupController.getPayGroup);
setupRouter.post('/pay-groups', requirePerm('setup.write'), setupController.createPayGroup);
setupRouter.get('/pay-groups/:id/structure-move', requirePerm('setup.read'), setupController.previewStructureMove);
setupRouter.patch('/pay-groups/:id', requirePerm('setup.write'), setupController.updatePayGroup);

// ─── Statutory ───────────────────────────────────────────────────────────────
setupRouter.get('/statutory-rates', requirePerm('setup.read'), setupController.getStatutoryRates);
setupRouter.patch('/statutory-rates', requirePerm('setup.write'), setupController.publishStatutoryRates);
setupRouter.get('/pt-slabs', requirePerm('setup.read'), setupController.listPtSlabs);
setupRouter.patch('/pt-slabs', requirePerm('setup.write'), setupController.replacePtSlabs);
setupRouter.get('/tax-regimes', requirePerm('setup.read'), setupController.listTaxRegimes);

// ─── Shifts, holidays, departments, company ──────────────────────────────────
setupRouter.get('/shifts', requirePerm('setup.read'), setupController.listShifts);
setupRouter.post('/shifts', requirePerm('setup.write'), setupController.createShift);
setupRouter.patch('/shifts/:id', requirePerm('setup.write'), setupController.updateShift);
setupRouter.get('/holidays', requirePerm('setup.read'), setupController.listHolidays);
setupRouter.post('/holidays', requirePerm('setup.write'), setupController.createHoliday);
setupRouter.delete('/holidays/:id', requirePerm('setup.write'), setupController.deleteHoliday);
setupRouter.get('/departments', requirePerm('people.read'), setupController.listDepartments);
setupRouter.post('/departments', requirePerm('setup.write'), setupController.createDepartment);
setupRouter.get('/company', requirePerm('setup.read'), setupController.getCompany);
setupRouter.patch('/company', requirePerm('setup.write'), setupController.updateCompany);
setupRouter.get('/calendar-methods', requirePerm('setup.read'), setupController.listCalendarMethods);
