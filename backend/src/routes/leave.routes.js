import { Router } from 'express';
import { requirePerm } from '../middleware/auth.js';
import * as leaveController from '../controllers/leave.controller.js';

export const leaveRouter = Router();

leaveRouter.get('/', requirePerm('attendance.read'), leaveController.listLeave);
leaveRouter.post('/', requirePerm('leave.write'), leaveController.createLeave);
leaveRouter.post('/:id/decide', requirePerm('leave.write'), leaveController.decideLeave);
leaveRouter.post('/bulk-decide', requirePerm('leave.write'), leaveController.bulkDecideLeave);
leaveRouter.get('/balances', requirePerm('attendance.read'), leaveController.getBalances);
