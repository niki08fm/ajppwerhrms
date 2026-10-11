import { z } from 'zod';
import { isoDate, istDate, yearMonth } from '@ajpwer/shared';
import { prisma } from '../config/db.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { VIEWS } from '../services/dayview.service.js';
import { buildDailyAttendanceReport, buildMonthlyAttendanceReport, renderAttendanceReport } from '../services/attendance-reports.service.js';

const filterValue = z.union([z.string().max(2000), z.array(z.string().max(200)).max(100)]);
const common = {
  format: z.enum(['xlsx', 'pdf']),
  q: z.string().max(200).optional(),
  dept: z.string().uuid().optional(),
  pay_group: z.string().uuid().optional(),
  site: z.string().uuid().optional(),
  filter: z.object({
    dept: filterValue.optional(), pay_group: filterValue.optional(), site: filterValue.optional(),
    view: z.enum(VIEWS).optional(), status: filterValue.optional(),
    corrected: z.enum(['yes', 'no']).optional(), late: z.enum(['yes', 'no']).optional(),
    early: z.enum(['yes', 'no']).optional(), ot: z.enum(['yes', 'no']).optional(),
  }).optional(),
};

async function sendReport(res, report, format) {
  const buffer = await renderAttendanceReport(report, format);
  res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${report.kind}-${report.period}.${format}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
}

export const monthlyAttendanceReport = asyncHandler(async (req, res) => {
  const query = z.object({ ...common, ym: yearMonth, report: z.enum(['summary', 'detailed']) }).parse(req.query);
  const report = await buildMonthlyAttendanceReport(prisma, query, istDate(new Date()));
  await sendReport(res, report, query.format);
});

export const dailyAttendanceReport = asyncHandler(async (req, res) => {
  const query = z.object({ ...common, date: isoDate }).parse(req.query);
  const report = await buildDailyAttendanceReport(prisma, query, istDate(new Date()));
  await sendReport(res, report, query.format);
});
