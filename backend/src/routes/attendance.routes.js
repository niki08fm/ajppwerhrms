import { Router } from 'express';
import { requirePerm } from '../middleware/auth.js';
import * as attendanceController from '../controllers/attendance.controller.js';

export const attendanceRouter = Router();

// ─── Register: one day, everyone ─────────────────────────────────────────────
attendanceRouter.get('/attendance', requirePerm('attendance.read'), attendanceController.getRegister);
attendanceRouter.get('/attendance/day', requirePerm('attendance.read'), attendanceController.getDay);
attendanceRouter.post('/attendance/overrides', requirePerm('attendance.write'), attendanceController.createOverride);
attendanceRouter.post('/attendance/overrides/bulk', requirePerm('attendance.write'), attendanceController.createBulkOverrides);
attendanceRouter.delete('/attendance/overrides/:id', requirePerm('attendance.write'), attendanceController.revertOverride);

// ─── Manual punch (admin, e.g. device down) ──────────────────────────────────
attendanceRouter.post('/punches/manual', requirePerm('attendance.write'), attendanceController.createManualPunch);
attendanceRouter.get('/punches', requirePerm('attendance.read'), attendanceController.listPunches);

// ─── Overtime ────────────────────────────────────────────────────────────────
attendanceRouter.get('/overtime', requirePerm('attendance.read'), attendanceController.listOvertime);

// ─── Face exceptions (Approvals) ─────────────────────────────────────────────
attendanceRouter.get('/face-exceptions', requirePerm('attendance.read'), attendanceController.listFaceExceptions);
attendanceRouter.post('/face-exceptions/:id/decide', requirePerm('attendance.write'), attendanceController.decideFaceException);
