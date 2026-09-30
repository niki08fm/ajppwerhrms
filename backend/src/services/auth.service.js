import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/** Passwords and session cookies for HR admins and site tablets. */
export const ADMIN_COOKIE = 'ajpwer_session';
export const SITE_COOKIE = 'ajpwer_site';

// ─── Passwords ───────────────────────────────────────────────────────────────

export function hashPassword(pw) {
  return argon2.hash(pw, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
}

export async function verifyPassword(hash, pw) {
  try {
    return await argon2.verify(hash, pw);
  } catch {
    return false;
  }
}

// ─── Cookies ─────────────────────────────────────────────────────────────────

function cookieOpts(hours) {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    domain: env.COOKIE_DOMAIN,
    path: '/',
    maxAge: hours * 3600_000,
  };
}

export function issueAdminSession(res, userId) {
  const token = jwt.sign({ sub: userId, typ: 'admin' }, env.JWT_SECRET, { expiresIn: `${env.ADMIN_SESSION_HOURS}h` });
  res.cookie(ADMIN_COOKIE, token, cookieOpts(env.ADMIN_SESSION_HOURS));
}

export function issueSiteSession(res, siteId, tokenVersion) {
  const token = jwt.sign({ sid: siteId, tv: tokenVersion, typ: 'site' }, env.SITE_JWT_SECRET, { expiresIn: `${env.SITE_SESSION_HOURS}h` });
  res.cookie(SITE_COOKIE, token, cookieOpts(env.SITE_SESSION_HOURS));
}

export function clearSessions(res, which) {
  res.clearCookie(which === 'admin' ? ADMIN_COOKIE : SITE_COOKIE, { path: '/', domain: env.COOKIE_DOMAIN });
}
