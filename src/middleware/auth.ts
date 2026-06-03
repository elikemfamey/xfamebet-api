import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/crypto';
import { supabase } from '../config/supabase';
import { redis, REDIS_KEYS } from '../config/redis';
import { sendError } from '../utils/response';
import { UserRole } from '../types';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: UserRole;
        sessionId: string;
      };
    }
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return sendError(res, 'No token provided', 401);
  }

  const token = authHeader.substring(7);
  try {
    const payload = verifyAccessToken(token);

    const sessionData = await redis.get(REDIS_KEYS.SESSION(payload.sessionId));
    if (!sessionData) {
      return sendError(res, 'Session expired', 401);
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('id, role, account_status')
      .eq('id', payload.userId)
      .single();

    if (error || !user) {
      return sendError(res, 'User not found', 401);
    }

    if (user.account_status === 'banned' || user.account_status === 'suspended') {
      return sendError(res, 'Account suspended', 403);
    }

    req.user = { id: payload.userId, role: payload.role, sessionId: payload.sessionId };
    next();
  } catch {
    return sendError(res, 'Invalid token', 401);
  }
}

export function authorize(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return sendError(res, 'Unauthorized', 401);
    if (!roles.includes(req.user.role)) {
      return sendError(res, 'Insufficient permissions', 403);
    }
    next();
  };
}

export const requireAdmin = authorize('admin', 'super_admin');
export const requireAffiliate = authorize('affiliate', 'admin', 'super_admin');
export const requireFraudAnalyst = authorize('fraud_analyst', 'admin', 'super_admin');
