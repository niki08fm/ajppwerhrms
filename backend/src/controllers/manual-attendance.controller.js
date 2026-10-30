import { z } from 'zod';
import { isoDate, yearMonth } from '@ajpwer/shared';
import { prisma } from '../config/db.js';
import { logger } from '../config/logger.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { who } from '../utils/audit.js';
import { AppError } from '../utils/errors.js';
import { invalidateDashboardCache } from '../utils/dashboard-cache.js';
import { invalidateApprovalsCache } from '../services/approvals.service.js';
import { bumpAggregate } from '../services/aggregates.service.js';
import { createManualAttendanceSheet, decideManualAttendanceSheet, editManualAttendanceSheet,
  listManualAttendanceSheets, manualAttendanceSheet } from '../services/manual-attendance.service.js';

const text = (max) => z.string().trim().max(max);
const status = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']);
const create = z.object({ client_request_id: z.string().uuid(), work_date: isoDate,
  reason: text(300).min(3, 'Say why manual attendance is needed.'),
  rows: z.array(z.object({ employee_code: text(40).min(1), in_min: z.number().int().min(0).max(1439), out_min: z.number().int().min(1).max(2879), note: text(300).optional() }).strict()).min(1).max(500),
}).strict();
const edit = z.object({ version: z.number().int().min(1), rows: z.array(z.object({ id: z.string().uuid(),
  in_min: z.number().int().min(0).max(1439).optional(), out_min: z.number().int().min(1).max(2879).optional(),
  included: z.boolean().optional(), note: text(300).optional(),
}).strict()).min(1).max(500) }).strict();
const decision = z.object({ version: z.number().int().min(1), decision: z.enum(['APPROVED', 'REJECTED']), note: text(300).optional() }).strict();
const idOf = (req) => z.string().uuid().parse(req.params.id);
const invalidate = () => { invalidateApprovalsCache(); invalidateDashboardCache(); };

/** A stale form must not submit under another site's login after a site switch. */
function siteScope(req) {
  const expected = req.get('X-Site-Id');
  if (expected && expected !== req.site.id) throw new AppError('FORBIDDEN', 'This draft belongs to another site. Sign in to its site before sending it.', 403);
  for (const key of ['site', 'site_id', 'siteId']) {
    if (req.query[key] !== undefined && req.query[key] !== req.site.id) throw new AppError('FORBIDDEN', 'This login can only view its own site.', 403);
  }
}

export const listEmployeesForManualSheet = asyncHandler(async (req, res) => {
  siteScope(req);
  const data = await prisma.employee.findMany({ where: { deleted_at: null, status: { in: ['ACTIVE', 'NOTICE'] } },
    select: { code: true, name: true, designation: true, department: { select: { id: true, name: true } } }, orderBy: [{ name: 'asc' }, { code: 'asc' }] });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data });
});

export const listForSite = asyncHandler(async (req, res) => {
  siteScope(req);
  const query = z.object({ status: status.optional(), ym: yearMonth.optional() }).parse(req.query);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: await listManualAttendanceSheets(prisma, { siteId: req.site.id, ...query }) });
});
export const getForSite = asyncHandler(async (req, res) => {
  siteScope(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: await manualAttendanceSheet(prisma, idOf(req), { siteId: req.site.id }) });
});
export const submitForSite = asyncHandler(async (req, res) => {
  siteScope(req);
  if (!req.get('X-Site-Id')) throw new AppError('SITE_BINDING_REQUIRED', 'Refresh this site tab before sending its manual attendance sheet.', 428);
  const { actor, ip } = who(req);
  const result = await createManualAttendanceSheet(prisma, req.site, create.parse(req.body), actor, ip);
  invalidate();
  res.setHeader('Cache-Control', 'no-store');
  res.status(result.replayed ? 200 : 201).json({ data: result.sheet });
});

export const listForHR = asyncHandler(async (req, res) => {
  const query = z.object({ status: status.optional(), ym: yearMonth.optional(), site_id: z.string().uuid().optional() }).parse(req.query);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: await listManualAttendanceSheets(prisma, { status: query.status, ym: query.ym, siteId: query.site_id }) });
});
export const getForHR = asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ data: await manualAttendanceSheet(prisma, idOf(req)) });
});
export const editForHR = asyncHandler(async (req, res) => {
  const { actor, ip } = who(req);
  const data = await editManualAttendanceSheet(prisma, idOf(req), edit.parse(req.body), actor, ip);
  invalidate();
  res.json({ data });
});
export const decideForHR = asyncHandler(async (req, res) => {
  const { actor, ip } = who(req);
  const data = await decideManualAttendanceSheet(prisma, idOf(req), decision.parse(req.body), actor, ip);
  invalidate();
  if (data.status === 'APPROVED') {
    // Attendance has committed. A temporary aggregate failure must not turn a
    // successful approval into an apparent failed submission on the tablet.
    await bumpAggregate(data.work_date, data.site.id).catch((error) => logger.warn({ error, sheetId: data.id }, 'manual sheet aggregate refresh failed'));
  }
  res.json({ data });
});
