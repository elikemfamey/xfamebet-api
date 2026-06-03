import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '../config/env';
import { JwtPayload } from '../types';

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);
}

export function signRefreshToken(payload: Pick<JwtPayload, 'userId' | 'sessionId'>): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: '30d' } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
}

export function verifyRefreshToken(token: string): Pick<JwtPayload, 'userId' | 'sessionId'> {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as Pick<JwtPayload, 'userId' | 'sessionId'>;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateReferralCode(): string {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

export function generateOtp(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

export function verifyPaystackSignature(payload: string, signature: string): boolean {
  const hash = crypto
    .createHmac('sha512', env.PAYSTACK_WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
  return hash === signature;
}
