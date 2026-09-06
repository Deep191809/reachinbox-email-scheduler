import { Queue } from 'bullmq';
import { bullConnection } from '../config/redis.js';

export const EMAIL_QUEUE = 'email-send';

export type EmailJobData = {
  emailId: string;
  senderId: string;
};

export const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE, {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 86400, count: 5000 },
    removeOnFail: { age: 604800, count: 10000 },
  },
});
