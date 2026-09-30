import type { CookieOptions, NextFunction, Request, Response } from 'express';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import type { Permission } from '@ajpwer/shared';
import { env } from './env';
import { AppError, forbidden } from './errors';
import { prisma } from './prisma';

export const ADMIN_COOKIE = 'ajpwer_session';
export const SITE_COOKIE = 'ajpwer_site';

export interface AdminPrincipal {
  id: string;
  email: string;
  name: string;
  role: string;
  permissions: Set<string>;
}

export interface SitePrincipal {
  id: string;
  code: string;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    admin?: AdminPrincipal;
    site?: SitePrincipal;
  }
}

// ─── Passwords ───────────────────────────────────────────────────────────────

export function hashPassword(pw: string): Promise<string> {
  return argon2.hash(pw, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(hash: string, pw: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}

// ─── Cookies ─────────────────────────────────────────────────────────────────

function cookieOpts(hours: number): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    domain: env.COOKIE_DOMAIN,
    path: '/',
    maxAge: hours * 3600_000,
  };
}

interface AdminToken {
  sub: string;
  typ: 'admin';
  iat: number;
}

interface SiteToken {
  sid: string;
  tv: number;
  typ: 'site';
}

export function issueAdminSession(res: Response, userId: string): void {
  const token = jwt.sign({ sub: userId, typ: 'admin' }, env.JWT_SECRET, { expiresIn: `${env.ADMIN_SESSION_HOURS}h` });
  res.cookie(ADMIN_COOKIE, token, cookieOpts(env.ADMIN_SESSION_HOURS));
}

export function issueSiteSession(res: Response, siteId: string, tokenVersion: number): void {
  const token = jwt.sign({ sid: siteId, tv: tokenVersion, typ: 'site' }, env.SITE_JWT_SECRET, { expiresIn: `${env.SITE_SESSION_HOURS}h` });
  res.cookie(SITE_COOKIE, token, cookieOpts(env.SITE_SESSION_HOURS));
}

export function clearSessions(res: Response, which: 'admin' | 'site'): void {
  res.clearCookie(which === 'admin' ? ADMIN_COOKIE : SITE_COOKIE, { path: '/', domain: env.COOKIE_DOMAIN });
}

// ─── Permission lookup (cached briefly) ──────────────────────────────────────

const principalCache = new Map<string, { at: number; p: AdminPrincipal | null }>();
const CACHE_MS = 30_000;

async function loadAdmin(userId: string): Promise<AdminPrincipal | null> {
  const hit = principalCache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.p;
  const u = await prisma.appUser.findFirst({ where: { id: userId, deleted_at: null }, include: { role: true } });
  const p = u ? { id: u.id, email: u.email, name: u.name, role: u.role.name, permissions: new Set(u.role.permissions) } : null;
  principalCache.set(userId, { at: Date.now(), p });
  return p;
}

export function invalidatePrincipal(userId?: string) {
  if (userId) principalCache.delete(userId);
  else principalCache.clear();
}

/** Resolve the admin session if present. Renews the cookie when over a quarter used (sliding). */
export async function attachAdmin(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[ADMIN_COOKIE];
  if (!token) return next();
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as AdminToken;
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

export async function attachSite(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[SITE_COOKIE];
  if (!token) return next();
  try {
    const payload = jwt.verify(token, env.SITE_JWT_SECRET) as SiteToken;
    if (payload.typ !== 'site') return next();
    const site = await prisma.site.findFirst({ where: { id: payload.sid, deleted_at: null, is_active: true } });
    // Rotation bumps token_version, invalidating every tablet token for the site.
    if (site && site.token_version === payload.tv) {
      req.site = { id: site.id, code: site.code, name: site.name, lat: Number(site.lat), lng: Number(site.lng), radius_m: site.radius_m };
    }
  } catch {
    // ignore
  }
  next();
}

/** Require an admin session holding every listed permission. A lookup, never `isAdmin`. */
export function requirePerm(...perms: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.admin) return next(new AppError('UNAUTHENTICATED', 'Your session has ended. Sign in again.', 401));
    for (const p of perms) if (!req.admin.permissions.has(p)) return next(forbidden());
    next();
  };
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.admin) return next(new AppError('UNAUTHENTICATED', 'Your session has ended. Sign in again.', 401));
  next();
}

export function requireSite(req: Request, _res: Response, next: NextFunction) {
  if (!req.site) return next(new AppError('UNAUTHENTICATED', 'This tablet is not signed in to a site.', 401));
  next();
}

export function can(req: Request, p: Permission): boolean {
  return !!req.admin?.permissions.has(p);
}
