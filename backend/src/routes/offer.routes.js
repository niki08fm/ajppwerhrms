import { Router } from 'express';
import { requirePerm } from '../middleware/auth.js';
import * as offerController from '../controllers/offer.controller.js';

export const offersRouter = Router();

offersRouter.get('/', requirePerm('people.read'), offerController.listOffers);
offersRouter.post('/', requirePerm('people.write', 'salary.write'), offerController.createOffer);
offersRouter.post('/:id/accept', requirePerm('people.write'), offerController.acceptOffer);
offersRouter.post('/onboard', requirePerm('people.write', 'salary.write'), offerController.startOnboardingMany);
offersRouter.post('/:id/onboard', requirePerm('people.write', 'salary.write'), offerController.startOnboarding);
offersRouter.post('/:id/revoke', requirePerm('people.write'), offerController.revokeOffer);
