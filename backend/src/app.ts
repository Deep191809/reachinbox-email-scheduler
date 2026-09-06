import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { emailQueue } from './queues/email.queue.js';
import { prisma } from './config/database.js';
import routes from './routes.js';
import authRoutes from './auth.routes.js';
import slackRoutes from './slack.routes.js';
import senderRoutes from './sender.routes.js';
import { basicAuth, serverAdapter } from './bull-board.js';
import { requireAuth } from './middleware/auth.js';

export const app = express();

app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use('/api/auth', authRoutes);
app.use('/api/slack', slackRoutes);
app.use('/api/senders', senderRoutes);
app.use('/api', routes);
app.use('/admin/queues', basicAuth, serverAdapter.getRouter());

app.get('/api/health', async (_req, res, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    const counts = await emailQueue.getJobCounts();
    res.json({ ok: true, queue: counts });
  } catch (error) {
    next(error);
  }
});

app.get('/api/emails/scheduled', requireAuth, async (req, res, next) => {
  try {
    const userId = res.locals.user.id as string;
    const emails = await prisma.email.findMany({
      where: { userId, status: { in: ['SCHEDULED', 'PROCESSING'] } },
      orderBy: { scheduledAt: 'asc' },
      take: 500,
    });
    res.json(emails);
  } catch (error) {
    next(error);
  }
});

app.get('/api/emails/sent', requireAuth, async (req, res, next) => {
  try {
    const userId = res.locals.user.id as string;
    const emails = await prisma.email.findMany({
      where: { userId, status: { in: ['SENT', 'FAILED'] } },
      orderBy: { sentAt: 'desc' },
      take: 500,
    });
    res.json(emails);
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ success: false, message: 'Internal server error' });
});
