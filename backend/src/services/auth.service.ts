import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';

const SESSION_COOKIE = 'reachinbox_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const googleClient = new OAuth2Client(
  env.GOOGLE_CLIENT_ID,
  env.GOOGLE_CLIENT_SECRET,
  env.GOOGLE_CALLBACK_URL,
);

function sign(value: string) {
  return crypto.createHmac('sha256', env.SESSION_SECRET).update(value).digest('base64url');
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function createSessionToken(userId: string) {
  const payload = Buffer.from(JSON.stringify({ userId, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function readSessionToken(token?: string) {
  if (!token) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { userId: string; exp: number };
    if (!parsed.userId || parsed.exp < Math.floor(Date.now() / 1000)) return null;
    return parsed.userId;
  } catch {
    return null;
  }
}

export function getGoogleAuthorizationUrl(state: string) {
  return googleClient.generateAuthUrl({
    access_type: 'offline',
    scope: ['openid', 'email', 'profile'],
    state,
    prompt: 'consent',
  });
}

export async function completeGoogleLogin(code: string) {
  const { tokens } = await googleClient.getToken(code);
  if (!tokens.access_token) throw new Error('Google did not return an access token');

  const response = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!response.ok) throw new Error('Unable to fetch Google profile');

  const profile = (await response.json()) as {
    sub: string;
    email: string;
    name?: string;
    picture?: string;
  };

  const user = await prisma.user.upsert({
    where: { googleId: profile.sub },
    update: {
      name: profile.name || profile.email,
      email: profile.email,
      avatarUrl: profile.picture,
    },
    create: {
      googleId: profile.sub,
      name: profile.name || profile.email,
      email: profile.email,
      avatarUrl: profile.picture,
    },
  });

  const existingSender = await prisma.sender.findFirst({ where: { userId: user.id } });
  if (!existingSender && env.ETHEREAL_USER && env.ETHEREAL_PASSWORD) {
    await prisma.sender.create({
      data: {
        userId: user.id,
        name: 'Ethereal Sender',
        email: env.ETHEREAL_USER,
        smtpHost: env.ETHEREAL_HOST,
        smtpPort: env.ETHEREAL_PORT,
        smtpUser: env.ETHEREAL_USER,
        smtpPassword: env.ETHEREAL_PASSWORD,
      },
    });
  }

  return user;
}

export { SESSION_COOKIE, SESSION_TTL_SECONDS };
