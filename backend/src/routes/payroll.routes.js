import { Router } from 'express';
import { requirePerm } from '../middleware/auth.js';
import { idempotent } from '../middleware/idempotency.js';
import * as payrollController from '../controllers/payroll.controller.js';
import * as holdController from '../controllers/hold.controller.js';

export const payrollRouter = Router();

payrollRouter.get('/payroll/periods', requirePerm('payroll.read'), payrollController.listPeriods);
payrollRouter.get('/payroll/periods/:ym', requirePerm('payroll.read'), payrollController.getPeriodDetail);

// ─── Step 1: attendance ─────────────────────────────────────────────────────
payrollRouter.get('/payroll/periods/:ym/attendance', requirePerm('payroll.read'), payrollController.getAttendanceStep);

// ─── Step 2: joiners and exits ──────────────────────────────────────────────
payrollRouter.get('/payroll/periods/:ym/joiners', requirePerm('payroll.read'), payrollController.getJoinersStep);
payrollRouter.post('/settlements/:id/include', requirePerm('payroll.run'), payrollController.includeSettlement);

// ─── Step 3: issues and hold-backs ──────────────────────────────────────────
payrollRouter.get('/payroll/periods/:ym/issues', requirePerm('payroll.read'), payrollController.getIssues);
payrollRouter.post('/payroll/periods/:ym/exclusions', requirePerm('payroll.run'), payrollController.excludeEmployee);
payrollRouter.delete('/payroll/periods/:ym/exclusions/:employeeId', requirePerm('payroll.run'), payrollController.removeExclusion);
payrollRouter.get('/payroll/held-back', requirePerm('payroll.read'), payrollController.listHeldBack);
payrollRouter.get('/held-salaries', requirePerm('payroll.read'), holdController.listHeldSalaries);

// ─── Step gates ─────────────────────────────────────────────────────────────
payrollRouter.post('/payroll/periods/:ym/steps/:n/submit', requirePerm('payroll.run'), payrollController.submitPayrollStep);
payrollRouter.post('/payroll/periods/:ym/steps/:n/reopen', requirePerm('payroll.run'), payrollController.reopenPayrollStep);
payrollRouter.get('/adhoc', requirePerm('payroll.read'), payrollController.listAdhoc);
payrollRouter.post('/adhoc', requirePerm('payroll.run'), payrollController.createAdhoc);
payrollRouter.delete('/adhoc/:id', requirePerm('payroll.run'), payrollController.deleteAdhoc);

// ─── Step 5: preview and run ────────────────────────────────────────────────
payrollRouter.get('/payroll/periods/:ym/preview', requirePerm('payroll.read'), payrollController.previewRun);
payrollRouter.post('/payroll/periods/:ym/run', requirePerm('payroll.run'), idempotent('payroll.run'), payrollController.startRun);
payrollRouter.get('/jobs/:id', requirePerm('payroll.read'), payrollController.getJob);
// ─── State transitions ──────────────────────────────────────────────────────
payrollRouter.post('/payroll/periods/:ym/back-to-steps', requirePerm('payroll.run'), payrollController.transitionPeriod('back_to_steps'));
payrollRouter.post('/payroll/periods/:ym/lock', requirePerm('payroll.run'), payrollController.transitionPeriod('lock'));
payrollRouter.post('/payroll/periods/:ym/unlock', requirePerm('payroll.run'), payrollController.transitionPeriod('unlock'));
payrollRouter.post('/payroll/periods/:ym/unmark-paid', requirePerm('payroll.pay'), payrollController.transitionPeriod('unmark_paid'));
payrollRouter.post('/payroll/periods/:ym/mark-paid', requirePerm('payroll.pay'), idempotent('payroll.mark-paid'), payrollController.markPaid);

// ─── Reports and payslips (from the snapshot) ───────────────────────────────
payrollRouter.get('/payroll/reports', requirePerm('payroll.read'), payrollController.listReports);
payrollRouter.get('/payroll/periods/:ym/report/:name', requirePerm('payroll.read'), payrollController.getReport);
payrollRouter.get('/payroll/periods/:ym/payslips/:employeeId', requirePerm('payroll.read'), payrollController.getPayslip);
