import { Router } from 'express';
import { requirePerm } from '../middleware/auth.js';
import * as dashboardController from '../controllers/dashboard.controller.js';

export const dashboardRouter = Router();

dashboardRouter.get('/dashboard/today', requirePerm('attendance.read'), dashboardController.getToday);
dashboardRouter.get('/dashboard/trend', requirePerm('attendance.read'), dashboardController.getTrend);
dashboardRouter.get('/dashboard/matrix', requirePerm('attendance.read'), dashboardController.getMatrix);
dashboardRouter.get('/dashboard/status-mix', requirePerm('attendance.read'), dashboardController.getStatusMix);
dashboardRouter.get('/dashboard/net-by-month', requirePerm('payroll.read'), dashboardController.getNetByMonth);
dashboardRouter.get('/dashboard/people', requirePerm('people.read'), dashboardController.getPeople);
dashboardRouter.get('/analytics', requirePerm('payroll.read'), dashboardController.getAnalytics);
