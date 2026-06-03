import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';
import { ZodSchema } from 'zod';
import { sendError } from '../utils/response';

export function validateRequest(req: Request, res: Response, next: NextFunction) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return sendError(res, errors.array()[0].msg, 422);
  }
  next();
}

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return sendError(res, result.error.errors[0].message, 422);
    }
    req.body = result.data;
    next();
  };
}
