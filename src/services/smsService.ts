import axios from 'axios';
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

// Statuses from Africa's Talking that Termii can recover from
const TERMII_FALLBACK_STATUSES = new Set(['DoNotDisturbRejection', 'UserInBlacklist']);

function toE164(phone: string, country = 'GH'): string {
  const cleaned = phone.replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  const code = COUNTRY_CODES[country] ?? '233';
  if (cleaned.startsWith('0')) return `+${code}${cleaned.slice(1)}`;
  if (cleaned.startsWith(code)) return `+${cleaned}`;
  return `+${code}${cleaned}`;
}

// Nigeria uses "dnd" channel to bypass NCC DND registry; all others use "generic"
function termiiChannel(phone: string): 'dnd' | 'generic' {
  return phone.startsWith('+234') ? 'dnd' : 'generic';
}

async function sendViaTermii(phone: string, message: string): Promise<void> {
  if (!env.TERMII_API_KEY) {
    throw new Error('Termii API key not configured');
  }

  const channel = termiiChannel(phone);

  // DND channel (Nigeria) requires a Termii-registered sender — omit `from`
  // to use Termii's pre-approved default transactional sender for NG DND routing.
  // For generic channel, use the configured sender ID if set.
  const from = channel === 'dnd' ? undefined : (env.TERMII_SENDER_ID || undefined);

  const { data } = await axios.post(
    'https://v3.api.termii.com/api/sms/send',
    {
      to: phone,
      ...(from ? { from } : {}),
      sms: message,
      type: 'plain',
      channel,
      api_key: env.TERMII_API_KEY,
    },
    { timeout: 10000 },
  );

  // Termii returns 200 even for some failures — check the message field
  if (!data?.message_id && data?.message !== 'Successfully Sent') {
    throw new Error(`Termii delivery failed: ${data?.message ?? 'unknown error'}`);
  }

  logger.info('sms_sent_termii', { phone, channel });
}

export class SmsError extends Error {
  permanent: boolean;
  constructor(message: string, permanent: boolean) {
    super(message);
    this.permanent = permanent;
  }
}

export async function sendOtpSms(phone: string, otp: string, country = 'GH'): Promise<void> {
  if (env.NODE_ENV !== 'production' || !env.AT_API_KEY) {
    logger.info('sms_skipped', { phone, otp, reason: env.NODE_ENV !== 'production' ? 'dev' : 'no_api_key' });
    return;
  }

  const normalizedPhone = toE164(phone, country);
  const message = `Your XfameBet code is: ${otp}. Valid for 10 mins. Never share this code.`;

  // --- Try Africa's Talking first ---
  let atStatus: string | undefined;
  try {
    const result = await sms.send({
      to: [normalizedPhone],
      message,
      ...(env.AT_SENDER_ID ? { from: env.AT_SENDER_ID } : {}),
    });

    const recipient = result.SMSMessageData.Recipients[0];
    atStatus = recipient?.status;

    if (recipient?.status === 'Success') {
      logger.info('sms_sent', { phone: normalizedPhone, provider: 'africastalking' });
      return;
    }

    logger.warn('sms_at_failed', { phone: normalizedPhone, status: atStatus });
  } catch (err) {
    logger.warn('sms_at_error', { phone: normalizedPhone, err });
  }

  // --- Fallback to Termii for DND/blacklist rejections or AT errors ---
  if (!atStatus || TERMII_FALLBACK_STATUSES.has(atStatus)) {
    try {
      await sendViaTermii(normalizedPhone, message);
      return;
    } catch (termiiErr) {
      logger.error('sms_termii_failed', { phone: normalizedPhone, termiiErr });
    }
  }

  // Both providers failed — classify the error
  logger.error('sms_delivery_failed', { phone: normalizedPhone, status: atStatus });
  const permanent = atStatus === 'DoNotDisturbRejection' || atStatus === 'UserInBlacklist';
  throw new SmsError(
    permanent
      ? 'SMS is blocked on this number by your carrier. Please contact support.'
      : 'SMS delivery failed. Please try again.',
    permanent,
  );
}
