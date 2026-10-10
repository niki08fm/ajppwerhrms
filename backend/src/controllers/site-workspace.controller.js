import { z } from 'zod';
import { isoDate, istDate, yearMonth } from '@ajpwer/shared';
import { prisma } from '../config/db.js';
import { AppError, notFound } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { auditReq } from '../utils/audit.js';
import { fromDbDate, toDbDate } from '../utils/dbDates.js';
import { currentSitePeople, siteDayRegister, siteMonthRegister, siteSummary } from '../services/site-workspace.service.js';

const ownSite = (req) => ({ id: req.site.id, code: req.site.code, name: req.site.name });
const today = () => istDate(new Date());

/** A site's cookie is the scope. Filters cannot turn a site login into company-wide access. */
function rejectOtherScope(req) {
  for (const field of ['site_id', 'siteId', 'site']) {
    if (req.query[field] !== undefined && req.query[field] !== req.site.id) {
      throw new AppError('FORBIDDEN', 'This login can only view its own site.', 403, field);
    }
  }
}

export const getSummary = asyncHandler(async (req, res) => {
  rejectOtherScope(req);
  res.json({ data: { site: ownSite(req), ...(await siteSummary(prisma, req.site.id)) } });
});

export const getDay = asyncHandler(async (req, res) => {
  rejectOtherScope(req);
  const date = isoDate.parse(req.query.date ?? today());
  res.json({ data: { site: ownSite(req), date, rows: await siteDayRegister(prisma, req.site.id, date) } });
});

export const getMonth = asyncHandler(async (req, res) => {
  rejectOtherScope(req);
  const ym = yearMonth.parse(req.query.ym ?? today().slice(0, 7));
  res.json({ data: { site: ownSite(req), ym, ...(await siteMonthRegister(prisma, req.site.id, ym)) } });
});

const transferCreate = z.object({
  employee_code: z.string().trim().min(1).max(40),
  to_site_id: z.string().uuid(), departure_date: isoDate,
  reason: z.string().trim().min(3, 'Say why the person is going to another site.').max(300),
}).strict();
const transferDecision = z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().trim().max(300).optional() }).strict();
const transferInclude = {
  employee: { select: { id: true, code: true, name: true, department: { select: { id: true, name: true, colour: true } } } },
  from_site: { select: { id: true, name: true } }, to_site: { select: { id: true, name: true } },
};
export const transferReply = (r) => ({ id: r.id, employee: r.employee, from_site: r.from_site, to_site: r.to_site,
  departure_date: fromDbDate(r.departure_date), reason: r.reason, status: r.status,
  requested_by: r.requested_by, requested_at: r.requested_at.toISOString(),
  decided_by: r.decided_by, decided_at: r.decided_at?.toISOString() ?? null, decision_note: r.decision_note });

export const listTransfers = asyncHandler(async (req, res) => {
  rejectOtherScope(req);
  const rows = await prisma.siteTransferRequest.findMany({ where: { from_site_id: req.site.id }, include: transferInclude,
    orderBy: [{ requested_at: 'desc' }, { id: 'desc' }], take: 100 });
  res.json({ data: rows.map(transferReply) });
});

/** A request records intent only: a normal OUT and IN still record the actual movement. */
export const createTransfer = asyncHandler(async (req, res) => {
  const b = transferCreate.parse(req.body);
  if (b.departure_date < today()) throw new AppError('VALIDATION', 'Choose today or a future departure date.', 422, 'departure_date');
  if (b.to_site_id === req.site.id) throw new AppError('VALIDATION', 'Choose another site.', 422, 'to_site_id');
  const destination = await prisma.site.findFirst({ where: { id: b.to_site_id, is_active: true, deleted_at: null }, select: { id: true } });
  if (!destination) throw new AppError('VALIDATION', 'Choose an active destination site.', 422, 'to_site_id');
  const person = (await currentSitePeople(prisma, req.site.id)).find((p) => p.code.toLowerCase() === b.employee_code.toLowerCase());
  if (!person) throw new AppError('EMPLOYEE_NOT_AT_SITE', 'Choose someone currently punched in at this site.', 422, 'employee_code');
  const result = await prisma.$transaction(async (tx) => {
    // Serialise requests for one employee; a partial unique index also covers simultaneous tablets.
    await tx.$queryRaw`SELECT id FROM employee WHERE id = ${person.id}::uuid FOR UPDATE`;
    const stillHere = (await currentSitePeople(tx, req.site.id)).some((p) => p.id === person.id);
    if (!stillHere) throw new AppError('EMPLOYEE_NOT_AT_SITE', 'This person has already signed out. Refresh the site attendance.', 409, 'employee_code');
    const pending = await tx.siteTransferRequest.findFirst({ where: { employee_id: person.id, status: 'PENDING' } });
    if (pending) throw new AppError('TRANSFER_PENDING', 'This person already has a transfer request waiting for HR.', 409, 'employee_code');
    const row = await tx.siteTransferRequest.create({ data: { employee_id: person.id, from_site_id: req.site.id,
      to_site_id: destination.id, departure_date: toDbDate(b.departure_date), reason: b.reason,
      requested_by: `site:${req.site.code}` }, include: transferInclude });
    await auditReq(req, { action: 'site_transfer.request', entity_type: 'site_transfer_request', entity_id: row.id,
      detail: { employee_id: person.id, from_site_id: req.site.id, to_site_id: destination.id, departure_date: b.departure_date } }, tx);
    return row;
  });
  res.status(201).json({ data: transferReply(result) });
});

export const listTransfersForHR = asyncHandler(async (req, res) => {
  const status = req.query.status === undefined ? undefined : z.enum(['PENDING', 'APPROVED', 'REJECTED']).parse(req.query.status);
  const rows = await prisma.siteTransferRequest.findMany({ where: status ? { status } : {}, include: transferInclude,
    orderBy: [{ requested_at: 'desc' }, { id: 'desc' }], take: 300 });
  res.json({ data: rows.map(transferReply) });
});

export const decideTransfer = asyncHandler(async (req, res) => {
  const id = z.string().uuid().parse(req.params.id);
  const b = transferDecision.parse(req.body);
  const row = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM site_transfer_request WHERE id = ${id}::uuid FOR UPDATE`;
    const existing = await tx.siteTransferRequest.findUnique({ where: { id } });
    if (!existing) throw notFound('That transfer request');
    if (existing.status !== 'PENDING') throw new AppError('CONFLICT', 'This transfer request has already been reviewed.', 409);
    const result = await tx.siteTransferRequest.update({ where: { id }, data: { status: b.decision,
      decided_by: req.admin.email, decided_at: new Date(), decision_note: b.note || null }, include: transferInclude });
    await auditReq(req, { action: 'site_transfer.decide', entity_type: 'site_transfer_request', entity_id: id,
      detail: { decision: b.decision, note: b.note || null } }, tx);
    return result;
  });
  res.json({ data: transferReply(row) });
});
