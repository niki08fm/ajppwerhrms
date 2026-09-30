import { Router } from 'express';
import { requirePerm } from '../middleware/auth.js';
import * as geoController from '../controllers/geo.controller.js';

export const geoRouter = Router();

geoRouter.get('/search', requirePerm('sites.manage'), geoController.searchPlaces);
