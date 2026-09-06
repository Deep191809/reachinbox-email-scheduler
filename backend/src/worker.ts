import { ensureEmailIndex } from './services/search.service.js';
import { reconcileScheduledEmails } from './queues/email.recovery.js';
import './queues/email.worker.js';

async function start() {
  try {
    await ensureEmailIndex();
    await reconcileScheduledEmails();
    console.log('Email worker started and scheduled jobs reconciled');
  } catch (error) {
    console.error('Worker startup reconciliation failed:', error);
    process.exitCode = 1;
  }
}

void start();
