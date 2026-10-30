import { z } from 'zod';
import { COMPANIES, yearMonth } from '@ajpwer/shared';
import { prisma } from '../config/db.js';
import { buildPayslipArchive } from '../services/payslip-export.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { auditReq } from '../utils/audit.js';

async function sendArchive(req, res, selection) {
  const archive = await buildPayslipArchive(prisma, selection);
  await auditReq(req, { action: 'export.payslips', entity_type: 'payslip', entity_id: selection.employeeId,
    detail: { ...selection, rows: archive.count, format: 'pdf.zip' } });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${archive.filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Payslip-Count', String(archive.count));
  res.send(archive.buffer);
}

export const employeePayslipsZip = asyncHandler(async (req, res) => {
  const employeeId = z.string().uuid().parse(req.params.id);
  const year = z.string().regex(/^\d{4}$/).refine((value) => Number(value) >= 1900 && Number(value) <= 9999, 'Choose a valid year.').parse(req.query.year);
  await sendArchive(req, res, { employeeId, year });
});

export const periodPayslipsZip = asyncHandler(async (req, res) => {
  const ym = yearMonth.parse(req.params.ym);
  const company = z.enum(COMPANIES.map((item) => item.key)).optional().parse(req.query.company);
  const q = z.string().max(200).optional().parse(req.query.q);
  await sendArchive(req, res, { ym, ...(company ? { company } : {}), ...(q ? { q } : {}) });
});
