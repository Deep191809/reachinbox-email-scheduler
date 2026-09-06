import { Router } from 'express';
import { z } from 'zod';
import { createCampaign } from './services/campaign.service.js';
import { searchEmails } from './services/search.service.js';
import { requireAuth } from './middleware/auth.js';

const router = Router();

const createCampaignSchema = z.object({
  senderId: z.string().min(1),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1),
  startTime: z.coerce.date(),
  delayMs: z.number().int().min(100),
  hourlyLimit: z.number().int().positive(),
  recipients: z.array(z.string().email()).min(1).max(10000),
});

router.post('/campaigns', requireAuth, async (req, res, next) => {
  try {
    const parsed = createCampaignSchema.parse(req.body);
    const input = { ...parsed, userId: res.locals.user.id as string };
    const result = await createCampaign(input);
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ success: false, message: 'Invalid request', issues: error.issues });
    }
    next(error);
  }
});

router.get('/emails/search', requireAuth, async (req, res, next) => {
  try {
    const userId = res.locals.user.id as string;
    const query = String(req.query.q || '');
    res.json(await searchEmails(userId, query));
  } catch (error) {
    next(error);
  }
});

export default router;
