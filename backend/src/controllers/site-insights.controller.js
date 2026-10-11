import { uuid } from '@ajpwer/shared';
import { prisma } from '../config/db.js';
import { can } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { insightPeriod, siteInsights } from '../services/site-insights.service.js';

export const getSiteInsights = asyncHandler(async (req, res) => {
  const siteId = uuid.parse(req.params.id);
  const period = insightPeriod(req.query);
  const data = await siteInsights(prisma, siteId, { ...period, financial: can(req, 'payroll.read') });
  res.json({ data });
});
