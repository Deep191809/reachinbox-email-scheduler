import nodemailer from 'nodemailer';
import { prisma } from '../config/database.js';
import { env } from '../config/env.js';
import { indexEmail } from './search.service.js';

const PROCESSING_TIMEOUT_MS = 2 * 60 * 1000;

export async function sendEmail(emailId: string, attemptNumber: number) {
  const email = await prisma.email.findUnique({
    where: { id: emailId },
    include: { sender: true },
  });

  if (!email) throw new Error(`Email ${emailId} was not found`);
  if (email.status === 'SENT') return { skipped: true, messageId: email.messageId };

  const now = new Date();
  const staleProcessing =
    email.status === 'PROCESSING' &&
    email.processingAt &&
    now.getTime() - email.processingAt.getTime() >= PROCESSING_TIMEOUT_MS;

  if (email.status === 'PROCESSING' && !staleProcessing) {
    return { skipped: true, reason: 'already-processing' };
  }

  const claimed = await prisma.email.updateMany({
    where: {
      id: emailId,
      OR: [
        { status: 'SCHEDULED' },
        { status: 'FAILED', attempts: { lt: 2 } },
        { status: 'PROCESSING', processingAt: { lt: new Date(Date.now() - PROCESSING_TIMEOUT_MS) } },
      ],
    },
    data: {
      status: 'PROCESSING',
      processingAt: now,
      attempts: { increment: 1 },
      lastError: null,
    },
  });

  if (claimed.count === 0) {
    const current = await prisma.email.findUnique({ where: { id: emailId } });
    if (current?.status === 'SENT') return { skipped: true, messageId: current.messageId };
    if (current?.status === 'PROCESSING') return { skipped: true, reason: 'already-processing' };
    throw new Error(`Email ${emailId} is not in a sendable state`);
  }

  const transporter = nodemailer.createTransport({
    host: email.sender.smtpHost || env.ETHEREAL_HOST,
    port: email.sender.smtpPort || env.ETHEREAL_PORT,
    secure: Number(email.sender.smtpPort || env.ETHEREAL_PORT) === 465,
    auth: {
      user: email.sender.smtpUser || env.ETHEREAL_USER,
      pass: email.sender.smtpPassword || env.ETHEREAL_PASSWORD,
    },
  });

  const deterministicMessageId = `<reachinbox-${email.id}@reachinbox.local>`;

  try {
    const info = await transporter.sendMail({
      from: email.sender.email,
      to: email.to,
      subject: email.subject,
      text: email.body,
      messageId: deterministicMessageId,
    });

    const providerMessageId = info.messageId || deterministicMessageId;
    await prisma.email.update({
      where: { id: emailId },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        processingAt: null,
        messageId: providerMessageId,
        lastError: null,
      },
    });

    await indexEmail({
      id: email.id,
      userId: email.userId,
      campaignId: email.campaignId,
      senderId: email.senderId,
      to: email.to,
      subject: email.subject,
      body: email.body,
      status: 'SENT',
      scheduledAt: email.scheduledAt.toISOString(),
      sentAt: new Date().toISOString(),
    }).catch((indexError) => console.error('[elasticsearch] failed to index sent email:', indexError));

    return { skipped: false, messageId: providerMessageId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const shouldRetry = attemptNumber + 1 < 2;

    const failureStatus = shouldRetry ? 'SCHEDULED' : 'FAILED';
    await prisma.email.update({
      where: { id: emailId },
      data: {
        status: failureStatus,
        processingAt: null,
        lastError: message,
      },
    });

    if (!shouldRetry) {
      await indexEmail({
        id: email.id,
        userId: email.userId,
        campaignId: email.campaignId,
        senderId: email.senderId,
        to: email.to,
        subject: email.subject,
        body: email.body,
        status: 'FAILED',
        scheduledAt: email.scheduledAt.toISOString(),
      }).catch((indexError) => console.error('[elasticsearch] failed to index failed email:', indexError));
    }
    throw error;
  }
}
