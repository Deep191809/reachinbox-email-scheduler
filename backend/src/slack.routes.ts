import { Router } from 'express';
import crypto from 'node:crypto';
import { env } from './config/env.js';
import { prisma } from './config/database.js';
import { requireAuth } from './middleware/auth.js';

const router = Router();

function createState() {
  const nonce = crypto.randomBytes(24).toString('base64url');
  const signature = crypto.createHmac('sha256', env.SESSION_SECRET).update(nonce).digest('base64url');
  return `${nonce}.${signature}`;
}

function verifyState(state: string | undefined, expectedNonce: string | undefined) {
  if (!state || !expectedNonce) return false;
  const [nonce, signature] = state.split('.');
  if (!nonce || !signature || nonce !== expectedNonce) return false;
  const expected = crypto.createHmac('sha256', env.SESSION_SECRET).update(nonce).digest('base64url');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

router.get('/connect', requireAuth, (req, res) => {
  console.log('Slack config check:', {
  clientId: Boolean(env.SLACK_CLIENT_ID),
  clientSecret: Boolean(env.SLACK_CLIENT_SECRET),
  redirectUri: env.SLACK_REDIRECT_URI,
});
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) {
    return res.status(503).json({ success: false, message: 'Slack OAuth is not configured' });
  }

  const state = createState();
  res.cookie('slack_oauth_state', state.split('.')[0], {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: 10 * 60 * 1000,
  });

  const params = new URLSearchParams({
    client_id: env.SLACK_CLIENT_ID,
    scope: 'chat:write,im:write',
    redirect_uri: env.SLACK_REDIRECT_URI,
    state,
  });
  res.redirect(`https://slack.com/oauth/v2/authorize?${params.toString()}`);
});

router.get('/callback', async (req, res, next) => {
  try {
    if (!verifyState(String(req.query.state || ''), req.cookies?.slack_oauth_state)) {
      return res.status(400).send('Invalid Slack OAuth state');
    }
    res.clearCookie('slack_oauth_state');

    const code = String(req.query.code || '');
    if (!code) return res.status(400).send('Missing Slack authorization code');

    const body = new URLSearchParams({
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: env.SLACK_REDIRECT_URI,
    });

    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const result = (await response.json()) as {
      ok: boolean;
      error?: string;
      access_token?: string;
      team?: { id: string; name: string };
      authed_user?: { id: string };
    };

    if (!result.ok || !result.access_token || !result.team?.id || !result.authed_user?.id) {
      throw new Error(`Slack OAuth failed: ${result.error || 'unknown error'}`);
    }

    // OAuth callback does not contain our app session in a query parameter;
    // the authenticated user is recovered from the signed application cookie.
    const session = req.cookies?.reachinbox_session;
    const { readSessionToken } = await import('./services/auth.service.js');
    const userId = readSessionToken(session);
    if (!userId) return res.status(401).send('Please sign in before connecting Slack');

    await prisma.slackConnection.upsert({
      where: { userId },
      update: {
        teamId: result.team.id,
        teamName: result.team.name,
        accessToken: result.access_token,
        slackUserId: result.authed_user.id,
      },
      create: {
        userId,
        teamId: result.team.id,
        teamName: result.team.name,
        accessToken: result.access_token,
        slackUserId: result.authed_user.id,
      },
    });

    res.redirect(env.FRONTEND_URL);
  } catch (error) {
    next(error);
  }
});

router.get('/status', requireAuth, async (_req, res, next) => {
  try {
    const connection = await prisma.slackConnection.findUnique({
      where: { userId: res.locals.user.id as string },
      select: { teamName: true, createdAt: true },
    });
    res.json({ connected: Boolean(connection), teamName: connection?.teamName ?? null });
  } catch (error) {
    next(error);
  }
});

router.post('/disconnect', requireAuth, async (_req, res, next) => {
  try {
    await prisma.slackConnection.deleteMany({ where: { userId: res.locals.user.id as string } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

export async function notifySlackRateLimit(userId: string, senderEmail: string, hourlyLimit: number) {
  const connection = await prisma.slackConnection.findUnique({ where: { userId } });
  if (!connection) return false;

  const openResponse = await fetch('https://slack.com/api/conversations.open', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ users: connection.slackUserId }),
  });
  const openResult = (await openResponse.json()) as { ok: boolean; channel?: { id: string }; error?: string };
  if (!openResult.ok || !openResult.channel?.id) throw new Error(`Slack DM open failed: ${openResult.error || 'unknown error'}`);

  const postResponse = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      channel: openResult.channel.id,
      text: `ReachInbox rate limit reached for ${senderEmail}. The configured hourly limit of ${hourlyLimit} has been reached; pending emails will continue in the next available hour.`,
    }),
  });
  const postResult = (await postResponse.json()) as { ok: boolean; error?: string };
  if (!postResult.ok) throw new Error(`Slack notification failed: ${postResult.error || 'unknown error'}`);
  return true;
}

export default router;
