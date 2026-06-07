import { Request, Response, NextFunction, RequestHandler } from 'express';
import { ApiResponse } from '../types';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export function asyncHandler(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function sendSuccess<T>(res: Response, data: T, statusCode = 200, message?: string) {
  const response: ApiResponse<T> = { success: true, data, message };
  return res.status(statusCode).json(response);
}

export function sendError(res: Response, error: string, statusCode = 400) {
  const response: ApiResponse = { success: false, error };
  return res.status(statusCode).json(response);
}

export function sendPaginated<T>(
  res: Response,
  data: T[],
  total: number,
  page: number,
  limit: number
) {
  const response: ApiResponse<T[]> = {
    success: true,
    data,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
  return res.status(200).json(response);
}
