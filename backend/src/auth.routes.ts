import { Router } from 'express';
import crypto from 'node:crypto';
import { env } from './config/env.js';
import { prisma } from './config/database.js';
import { completeGoogleLogin, createSessionToken, getGoogleAuthorizationUrl, SESSION_COOKIE, SESSION_TTL_SECONDS } from './services/auth.service.js';

const router = Router();

function createOAuthState() {
  const nonce = crypto.randomBytes(24).toString('base64url');
  const signature = crypto.createHmac('sha256', env.SESSION_SECRET).update(nonce).digest('base64url');
  return `${nonce}.${signature}`;
}

function verifyOAuthState(state: string | undefined, expectedNonce: string | undefined) {
  if (!state || !expectedNonce) return false;
  const [nonce, signature] = state.split('.');
  if (!nonce || !signature || nonce !== expectedNonce) return false;
  const expected = crypto.createHmac('sha256', env.SESSION_SECRET).update(nonce).digest('base64url');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

router.get('/google', (_req, res) => {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({ success: false, message: 'Google OAuth is not configured' });
  }
  const state = createOAuthState();
  const nonce = state.split('.')[0];
  res.cookie('google_oauth_state', nonce, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: 10 * 60 * 1000,
  });
  res.redirect(getGoogleAuthorizationUrl(state));
});

router.get('/google/callback', async (req, res, next) => {
  try {
    if (!verifyOAuthState(String(req.query.state || ''), req.cookies?.google_oauth_state)) return res.status(400).send('Invalid OAuth state');
    res.clearCookie('google_oauth_state');
    const code = String(req.query.code || '');
    if (!code) return res.status(400).send('Missing Google authorization code');

    const user = await completeGoogleLogin(code);
    const token = createSessionToken(user.id);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      maxAge: SESSION_TTL_SECONDS * 1000,
    });
    res.redirect(env.FRONTEND_URL);
  } catch (error) {
    next(error);
  }
});

router.get('/me', async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE];
  const { readSessionToken } = await import('./services/auth.service.js');
  const userId = readSessionToken(token);
  if (!userId) return res.status(401).json({ success: false, message: 'Not authenticated' });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, avatarUrl: true },
  });
  if (!user) return res.status(401).json({ success: false, message: 'Not authenticated' });
  res.json(user);
});

router.post('/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production' });
  res.status(204).send();
});

export default router;
