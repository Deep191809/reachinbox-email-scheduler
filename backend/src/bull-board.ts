import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import type { Request, Response, NextFunction } from 'express';
import { emailQueue } from './queues/email.queue.js';
import { env } from './config/env.js';

function basicAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="BullMQ"');
    return res.status(401).send('Authentication required');
  }

  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  const username = separator >= 0 ? decoded.slice(0, separator) : '';
  const password = separator >= 0 ? decoded.slice(separator + 1) : '';

  if (username !== env.BULL_BOARD_USERNAME || password !== env.BULL_BOARD_PASSWORD) {
    res.setHeader('WWW-Authenticate', 'Basic realm="BullMQ"');
    return res.status(401).send('Invalid credentials');
  }

  next();
}

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [new BullMQAdapter(emailQueue)],
  serverAdapter,
});

export { basicAuth, serverAdapter };
