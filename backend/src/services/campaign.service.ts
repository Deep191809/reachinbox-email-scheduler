import { prisma } from '../config/database.js';
import { emailQueue } from '../queues/email.queue.js';
import { indexEmail } from './search.service.js';

export type CreateCampaignInput = {
  userId: string;
  senderId: string;
  subject: string;
  body: string;
  startTime: Date;
  delayMs: number;
  hourlyLimit: number;
  recipients: string[];
};

export async function createCampaign(input: CreateCampaignInput) {
  const sender = await prisma.sender.findFirst({ where: { id: input.senderId, userId: input.userId } });
  if (!sender) throw new Error('Sender not found');

  if (input.startTime.getTime() <= Date.now()) throw new Error('Start time must be in the future');
  if (input.recipients.length === 0) throw new Error('At least one recipient is required');

  const campaign = await prisma.campaign.create({
    data: {
      userId: input.userId,
      senderId: input.senderId,
      subject: input.subject,
      body: input.body,
      startTime: input.startTime,
      delayMs: input.delayMs,
      hourlyLimit: input.hourlyLimit,
    },
  });

  const uniqueRecipients = [...new Set(input.recipients.map((email) => email.trim().toLowerCase()))];
  const emails = await prisma.email.createManyAndReturn({
    data: uniqueRecipients.map((to, index) => ({
      userId: input.userId,
      campaignId: campaign.id,
      senderId: input.senderId,
      to,
      subject: input.subject,
      body: input.body,
      scheduledAt: new Date(input.startTime.getTime() + index * input.delayMs),
    })),
  });

  await Promise.allSettled(
    emails.map((email) => indexEmail({
      id: email.id,
      userId: email.userId,
      campaignId: email.campaignId,
      senderId: email.senderId,
      to: email.to,
      subject: email.subject,
      body: email.body,
      status: email.status,
      scheduledAt: email.scheduledAt.toISOString(),
    })),
  );

  await emailQueue.addBulk(
    emails.map((email) => ({
      name: 'send-email',
      data: { emailId: email.id, senderId: input.senderId },
      opts: {
	jobId: `email-${email.id}`,        
delay: Math.max(0, email.scheduledAt.getTime() - Date.now()),
      },
    })),
  );

  return { campaign, emails };
}
