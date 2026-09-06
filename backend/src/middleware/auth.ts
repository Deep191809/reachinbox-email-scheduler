import type { RequestHandler } from 'express';
import { prisma } from '../config/database.js';
import { readSessionToken } from '../services/auth.service.js';

export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    const userId = readSessionToken(req.cookies?.reachinbox_session);
    if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(401).json({ success: false, message: 'Authentication required' });

    res.locals.user = user;
    next();
  } catch (error) {
    next(error);
  }
};
