import { prisma } from '../config/database.js';
import { emailQueue } from './email.queue.js';

/**
 * Reconciles durable DB email records with BullMQ after a worker restart.
 * Deterministic job IDs make this safe: an existing BullMQ job is not added twice.
 */
export async function reconcileScheduledEmails() {
  const staleBefore = new Date(Date.now() - 2 * 60 * 1000);

  // A worker can die after claiming an email but before BullMQ gets a chance to retry it.
  // Move only stale PROCESSING records back to SCHEDULED; fresh claims are left alone.
  await prisma.email.updateMany({
    where: { status: 'PROCESSING', processingAt: { lt: staleBefore } },
    data: { status: 'SCHEDULED', processingAt: null },
  });

  const batchSize = 1000;
  let cursor: string | undefined;

  while (true) {
    const emails = await prisma.email.findMany({
      where: { status: 'SCHEDULED' },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    if (emails.length === 0) break;

    await emailQueue.addBulk(
      emails.map((email) => ({
        name: 'send-email',
        data: { emailId: email.id, senderId: email.senderId },
        opts: {
          jobId: `email-${email.id}`,
          delay: Math.max(0, email.scheduledAt.getTime() - Date.now()),
        },
      })),
    );

    cursor = emails[emails.length - 1]?.id;
    if (emails.length < batchSize) break;
  }
}
