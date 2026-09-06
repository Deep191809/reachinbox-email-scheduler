import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from './middleware/auth.js';
import { prisma } from './config/database.js';
import { env } from './config/env.js';

const router = Router();

const createSenderSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().email(),
  smtpUser: z.string().min(1).optional(),
  smtpPassword: z.string().min(1).optional(),
  smtpHost: z.string().min(1).optional(),
  smtpPort: z.coerce.number().int().positive().optional(),
});

router.get('/', requireAuth, async (_req, res, next) => {
  try {
    const senders = await prisma.sender.findMany({
      where: { userId: res.locals.user.id as string },
      select: { id: true, name: true, email: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json(senders);
  } catch (error) {
    next(error);
  }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const parsed = createSenderSchema.parse(req.body);
    const sender = await prisma.sender.create({
      data: {
        userId: res.locals.user.id as string,
        name: parsed.name,
        email: parsed.email,
        smtpHost: parsed.smtpHost ?? env.ETHEREAL_HOST,
        smtpPort: parsed.smtpPort ?? env.ETHEREAL_PORT,
        smtpUser: parsed.smtpUser ?? env.ETHEREAL_USER,
        smtpPassword: parsed.smtpPassword ?? env.ETHEREAL_PASSWORD,
      },
      select: { id: true, name: true, email: true },
    });
    res.status(201).json(sender);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, message: 'Invalid sender details', issues: error.issues });
    }
    next(error);
  }
});

export default router;
