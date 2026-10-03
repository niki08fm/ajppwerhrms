import { Router } from 'express';
import { requirePerm } from '../middleware/auth.js';
import * as moneyController from '../controllers/money.controller.js';
import * as exitController from '../controllers/exit.controller.js';

export const moneyRouter = Router();

// ─── Advances and loans ─────────────────────────────────────────────────────
moneyRouter.get('/advances-loans', requirePerm('salary.read'), moneyController.listAdvancesAndLoans);
moneyRouter.post('/advances', requirePerm('salary.write'), moneyController.createAdvance);
moneyRouter.post('/loans', requirePerm('salary.write'), moneyController.createLoan);

// ─── Exits and settlement ───────────────────────────────────────────────────
moneyRouter.get('/settlements', requirePerm('payroll.read'), moneyController.listSettlements);
moneyRouter.get('/settlements/:employeeId', requirePerm('payroll.read'), moneyController.getSettlement);
moneyRouter.post('/settlements/:id/decision', requirePerm('payroll.pay'), moneyController.decideSettlement);
moneyRouter.post('/settlements/:employeeId/adjust', requirePerm('payroll.run'), exitController.adjustSettlement);
