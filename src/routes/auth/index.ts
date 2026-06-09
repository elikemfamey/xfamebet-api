import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { supabase } from '../../config/supabase';
import { redis, REDIS_KEYS } from '../../config/redis';
import {
  hashPassword, comparePassword, signAccessToken,
  signRefreshToken, verifyRefreshToken, hashToken,
  generateReferralCode, generateOtp
} from '../../utils/crypto';
import { sendSuccess, sendError } from '../../utils/response';
import { authenticate } from '../../middleware/auth';
import { authLimiter } from '../../middleware/rateLimiter';
import { validateBody } from '../../middleware/validate';
import { FraudService } from '../../services/fraudService';
import { NotificationService } from '../../services/notificationService';
import { sendOtpSms } from '../../services/smsService';
import { env } from '../../config/env';

const router = Router();

const registerSchema = z.object({
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/),
  email: z.string().email(),
  phone: z.string().optional(),
  password: z.string().min(8).max(100),
  country: z.string().length(2).default('GH'),
  date_of_birth: z.string().optional(),
  referral_code: z.string().optional(),
  promo_code: z.string().optional(),
});

const registerPhoneSchema = z.object({
  phone: z.string().min(10).max(20),
  password: z.string().min(8).max(100),
  country: z.string().length(2).default('GH'),
  referral_code: z.string().optional(),
  promo_code: z.string().optional(),
});

const completeProfileSchema = z.object({
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/).optional(),
  email: z.string().email().optional(),
  full_name: z.string().max(100).optional(),
  date_of_birth: z.string().optional(),
  address: z.string().max(255).optional(),
});

const loginSchema = z.object({
  email: z.string().optional(),
  phone: z.string().optional(),
  password: z.string(),
}).refine(d => d.email || d.phone, { message: 'Email or phone required' });

const otpSchema = z.object({
  user_id: z.string().uuid(),
  otp: z.string().length(6),
});

const resetSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().min(10).max(20).optional(),
}).refine(d => d.email || d.phone, { message: 'Email or phone number required' });

const resetPasswordSchema = z.object({
  token: z.string(),
  password: z.string().min(8),
});

// POST /auth/register
router.post('/register', authLimiter, validateBody(registerSchema), async (req, res) => {
  const { username, email, phone, password, country, date_of_birth, referral_code, promo_code } = req.body;

  try {
    // Check age
    if (date_of_birth) {
      const dob = new Date(date_of_birth);
      const age = Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
      if (age < 18) {
        return sendError(res, 'You must be 18 or older to register', 400);
      }
    }

    // Check duplicate
    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .or(`email.eq.${email},username.eq.${username}`)
      .single();

    if (existing) {
      return sendError(res, 'Email or username already taken', 409);
    }

    // Resolve referral
    let affiliateId: string | null = null;
    let referredById: string | null = null;
    if (referral_code) {
      const { data: refUser } = await supabase
        .from('users')
        .select('id')
        .eq('referral_code', referral_code)
        .single();
      if (refUser) {
        referredById = refUser.id;
        const { data: aff } = await supabase
          .from('affiliates')
          .select('id')
          .eq('user_id', refUser.id)
          .single();
        affiliateId = aff?.id ?? null;
      }
    }

    const password_hash = await hashPassword(password);
    const newReferralCode = generateReferralCode();

    const { data: user, error } = await supabase.from('users').insert({
      username,
      email,
      phone,
      password_hash,
      country,
      referral_code: newReferralCode,
      referred_by: referredById,
      affiliate_id: affiliateId,
      date_of_birth,
      age_verified: !!date_of_birth,
    }).select().single();

    if (error || !user) {
      return sendError(res, 'Registration failed', 500);
    }

    // Generate and store OTP
    const otp = generateOtp();
    await redis.setex(REDIS_KEYS.OTP(user.id), 600, otp);

    // Track fraud event
    await FraudService.emitEvent(user.id, 'registration', {
      ip: req.ip,
      device: req.headers['user-agent'],
      referral_code,
    });

    // Track affiliate click conversion and create referral record
    if (affiliateId && referral_code) {
      await Promise.all([
        supabase.from('affiliate_clicks')
          .update({ converted: true, converted_user_id: user.id })
          .eq('referral_code', referral_code)
          .is('converted_user_id', null)
          .order('created_at', { ascending: false })
          .limit(1),
        supabase.from('affiliate_referrals').insert({
          affiliate_id: affiliateId,
          referred_user_id: user.id,
        }),
      ]);
    }

    // Apply promo code bonus
    if (promo_code) {
      const { data: promo } = await supabase
        .from('promo_codes')
        .select('*')
        .eq('code', promo_code.toUpperCase())
        .eq('status', 'active')
        .single();

      if (promo && (!promo.usage_limit || promo.used_count < promo.usage_limit)) {
        const { data: wallet } = await supabase
          .from('wallets').select('id').eq('user_id', user.id).single();

        if (wallet) {
          await supabase.from('user_bonus_grants').insert({
            user_id: user.id,
            promo_code_id: promo.id,
            amount: promo.value,
            wagering_required: promo.value * 3,
          });
          await supabase.rpc('credit_bonus', { p_wallet_id: wallet.id, p_amount: promo.value });
          await supabase.from('promo_codes').update({ used_count: promo.used_count + 1 }).eq('id', promo.id);
        }
      }
    }

    logger.info('dev_otp', { otp, user_id: user.id });

    return sendSuccess(res, {
      user_id: user.id,
      message: 'Registration successful. Please verify your OTP.',
      otp: env.NODE_ENV !== 'production' ? otp : undefined,
    }, 201);

  } catch (err) {
    logger.error('Register error', { err });
    return sendError(res, 'Registration failed', 500);
  }
});

// POST /auth/verify-otp
router.post('/verify-otp', authLimiter, validateBody(otpSchema), async (req, res) => {
  const { user_id, otp } = req.body;

  // Pending phone registration (user not yet in DB)
  const pendingRaw = await redis.get(REDIS_KEYS.PENDING_REG(user_id));
  if (pendingRaw) {
    const pending = JSON.parse(pendingRaw) as {
      phone: string; password_hash: string; country: string; username: string;
      referral_code: string | null; promo_code: string | null; new_referral_code: string; otp: string;
    };

    if (pending.otp !== otp) return sendError(res, 'Invalid or expired OTP', 400);

    // Resolve referral
    let affiliateId: string | null = null;
    let referredById: string | null = null;
    if (pending.referral_code) {
      const { data: refUser } = await supabase.from('users').select('id').eq('referral_code', pending.referral_code).single();
      if (refUser) {
        referredById = refUser.id;
        const { data: aff } = await supabase.from('affiliates').select('id').eq('user_id', refUser.id).single();
        affiliateId = aff?.id ?? null;
      }
    }

    const { data: user, error } = await supabase.from('users').insert({
      username: pending.username,
      phone: pending.phone,
      phone_verified: true,
      password_hash: pending.password_hash,
      country: pending.country,
      referral_code: pending.new_referral_code,
      referred_by: referredById,
      affiliate_id: affiliateId,
    }).select().single();

    if (error || !user) return sendError(res, 'Registration failed', 500);

    await redis.del(REDIS_KEYS.PENDING_REG(user_id));

    // Apply promo code
    if (pending.promo_code) {
      const { data: promo } = await supabase.from('promo_codes').select('*').eq('code', pending.promo_code.toUpperCase()).eq('status', 'active').single();
      if (promo && (!promo.usage_limit || promo.used_count < promo.usage_limit)) {
        const { data: wallet } = await supabase.from('wallets').select('id').eq('user_id', user.id).single();
        if (wallet) {
          await supabase.from('user_bonus_grants').insert({ user_id: user.id, promo_code_id: promo.id, amount: promo.value, wagering_required: promo.value * 3 });
          await supabase.rpc('credit_bonus', { p_wallet_id: wallet.id, p_amount: promo.value });
          await supabase.from('promo_codes').update({ used_count: promo.used_count + 1 }).eq('id', promo.id);
        }
      }
    }

    FraudService.emitEvent(user.id, 'registration', { ip: req.ip, device: req.headers['user-agent'], phone: pending.phone }).catch(
      (err) => logger.error('verify-otp fraud event failed', { err })
    );

    if (affiliateId && pending.referral_code) {
      await Promise.all([
        supabase.from('affiliate_clicks')
          .update({ converted: true, converted_user_id: user.id })
          .eq('referral_code', pending.referral_code)
          .is('converted_user_id', null)
          .order('created_at', { ascending: false })
          .limit(1),
        supabase.from('affiliate_referrals').insert({ affiliate_id: affiliateId, referred_user_id: user.id }),
      ]);
    }

    return sendSuccess(res, { message: 'OTP verified successfully' });
  }

  // Existing DB user OTP (email registration, re-verification, etc.)
  const storedOtp = await redis.get(REDIS_KEYS.OTP(user_id));
  if (!storedOtp || storedOtp !== otp) return sendError(res, 'Invalid or expired OTP', 400);

  await supabase.from('users').update({ phone_verified: true }).eq('id', user_id);
  await redis.del(REDIS_KEYS.OTP(user_id));

  return sendSuccess(res, { message: 'OTP verified successfully' });
});

// Normalise a raw phone string and look up user
async function findUserByPhone(rawPhone: string) {
  // 1. Exact match
  const { data: exact } = await supabase.from('users').select('*').eq('phone', rawPhone).single();
  if (exact) return exact;

  // 2. Add leading + if missing and retry
  if (!rawPhone.startsWith('+')) {
    const { data: withPlus } = await supabase.from('users').select('*').eq('phone', `+${rawPhone}`).single();
    if (withPlus) return withPlus;
  }

  return null;
}

// POST /auth/login
router.post('/login', authLimiter, validateBody(loginSchema), async (req, res) => {
  const { email, phone, password } = req.body;

  const user = email
    ? (await supabase.from('users').select('*').eq('email', email).single()).data
    : await findUserByPhone(phone);

  if (!user || !user.password_hash) {
    return sendError(res, 'Invalid credentials', 401);
  }

  if (user.account_status === 'banned') {
    return sendError(res, 'Account has been banned', 403);
  }

  if (user.account_status === 'suspended') {
    return sendError(res, 'Account is suspended', 403);
  }

  const valid = await comparePassword(password, user.password_hash);
  if (!valid) {
    await FraudService.emitEvent(user.id, 'failed_login', { ip: req.ip });
    return sendError(res, 'Invalid credentials', 401);
  }

  const sessionId = uuidv4();
  const accessToken = signAccessToken({ userId: user.id, role: user.role, sessionId });
  const refreshToken = signRefreshToken({ userId: user.id, sessionId });

  // Store session in Redis (7 days)
  await redis.setex(REDIS_KEYS.SESSION(sessionId), 7 * 24 * 3600, JSON.stringify({
    userId: user.id,
    role: user.role,
  }));

  // Store session in DB
  await supabase.from('sessions').insert({
    id: sessionId,
    user_id: user.id,
    token_hash: hashToken(accessToken),
    ip_address: req.ip,
    user_agent: req.headers['user-agent'],
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
  });

  await supabase.from('users').update({
    last_login_at: new Date().toISOString(),
    last_login_ip: req.ip,
  }).eq('id', user.id);

  await FraudService.emitEvent(user.id, 'login', { ip: req.ip, device: req.headers['user-agent'] });

  return sendSuccess(res, {
    access_token: accessToken,
    refresh_token: refreshToken,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      kyc_status: user.kyc_status,
      account_status: user.account_status,
      two_fa_enabled: user.two_fa_enabled,
    },
  });
});

// POST /auth/refresh
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return sendError(res, 'Refresh token required', 400);

  try {
    const payload = verifyRefreshToken(refresh_token);
    const sessionData = await redis.get(REDIS_KEYS.SESSION(payload.sessionId));
    if (!sessionData) return sendError(res, 'Session expired', 401);

    const session = JSON.parse(sessionData);
    const newSessionId = uuidv4();
    const newAccessToken = signAccessToken({ userId: session.userId, role: session.role, sessionId: newSessionId });
    const newRefreshToken = signRefreshToken({ userId: session.userId, sessionId: newSessionId });

    await redis.del(REDIS_KEYS.SESSION(payload.sessionId));
    await redis.setex(REDIS_KEYS.SESSION(newSessionId), 7 * 24 * 3600, JSON.stringify(session));

    return sendSuccess(res, { access_token: newAccessToken, refresh_token: newRefreshToken });
  } catch {
    return sendError(res, 'Invalid refresh token', 401);
  }
});

// POST /auth/logout
router.post('/logout', authenticate, async (req, res) => {
  await redis.del(REDIS_KEYS.SESSION(req.user!.sessionId));
  await supabase.from('sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', req.user!.sessionId);
  return sendSuccess(res, { message: 'Logged out successfully' });
});

// POST /auth/reset-password (request)
router.post('/reset-password', authLimiter, validateBody(resetSchema), async (req, res) => {
  const { email, phone } = req.body;

  if (phone) {
    const cooldown = await redis.get(REDIS_KEYS.OTP_COOLDOWN(phone));
    if (cooldown) return sendError(res, 'Please wait 60 seconds before requesting another reset code', 429);
  }

  const query = supabase.from('users').select('id, phone, country');
  const { data: user } = email
    ? await query.eq('email', email).single()
    : await query.eq('phone', phone).single();

  if (user) {
    const otp = generateOtp();
    await redis.setex(`pwd_reset:${user.id}`, 600, otp);

    if (user.phone) {
      try {
        await sendOtpSms(user.phone, otp, user.country ?? 'GH');
        await redis.setex(REDIS_KEYS.OTP_COOLDOWN(user.phone), 60, '1');
      } catch (smsErr) {
        logger.error('reset-password sms failed', { smsErr, phone: user.phone });
      }
    } else {
      logger.info('pwd_reset_otp', { otp, user_id: user.id });
    }
  }

  return sendSuccess(res, {
    message: 'If that account exists, a reset code has been sent.',
    user_id: user?.id ?? null,
  });
});

// POST /auth/reset-password/confirm
router.post('/reset-password/confirm', authLimiter, validateBody(resetPasswordSchema), async (req, res) => {
  const { token, password } = req.body;
  const [userId, otp] = token.split(':');

  const storedOtp = await redis.get(`pwd_reset:${userId}`);
  if (!storedOtp || storedOtp !== otp) {
    return sendError(res, 'Invalid or expired reset token', 400);
  }

  const hash = await hashPassword(password);
  await supabase.from('users').update({ password_hash: hash }).eq('id', userId);
  await redis.del(`pwd_reset:${userId}`);

  // Revoke all sessions
  const sessions = await redis.keys(`session:*`);
  for (const key of sessions) {
    const data = await redis.get(key);
    if (data) {
      const parsed = JSON.parse(data);
      if (parsed.userId === userId) await redis.del(key);
    }
  }

  return sendSuccess(res, { message: 'Password reset successful' });
});

// GET /auth/me
router.get('/me', authenticate, async (req, res) => {
  const { data: user } = await supabase
    .from('users')
    .select('id, username, email, phone, country, referral_code, kyc_status, account_status, role, date_of_birth, two_fa_enabled, email_verified, created_at')
    .eq('id', req.user!.id)
    .single();

  if (!user) return sendError(res, 'User not found', 404);
  return sendSuccess(res, user);
});

// POST /auth/send-otp
router.post('/send-otp', authenticate, async (req, res) => {
  const { data: user } = await supabase.from('users').select('phone, country').eq('id', req.user!.id).single();
  if (!user?.phone) return sendError(res, 'No phone number on this account', 400);

  const cooldown = await redis.get(REDIS_KEYS.OTP_COOLDOWN(user.phone));
  if (cooldown) return sendError(res, 'Please wait 60 seconds before requesting another OTP', 429);

  const otp = generateOtp();
  await redis.setex(REDIS_KEYS.OTP(req.user!.id), 600, otp);
  try {
    await sendOtpSms(user.phone, otp, user.country ?? 'GH');
    await redis.setex(REDIS_KEYS.OTP_COOLDOWN(user.phone), 60, '1');
  } catch (smsErr) {
    logger.error('send-otp sms failed', { smsErr, phone: user.phone });
    return sendError(res, 'SMS delivery failed. Please try again.', 503);
  }

  return sendSuccess(res, { message: 'OTP sent' });
});

// POST /auth/register-phone — Step 1: phone + password → store pending in Redis → send OTP
// User is NOT written to DB until OTP is verified
router.post('/register-phone', authLimiter, validateBody(registerPhoneSchema), async (req, res) => {
  const { phone, password, country, referral_code, promo_code } = req.body;

  try {
    const cooldown = await redis.get(REDIS_KEYS.OTP_COOLDOWN(phone));
    if (cooldown) return sendError(res, 'Please wait 60 seconds before requesting another OTP', 429);

    const { data: existing } = await supabase.from('users').select('id').eq('phone', phone).single();
    if (existing) return sendError(res, 'Phone number already registered', 409);

    const suffix = Math.random().toString(36).slice(2, 7);
    const username = `user_${phone.replace(/\D/g, '').slice(-6)}_${suffix}`;
    const password_hash = await hashPassword(password);
    const newReferralCode = generateReferralCode();
    const pending_id = uuidv4();
    const otp = generateOtp();

    await redis.setex(
      REDIS_KEYS.PENDING_REG(pending_id),
      600,
      JSON.stringify({ phone, password_hash, country, username, referral_code: referral_code ?? null, promo_code: promo_code ?? null, new_referral_code: newReferralCode, otp }),
    );

    let smsSent = true;
    try {
      await sendOtpSms(phone, otp, country);
      await redis.setex(REDIS_KEYS.OTP_COOLDOWN(phone), 60, '1');
    } catch (smsErr) {
      logger.error('register-phone sms failed', { smsErr, phone });
      smsSent = false;
    }

    return sendSuccess(res, {
      user_id: pending_id,
      sms_sent: smsSent,
      message: smsSent ? 'OTP sent to your phone number.' : 'SMS delivery failed. Tap "Resend OTP" to try again.',
      otp: env.NODE_ENV !== 'production' ? otp : undefined,
    }, smsSent ? 201 : 202);
  } catch (err) {
    logger.error('register-phone error', { err });
    return sendError(res, 'Registration failed', 500);
  }
});

// POST /auth/resend-otp — unauthenticated resend during registration
const resendOtpSchema = z.object({ user_id: z.string().uuid() });

router.post('/resend-otp', authLimiter, validateBody(resendOtpSchema), async (req, res) => {
  const { user_id } = req.body;

  // Pending registration (user not yet in DB)
  const pendingRaw = await redis.get(REDIS_KEYS.PENDING_REG(user_id));
  if (pendingRaw) {
    const pending = JSON.parse(pendingRaw) as { phone: string; country: string; otp: string; [key: string]: unknown };

    const cooldown = await redis.get(REDIS_KEYS.OTP_COOLDOWN(pending.phone));
    if (cooldown) return sendError(res, 'Please wait 60 seconds before requesting another OTP', 429);

    const otp = generateOtp();
    pending.otp = otp;
    // Reset the 10-min TTL with updated OTP
    await redis.setex(REDIS_KEYS.PENDING_REG(user_id), 600, JSON.stringify(pending));
    let smsSent = true;
    try {
      await sendOtpSms(pending.phone, otp, pending.country ?? 'GH');
      await redis.setex(REDIS_KEYS.OTP_COOLDOWN(pending.phone), 60, '1');
    } catch (smsErr) {
      logger.error('resend-otp sms failed', { smsErr, phone: pending.phone });
      smsSent = false;
    }

    return sendSuccess(res, {
      sms_sent: smsSent,
      message: smsSent ? 'OTP resent' : 'SMS delivery failed. Please try again shortly.',
      otp: env.NODE_ENV !== 'production' ? otp : undefined,
    }, smsSent ? 200 : 503);
  }

  // Fallback: existing DB user (e.g. email-registered user needing phone OTP)
  const { data: user } = await supabase.from('users').select('phone, country, phone_verified').eq('id', user_id).single();
  if (!user?.phone) return sendError(res, 'Registration session expired. Please start over.', 404);
  if (user.phone_verified) return sendError(res, 'Phone already verified', 400);

  const cooldown = await redis.get(REDIS_KEYS.OTP_COOLDOWN(user.phone));
  if (cooldown) return sendError(res, 'Please wait 60 seconds before requesting another OTP', 429);

  const otp = generateOtp();
  await redis.setex(REDIS_KEYS.OTP(user_id), 600, otp);
  try {
    await sendOtpSms(user.phone, otp, user.country ?? 'GH');
    await redis.setex(REDIS_KEYS.OTP_COOLDOWN(user.phone), 60, '1');
  } catch (smsErr) {
    logger.error('resend-otp (db user) sms failed', { smsErr, phone: user.phone });
    return sendError(res, 'SMS delivery failed. Please try again shortly.', 503);
  }

  return sendSuccess(res, {
    message: 'OTP resent',
    otp: env.NODE_ENV !== 'production' ? otp : undefined,
  });
});

// POST /auth/verify-otp also marks phone_verified after phone registration
// Handled by existing /verify-otp route — no change needed

// POST /auth/complete-profile — Step 3: fill in username, email, DOB etc. (requires auth)
router.post('/complete-profile', authenticate, validateBody(completeProfileSchema), async (req, res) => {
  const { username, email, full_name, date_of_birth, address } = req.body;

  try {
    if (username) {
      const { data: taken } = await supabase.from('users').select('id').eq('username', username).neq('id', req.user!.id).single();
      if (taken) return sendError(res, 'Username already taken', 409);
    }
    if (email) {
      const { data: taken } = await supabase.from('users').select('id').eq('email', email).neq('id', req.user!.id).single();
      if (taken) return sendError(res, 'Email already in use', 409);
    }
    if (date_of_birth) {
      const dob = new Date(date_of_birth);
      const age = Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
      if (age < 18) return sendError(res, 'You must be 18 or older', 400);
    }

    const updates: Record<string, unknown> = {};
    if (username) updates.username = username;
    if (email) updates.email = email;
    if (full_name) updates.full_name = full_name;
    if (date_of_birth) { updates.date_of_birth = date_of_birth; updates.age_verified = true; }
    if (address) updates.address = address;

    if (Object.keys(updates).length === 0) return sendSuccess(res, { message: 'No changes' });

    const { error } = await supabase.from('users').update(updates).eq('id', req.user!.id);
    if (error) return sendError(res, 'Profile update failed', 500);

    return sendSuccess(res, { message: 'Profile updated successfully' });
  } catch (err) {
    logger.error('complete-profile error', { err });
    return sendError(res, 'Profile update failed', 500);
  }
});

export default router;

// helper (referenced from index but defined here for access)
const logger = { info: (m: string, d?: unknown) => console.log(`[AUTH] ${m}`, d), error: (m: string, d?: unknown) => console.error(`[AUTH] ${m}`, d) };
