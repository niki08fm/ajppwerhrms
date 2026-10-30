import { Router } from 'express';
import { requirePerm, requireSite } from '../middleware/auth.js';
import * as controller from '../controllers/manual-attendance.controller.js';

export const manualAttendanceRouter = Router();
manualAttendanceRouter.get('/tablet/manual-attendance-employees', requireSite, controller.listEmployeesForManualSheet);
manualAttendanceRouter.get('/tablet/manual-attendance-sheets', requireSite, controller.listForSite);
manualAttendanceRouter.post('/tablet/manual-attendance-sheets', requireSite, controller.submitForSite);
manualAttendanceRouter.get('/tablet/manual-attendance-sheets/:id', requireSite, controller.getForSite);
manualAttendanceRouter.get('/manual-attendance-sheets', requirePerm('attendance.read'), controller.listForHR);
manualAttendanceRouter.get('/manual-attendance-sheets/:id', requirePerm('attendance.read'), controller.getForHR);
manualAttendanceRouter.patch('/manual-attendance-sheets/:id', requirePerm('attendance.write'), controller.editForHR);
manualAttendanceRouter.post('/manual-attendance-sheets/:id/decide', requirePerm('attendance.write'), controller.decideForHR);
