import { Router } from 'express';
import { requirePerm } from '../middleware/auth.js';
import * as leaveController from '../controllers/leave.controller.js';

export const leaveRouter = Router();

leaveRouter.get('/', requirePerm('attendance.read'), leaveController.listLeave);
leaveRouter.post('/', requirePerm('leave.write'), leaveController.createLeave);
leaveRouter.post('/preview', requirePerm('attendance.read'), leaveController.previewLeave);
leaveRouter.post('/:id/decide', requirePerm('leave.write'), leaveController.decideLeave);
leaveRouter.post('/bulk-decide', requirePerm('leave.write'), leaveController.bulkDecideLeave);
leaveRouter.get('/balances', requirePerm('attendance.read'), leaveController.getBalances);
leaveRouter.get('/types', requirePerm('attendance.read'), leaveController.listLeaveTypes);
leaveRouter.get('/adjustments', requirePerm('attendance.read'), leaveController.listAdjustments);
leaveRouter.post('/adjustments', requirePerm('leave.write'), leaveController.createAdjustment);
leaveRouter.delete('/adjustments/:id', requirePerm('leave.write'), leaveController.deleteAdjustment);
