import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

interface AdminSession {
  token: string;
  createdAt: number;
  expiresAt: number;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const activeSessions = new Map<string, AdminSession>();

function getExpectedPassword(): string {
  return (process.env.ADMIN_PASSWORD || 'fadi112200').trim();
}

export function verifyAdminPassword(input: string): boolean {
  const expected = getExpectedPassword();
  const a = crypto.createHash('sha256').update(String(input || '').trim()).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createAdminSession(): AdminSession {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const session: AdminSession = {
    token,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  activeSessions.set(token, session);
  return session;
}

export function isValidAdminToken(token: string | undefined): boolean {
  if (!token) return false;
  const session = activeSessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    activeSessions.delete(token);
    return false;
  }
  return true;
}

export function revokeAdminToken(token: string | undefined): void {
  if (token) activeSessions.delete(token);
}

export function extractTokenFromRequest(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const queryToken = req.query?.token;
  if (typeof queryToken === 'string' && queryToken.trim()) {
    return queryToken.trim();
  }
  return undefined;
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = extractTokenFromRequest(req);
  if (!isValidAdminToken(token)) {
    res.status(401).json({
      ok: false,
      code: 'ADMIN_AUTH_REQUIRED',
      error: 'Admin authentication required.',
    });
    return;
  }
  next();
}
