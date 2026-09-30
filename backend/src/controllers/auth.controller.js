import { loginSchema, siteLoginSchema } from '@ajpwer/shared';
import { audit } from '../utils/audit.js';
import { clearSessions, issueAdminSession, issueSiteSession, verifyPassword } from '../services/auth.service.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { checkGeofence } from '../utils/geo.js';
import { prisma } from '../config/db.js';

const WINDOW_MS = 15 * 60_000;

const MAX_FAILURES = 5;

/** Five failed attempts in fifteen minutes, per account and per IP. */
async function assertNotLocked(key, ip) {
  const since = new Date(Date.now() - WINDOW_MS);
  const [byKey, byIp] = await Promise.all([
    prisma.loginAttempt.count({ where: { key, success: false, at: { gte: since } } }),
    ip ? prisma.loginAttempt.count({ where: { ip, success: false, at: { gte: since } } }) : Promise.resolve(0),
  ]);
  if (byKey >= MAX_FAILURES || byIp >= MAX_FAILURES) {
    throw new AppError('RATE_LIMITED', 'Too many failed sign-in attempts. Wait fifteen minutes and try again.', 429);
  }
}

export const login = asyncHandler(async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const key = `admin:${email.toLowerCase()}`;
  const ip = req.ip ?? null;
  await assertNotLocked(key, ip);
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
 * Tablet sign-in. Authenticates only inside the site's geofence; the rejection
 * is logged with its distance and accuracy.
 */
export const siteLogin = asyncHandler(async (req, res) => {
  const b = siteLoginSchema.parse(req.body);
  const key = `site:${b.login.toLowerCase()}`;
  const ip = req.ip ?? null;
  await assertNotLocked(key, ip);
  const site = await prisma.site.findFirst({ where: { login: b.login.toLowerCase(), deleted_at: null } });
  const ok = site && site.is_active ? await verifyPassword(site.password_hash, b.password) : false;
  await prisma.loginAttempt.create({ data: { key, ip, success: !!ok } });
  if (!site || !ok) {
    await audit(prisma, { actor: key, ip, action: 'auth.site_login_failed', entity_type: 'site', entity_id: site?.id ?? null });
    throw new AppError('UNAUTHENTICATED', 'That site login and password do not match, or the site is inactive.', 401);
  }
  const fence = checkGeofence({ lat: Number(site.lat), lng: Number(site.lng), radius_m: site.radius_m }, { lat: b.lat, lng: b.lng, accuracy_m: b.accuracy_m }, env.GPS_MAX_ACCURACY_M);
  if (!fence.ok) {
    await audit(prisma, {
      actor: key,
      ip,
      action: 'geofence.rejected',
      entity_type: 'site',
      entity_id: site.id,
      detail: { stage: 'login', distance_m: fence.distance_m, accuracy_m: b.accuracy_m, reason: fence.reason },
    });
    throw new AppError('GEOFENCE_REJECTED', fence.reason, 403);
  }
  await audit(prisma, { actor: key, ip, action: 'auth.site_login', entity_type: 'site', entity_id: site.id, detail: { distance_m: fence.distance_m } });
  issueSiteSession(res, site.id, site.token_version);
  res.json({ data: { id: site.id, code: site.code, name: site.name } });
});

/** Signing out works anywhere, so a stolen tablet can be logged out. */
export const siteLogout = asyncHandler(async (req, res) => {
  if (req.site) await audit(prisma, { actor: `site:${req.site.code}`, ip: req.ip ?? null, action: 'auth.site_logout', entity_type: 'site', entity_id: req.site.id });
  clearSessions(res, 'site');
  res.json({ data: { ok: true } });
});

export const siteMe = asyncHandler(async (req, res) => {
  if (!req.site) throw new AppError('UNAUTHENTICATED', 'This tablet is not signed in to a site.', 401);
  res.json({ data: { id: req.site.id, code: req.site.code, name: req.site.name, radius_m: req.site.radius_m } });
});
