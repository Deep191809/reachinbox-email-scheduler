import { DelayedError, Worker } from 'bullmq';
import { bullConnection } from '../config/redis.js';
import { env } from '../config/env.js';
import { prisma } from '../config/database.js';
import { emailQueue, EMAIL_QUEUE, type EmailJobData } from './email.queue.js';
import { reserveSendAttempt, shouldNotifyRateLimit } from '../services/rate-limit.service.js';
import { sendEmail } from '../services/email.service.js';
import { notifySlackRateLimit } from '../slack.routes.js';

export const emailWorker = new Worker<EmailJobData>(
  EMAIL_QUEUE,
  async (job, token) => {
    const email = await prisma.email.findUnique({ where: { id: job.data.emailId }, include: { sender: true } });
    if (!email) throw new Error(`Email ${job.data.emailId} not found`);
    if (email.status === 'SENT') return { skipped: true, reason: 'already-sent' };
    if (email.status === 'PROCESSING' && email.processingAt) {
      const recoveryAt = email.processingAt.getTime() + 120_000;
      if (Date.now() < recoveryAt) {
        const delay = Math.max(1000, recoveryAt - Date.now());
        if (!token) throw new Error('BullMQ job token is unavailable for processing recovery');
        await job.moveToDelayed(Date.now() + delay, token);
        throw new DelayedError();
      }
    }

    const campaign = await prisma.campaign.findUnique({ where: { id: email.campaignId } });
    const hourlyLimit = campaign?.hourlyLimit ?? env.MAX_EMAILS_PER_HOUR_PER_SENDER;
    const minimumDelayMs = campaign?.delayMs ?? env.DEFAULT_EMAIL_DELAY_MS;

    const reservation = await reserveSendAttempt(email.senderId, hourlyLimit, minimumDelayMs);

    if (reservation.status === 'rate-limited') {
      const delay = Math.max(1000, reservation.retryAt.getTime() - Date.now());
      if (!token) throw new Error('BullMQ job token is unavailable for rescheduling');
      await job.moveToDelayed(Date.now() + delay, token);
      throw new DelayedError();
    }

    if (reservation.status === 'allowed' && reservation.count === hourlyLimit) {
      const shouldNotify = await shouldNotifyRateLimit(email.senderId);
      if (shouldNotify) {
        await notifySlackRateLimit(email.userId, email.sender.email, hourlyLimit).catch((error) => console.error('[slack] notification failed:', error));
      }
    }

    if (reservation.status === 'throttled') {
      const delay = Math.max(50, reservation.retryAt.getTime() - Date.now());
      if (!token) throw new Error('BullMQ job token is unavailable for rescheduling');
      await job.moveToDelayed(Date.now() + delay, token);
      throw new DelayedError();
    }

    return sendEmail(email.id, job.attemptsMade);
  },
  {
    connection: bullConnection,
    concurrency: env.WORKER_CONCURRENCY,
    maxStalledCount: 1,
  },
);

emailWorker.on('completed', (job) => console.log(`[worker] completed ${job.id}`));
emailWorker.on('failed', (job, error) => console.error(`[worker] failed ${job?.id}: ${error.message}`));
emailWorker.on('stalled', (jobId) => console.warn(`[worker] stalled ${jobId}`));
