import { Router } from 'express';
import { requirePerm } from '../middleware/auth.js';
import * as attendanceController from '../controllers/attendance.controller.js';

export const attendanceRouter = Router();

// ─── Register: one day, everyone ─────────────────────────────────────────────
attendanceRouter.get('/attendance', requirePerm('attendance.read'), attendanceController.getRegister);
attendanceRouter.get('/attendance/day', requirePerm('attendance.read'), attendanceController.getDay);
attendanceRouter.get('/attendance/month', requirePerm('attendance.read'), attendanceController.getMonthRegister);
attendanceRouter.post('/attendance/overrides', requirePerm('attendance.write'), attendanceController.createOverride);
attendanceRouter.post('/attendance/overrides/bulk', requirePerm('attendance.write'), attendanceController.createBulkOverrides);
attendanceRouter.post('/attendance/overrides/preview', requirePerm('attendance.write'), attendanceController.previewOverride);
attendanceRouter.delete('/attendance/overrides/:id', requirePerm('attendance.write'), attendanceController.revertOverride);

// ─── Manual punch (admin, e.g. device down) ──────────────────────────────────
attendanceRouter.post('/punches/manual', requirePerm('attendance.write'), attendanceController.createManualPunch);
attendanceRouter.get('/punches', requirePerm('attendance.read'), attendanceController.listPunches);

// ─── Overtime ────────────────────────────────────────────────────────────────
attendanceRouter.get('/overtime', requirePerm('attendance.read'), attendanceController.listOvertime);

// ─── Face exceptions (Approvals) ─────────────────────────────────────────────
attendanceRouter.get('/face-exceptions', requirePerm('attendance.read'), attendanceController.listFaceExceptions);
attendanceRouter.post('/face-exceptions/:id/decide', requirePerm('attendance.write'), attendanceController.decideFaceException);

// ─── Face v2: site changes with travel, and the punch attempt log ────────────
attendanceRouter.get('/site-changes', requirePerm('attendance.read'), attendanceController.listSiteChanges);
attendanceRouter.patch('/site-changes/:id', requirePerm('attendance.write'), attendanceController.reviewSiteChange);
attendanceRouter.get('/punch-attempts.csv', requirePerm('attendance.read', 'reports.export'), attendanceController.exportPunchAttempts);
