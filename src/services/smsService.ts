import { env } from '../config/env';
import { logger } from '../utils/logger';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AfricasTalking = require('africastalking') as (opts: {
  apiKey: string;
  username: string;
}) => {
  SMS: {
    send: (opts: {
      to: string[];
      message: string;
      from?: string;
    }) => Promise<{ SMSMessageData: { Recipients: { status: string; number: string }[] } }>;
  };
};

const at = AfricasTalking({
  apiKey: env.AT_API_KEY,
  username: env.AT_USERNAME,
});

const sms = at.SMS;

const COUNTRY_CODES: Record<string, string> = {
  GH: '233',
  NG: '234',
  KE: '254',
  ZA: '27',
  TZ: '255',
  UG: '256',
  ZM: '260',
  RW: '250',
};

// Normalizes any phone format to E.164 (required by Africa's Talking)
// e.g. "0244123456" (GH) → "+233244123456"
function toE164(phone: string, country = 'GH'): string {
  const cleaned = phone.replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  const code = COUNTRY_CODES[country] ?? '233';
  if (cleaned.startsWith('0')) return `+${code}${cleaned.slice(1)}`;
  if (cleaned.startsWith(code)) return `+${cleaned}`;
  return `+${code}${cleaned}`;
}

export async function sendOtpSms(phone: string, otp: string, country = 'GH'): Promise<void> {
  if (env.NODE_ENV !== 'production' || !env.AT_API_KEY) {
    logger.info('sms_skipped', { phone, otp, reason: env.NODE_ENV !== 'production' ? 'dev' : 'no_api_key' });
    return;
  }

  const normalizedPhone = toE164(phone, country);
  const message = `Your XfameBet code is: ${otp}. Valid for 10 mins. Never share this code.`;

  const result = await sms.send({
    to: [normalizedPhone],
    message,
    ...(env.AT_SENDER_ID ? { from: env.AT_SENDER_ID } : {}),
  });

  const recipient = result.SMSMessageData.Recipients[0];
  if (!recipient || recipient.status !== 'Success') {
    logger.error('sms_delivery_failed', { phone: normalizedPhone, status: recipient?.status });
    throw new Error('SMS delivery failed. Please try again.');
  }

  logger.info('sms_sent', { phone: normalizedPhone });
}
