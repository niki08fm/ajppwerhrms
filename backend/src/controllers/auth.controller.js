import { loginSchema, siteLoginSchema } from '@ajpwer/shared';
import { audit } from '../utils/audit.js';
import { clearSessions, issueAdminSession, issueSiteSession, verifyPassword } from '../services/auth.service.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { checkGeofence } from '../utils/geo.js';
import { prisma } from '../config/db.js';

// There is no lockout: wrong passwords can be retried at once. Every attempt is still recorded.

export const login = asyncHandler(async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const key = `admin:${email.toLowerCase()}`;
  const ip = req.ip ?? null;
  const user = await prisma.appUser.findFirst({ where: { email: email.toLowerCase(), deleted_at: null }, include: { role: true } });
  const ok = user ? await verifyPassword(user.password_hash, password) : false;
  await prisma.loginAttempt.create({ data: { key, ip, success: ok } });
  await audit(prisma, { actor: email.toLowerCase(), ip, action: ok ? 'auth.login' : 'auth.login_failed', entity_type: 'app_user', entity_id: user?.id ?? null });
  if (!user || !ok) throw new AppError('UNAUTHENTICATED', 'That email and password do not match.', 401);
  await prisma.appUser.update({ where: { id: user.id }, data: { last_login_at: new Date() } });
  issueAdminSession(res, user.id);
  res.json({ data: { id: user.id, email: user.email, name: user.name, role: user.role.name, permissions: user.role.permissions } });
});

export const logout = asyncHandler(async (req, res) => {
  if (req.admin) await audit(prisma, { actor: req.admin.email, ip: req.ip ?? null, action: 'auth.logout', entity_type: 'app_user', entity_id: req.admin.id });
  clearSessions(res, 'admin');
  res.json({ data: { ok: true } });
});

export const me = asyncHandler(async (req, res) => {
  const a = req.admin;
  res.json({ data: { id: a.id, email: a.email, name: a.name, role: a.role, permissions: [...a.permissions] } });
});

/**
 * Tablet sign-in. Checks, in order, each with its own message: the login exists
 * and is enabled; the password; GPS accuracy; distance from the site centre.
 * Rejections are logged with distance and accuracy, never the password.
 */
export const siteLogin = asyncHandler(async (req, res) => {
  const b = siteLoginSchema.parse(req.body);
  const loginId = b.login.trim().toLowerCase();
  const key = `site:${loginId}`;
  const ip = req.ip ?? null;
  const site = await prisma.site.findFirst({ where: { login: loginId, deleted_at: null } });
  const fail = async (code, message, status = 401) => {
    await prisma.loginAttempt.create({ data: { key, ip, success: false } });
    await audit(prisma, { actor: key, ip, action: 'auth.site_login_failed', entity_type: 'site', entity_id: site?.id ?? null, detail: { reason: code } });
    throw new AppError(code, message, status, code === 'LOGIN_NOT_FOUND' ? 'login' : code === 'WRONG_PASSWORD' ? 'password' : null);
  };
  if (!site) return fail('LOGIN_NOT_FOUND', `There is no site with the login ID "${loginId}". Check it with HR.`);
  if (!site.login_enabled || !site.is_active) {
    return fail('LOGIN_DISABLED', `The login for ${site.name} is ${site.is_active ? 'disabled' : 'switched off because the site is inactive'}. Ask HR to enable it.`, 403);
  }
  if (!(await verifyPassword(site.password_hash, b.password))) return fail('WRONG_PASSWORD', `That password is not right for ${site.name}. Forgot the password? Ask HR to reset it.`);
  await prisma.loginAttempt.create({ data: { key, ip, success: true } });
  const fence = checkGeofence({ name: site.name, lat: Number(site.lat), lng: Number(site.lng), radius_m: site.radius_m }, { lat: b.lat, lng: b.lng, accuracy_m: b.accuracy_m }, env.GPS_MAX_ACCURACY_M, 'Sign in');
  if (!fence.ok) {
    await audit(prisma, {
      actor: key,
      ip,
      action: 'geofence.rejected',
      entity_type: 'site',
      entity_id: site.id,
      detail: { stage: 'login', check: fence.code, distance_m: fence.distance_m, accuracy_m: b.accuracy_m, radius_m: site.radius_m },
    });
    throw new AppError('GEOFENCE_REJECTED', fence.reason, 403, fence.code);
  }
  const now = new Date();
  await prisma.site.update({ where: { id: site.id }, data: { last_login_at: now, last_seen_at: now } });
  await audit(prisma, { actor: key, ip, action: 'auth.site_login', entity_type: 'site', entity_id: site.id, detail: { distance_m: fence.distance_m, accuracy_m: b.accuracy_m } });
  issueSiteSession(res, site.id, site.token_version);
  res.json({ data: { id: site.id, code: site.code, name: site.name } });
});

/** Signing out works anywhere, so a stolen tablet can be logged out. */
export const siteLogout = asyncHandler(async (req, res) => {
  if (req.site) {
    await prisma.site.update({ where: { id: req.site.id }, data: { last_seen_at: null } });
    await audit(prisma, { actor: `site:${req.site.code}`, ip: req.ip ?? null, action: 'auth.site_logout', entity_type: 'site', entity_id: req.site.id });
  }
  clearSessions(res, 'site');
  res.json({ data: { ok: true } });
});

export const siteMe = asyncHandler(async (req, res) => {
  if (!req.site) throw new AppError('UNAUTHENTICATED', 'This tablet is not signed in to a site.', 401);
  res.json({ data: { id: req.site.id, code: req.site.code, name: req.site.name, radius_m: req.site.radius_m } });
});
