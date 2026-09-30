import { Router } from 'express';
import { requireAdmin, attachSite } from '../middleware/auth.js';
import * as authController from '../controllers/auth.controller.js';

export const authRouter = Router();

authRouter.post('/login', authController.login);
authRouter.post('/logout', authController.logout);
authRouter.get('/me', requireAdmin, authController.me);
authRouter.post('/site-login', authController.siteLogin);
authRouter.post('/site-logout', attachSite, authController.siteLogout);
authRouter.get('/site-me', attachSite, authController.siteMe);
