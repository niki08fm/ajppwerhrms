import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { prisma } from '../config/db.js';
import { AppError, forbidden } from '../utils/errors.js';
import { ADMIN_COOKIE, SITE_COOKIE, issueAdminSession } from '../services/auth.service.js';

/** Who is signed in (admin or site tablet), and what they are allowed to do. */

// ─── Permission lookup (cached briefly) ──────────────────────────────────────

const principalCache = new Map();
const CACHE_MS = 30_000;

async function loadAdmin(userId) {
  const hit = principalCache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.p;
  const u = await prisma.appUser.findFirst({ where: { id: userId, deleted_at: null }, include: { role: true } });
  const p = u ? { id: u.id, email: u.email, name: u.name, role: u.role.name, permissions: new Set(u.role.permissions) } : null;
  principalCache.set(userId, { at: Date.now(), p });
  return p;
}

export function invalidatePrincipal(userId) {
  if (userId) principalCache.delete(userId);
  else principalCache.clear();
}

/** Resolve the admin session if present. Renews the cookie when over a quarter used (sliding). */
export async function attachAdmin(req, res, next) {
  const token = req.cookies?.[ADMIN_COOKIE];
  if (!token) return next();
  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (payload.typ !== 'admin') return next();
    const admin = await loadAdmin(payload.sub);
    if (admin) {
      req.admin = admin;
      const ageMs = Date.now() - payload.iat * 1000;
      if (ageMs > (env.ADMIN_SESSION_HOURS * 3600_000) / 4) issueAdminSession(res, admin.id);
    }
  } catch {
    // expired or tampered: treated as signed out
  }
  next();
}

export async function attachSite(req, _res, next) {
  const token = req.cookies?.[SITE_COOKIE];
  if (!token) return next();
  try {
    const payload = jwt.verify(token, env.SITE_JWT_SECRET);
    if (payload.typ !== 'site') return next();
    const site = await prisma.site.findFirst({ where: { id: payload.sid, deleted_at: null, is_active: true, login_enabled: true } });
    // A password reset or disabling the login bumps token_version, invalidating every tablet token for the site.
    if (site && site.token_version === payload.tv) {
      req.site = { id: site.id, code: site.code, name: site.name, lat: Number(site.lat), lng: Number(site.lng), radius_m: site.radius_m };
      // "Tablet signed in" on the site screen: at most one write a minute.
      if (!site.last_seen_at || Date.now() - site.last_seen_at.getTime() > 60_000) {
        prisma.site.update({ where: { id: site.id }, data: { last_seen_at: new Date() } }).catch(() => undefined);
      }
    }
  } catch {
    // ignore
  }
  next();
}

/** Require an admin session holding every listed permission. A lookup, never `isAdmin`. */
export function requirePerm(...perms) {
  return (req, _res, next) => {
    if (!req.admin) return next(new AppError('UNAUTHENTICATED', 'Your session has ended. Sign in again.', 401));
    for (const p of perms) if (!req.admin.permissions.has(p)) return next(forbidden());
    next();
  };
}

export function requireAdmin(req, _res, next) {
  if (!req.admin) return next(new AppError('UNAUTHENTICATED', 'Your session has ended. Sign in again.', 401));
  next();
}

export function requireSite(req, _res, next) {
  if (!req.site) return next(new AppError('UNAUTHENTICATED', 'This tablet is not signed in to a site.', 401));
  next();
}

export function can(req, p) {
  return !!req.admin?.permissions.has(p);
}
