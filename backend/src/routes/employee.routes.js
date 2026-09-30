import { Router } from 'express';
import { requirePerm } from '../middleware/auth.js';
import { frames, upload } from '../middleware/upload.js';
import * as employeeController from '../controllers/employee.controller.js';

export const employeesRouter = Router();

employeesRouter.get('/', requirePerm('people.read'), employeeController.listEmployees);
employeesRouter.get('/export', requirePerm('people.read', 'reports.export'), employeeController.exportEmployees);
employeesRouter.post('/', requirePerm('people.write', 'salary.write'), employeeController.createEmployee);
employeesRouter.post('/bulk', requirePerm('people.write', 'salary.write'), employeeController.bulkAction);
employeesRouter.post('/salary-preview', requirePerm('salary.read'), employeeController.getSalaryPreview);
employeesRouter.get('/:id', requirePerm('people.read'), employeeController.getEmployee);
employeesRouter.get('/:id/identity', requirePerm('pii.read'), employeeController.getIdentity);
employeesRouter.patch('/:id', requirePerm('people.write'), employeeController.updateEmployee);

// ─── Salary ──────────────────────────────────────────────────────────────────
employeesRouter.get('/:id/salary', requirePerm('salary.read'), employeeController.getSalaryHistory);
employeesRouter.post('/:id/salary', requirePerm('salary.write'), employeeController.reviseSalary);
employeesRouter.post('/:id/salary/restate', requirePerm('salary.write'), employeeController.restateSalary);

// ─── Statutory ───────────────────────────────────────────────────────────────
employeesRouter.patch('/:id/statutory', requirePerm('salary.write'), employeeController.updateStatutory);
employeesRouter.get('/:id/pay', requirePerm('salary.read'), employeeController.getPay);
employeesRouter.get('/:id/tax', requirePerm('salary.read'), employeeController.getTax);

// ─── Attendance, payslips, leave, timeline ───────────────────────────────────
employeesRouter.get('/:id/attendance', requirePerm('attendance.read'), employeeController.getAttendance);
employeesRouter.get('/:id/payslip-preview', requirePerm('salary.read'), employeeController.getPayslipPreview);
employeesRouter.get('/:id/payslips', requirePerm('payroll.read'), employeeController.listPayslips);
employeesRouter.get('/:id/leave-balances', requirePerm('attendance.read'), employeeController.getLeaveBalances);
employeesRouter.get('/:id/timeline', requirePerm('people.read'), employeeController.getTimeline);

// ─── Onboarding ──────────────────────────────────────────────────────────────
employeesRouter.post('/:id/onboarding/:task', requirePerm('people.write'), employeeController.updateOnboardingTask);
employeesRouter.post('/:id/activate', requirePerm('people.write'), employeeController.activate);

// ─── Exit ────────────────────────────────────────────────────────────────────
employeesRouter.post('/:id/resign', requirePerm('people.write'), employeeController.resign);

// ─── Face enrolment ──────────────────────────────────────────────────────────
employeesRouter.post('/:id/face', requirePerm('people.write'), frames, employeeController.enrolFace);
employeesRouter.delete('/:id/face', requirePerm('people.write'), employeeController.removeFace);

// ─── Documents ───────────────────────────────────────────────────────────────
employeesRouter.get('/:id/documents', requirePerm('people.read'), employeeController.listDocuments);
employeesRouter.post('/:id/documents', requirePerm('people.write'), upload.single('file'), employeeController.uploadDocument);
employeesRouter.post('/:id/documents/:docId/verify', requirePerm('people.write'), employeeController.verifyDocument);
employeesRouter.get('/:id/documents/:docId/file', requirePerm('people.read'), employeeController.downloadDocument);

// ─── Letters ─────────────────────────────────────────────────────────────────
employeesRouter.get('/:id/letters', requirePerm('people.read'), employeeController.listLetters);
employeesRouter.post('/:id/letters', requirePerm('people.write'), employeeController.createLetter);
employeesRouter.get('/:id/letters/:letterId', requirePerm('people.read'), employeeController.getLetter);
employeesRouter.get('/meta/today', employeeController.getTodayMeta);
