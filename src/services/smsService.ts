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

export async function sendOtpSms(phone: string, otp: string): Promise<void> {
  if (env.NODE_ENV !== 'production') {
    logger.info('sms_skipped_dev', { phone, otp });
    return;
  }

  const message = `Your XfameBet code is: ${otp}. Valid for 10 mins. Never share this code.`;

  const result = await sms.send({
    to: [phone],
    message,
    ...(env.AT_SENDER_ID ? { from: env.AT_SENDER_ID } : {}),
  });

  const recipient = result.SMSMessageData.Recipients[0];
  if (!recipient || recipient.status !== 'Success') {
    logger.error('sms_delivery_failed', { phone, status: recipient?.status });
    throw new Error('SMS delivery failed. Please try again.');
  }

  logger.info('sms_sent', { phone });
}
