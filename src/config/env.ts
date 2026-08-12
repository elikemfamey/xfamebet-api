import dotenv from 'dotenv';
dotenv.config();

export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '4000', 10),

  SUPABASE_URL: process.env.SUPABASE_URL!,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY!,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY!,

  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

  JWT_SECRET: process.env.JWT_SECRET!,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET!,

  PAYSTACK_SECRET_KEY: process.env.PAYSTACK_SECRET_KEY!,
  PAYSTACK_PUBLIC_KEY: process.env.PAYSTACK_PUBLIC_KEY!,
  PAYSTACK_WEBHOOK_SECRET: process.env.PAYSTACK_WEBHOOK_SECRET!,

  // Moolre collection API. These must only exist on the API server.
  MOOLRE_API_USER: process.env.MOOLRE_API_USER || '',
  MOOLRE_PUBLIC_KEY: process.env.MOOLRE_PUBLIC_KEY || '',
  MOOLRE_ACCOUNT_NUMBER: process.env.MOOLRE_ACCOUNT_NUMBER || '',
  MOOLRE_BUSINESS_EMAIL: process.env.MOOLRE_BUSINESS_EMAIL || '',

  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
  API_URL: process.env.API_URL || 'http://localhost:4000',

  SMTP_HOST: process.env.SMTP_HOST || '',
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '587', 10),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  SMTP_FROM: process.env.SMTP_FROM || 'support@primewin.site',

  CRYPTO_WALLET_ADDRESS: process.env.CRYPTO_WALLET_ADDRESS || '',
  BINANCE_UID: process.env.BINANCE_UID || '',
  BINANCE_NAME: process.env.BINANCE_NAME || '',

  // Company collection details for manual deposits
  COMPANY_MOMO_NETWORK: process.env.COMPANY_MOMO_NETWORK || 'TELECEL / VODAFONE GHANA',
  COMPANY_MOMO_NAME: process.env.COMPANY_MOMO_NAME || 'MARFO JEFFERY APPIAGYEI',
  COMPANY_MOMO_NUMBER: process.env.COMPANY_MOMO_NUMBER || '0502119157',
  COMPANY_BANK_NAME: process.env.COMPANY_BANK_NAME || '',
  COMPANY_BANK_ACCOUNT_NAME: process.env.COMPANY_BANK_ACCOUNT_NAME || '',
  COMPANY_BANK_ACCOUNT_NUMBER: process.env.COMPANY_BANK_ACCOUNT_NUMBER || '',
  COMPANY_BANK_CURRENCY: process.env.COMPANY_BANK_CURRENCY || 'NGN',

  ODDS_API_KEY: process.env.ODDS_API_KEY || '',
  // Odds-API.io is a separate provider from The Odds API above. Keep this
  // server-only; it must never be exposed through the web application.
  ODDS_API_IO_KEY: process.env.ODDS_API_IO_KEY || '',
  API_FOOTBALL_KEY: process.env.API_FOOTBALL_KEY || '',
  SPORTMONKS_API_TOKEN: process.env.SPORTMONKS_API_TOKEN || '',

  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  RATE_LIMIT_MAX_REQUESTS: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  AUTH_RATE_LIMIT_WINDOW_MS: parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS || '900000', 10),
  AUTH_RATE_LIMIT_MAX_REQUESTS: parseInt(process.env.AUTH_RATE_LIMIT_MAX_REQUESTS || '20', 10),
  BET_RATE_LIMIT_WINDOW_MS: parseInt(process.env.BET_RATE_LIMIT_WINDOW_MS || '60000', 10),
  BET_RATE_LIMIT_MAX_REQUESTS: parseInt(process.env.BET_RATE_LIMIT_MAX_REQUESTS || '30', 10),
  TEAM_LOGO_RATE_LIMIT_WINDOW_MS: parseInt(process.env.TEAM_LOGO_RATE_LIMIT_WINDOW_MS || '60000', 10),
  TEAM_LOGO_RATE_LIMIT_MAX_REQUESTS: parseInt(process.env.TEAM_LOGO_RATE_LIMIT_MAX_REQUESTS || '120', 10),
  // Payment requests are scoped to a signed-in account and stored in Redis so
  // the allowance remains consistent when the API runs on multiple instances.
  PAYMENT_RATE_LIMIT_WINDOW_MS: parseInt(process.env.PAYMENT_RATE_LIMIT_WINDOW_MS || '3600000', 10),
  PAYMENT_RATE_LIMIT_MAX_REQUESTS: parseInt(process.env.PAYMENT_RATE_LIMIT_MAX_REQUESTS || '30', 10),

  AT_API_KEY: process.env.AT_API_KEY || '',
  AT_USERNAME: process.env.AT_USERNAME || 'sandbox',
  AT_SENDER_ID: process.env.AT_SENDER_ID || '',

  TERMII_API_KEY: process.env.TERMII_API_KEY || '',
  TERMII_SENDER_ID: process.env.TERMII_SENDER_ID || 'PrimeWin',
};

export function validateEnv() {
  const required = [
    'SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'JWT_SECRET', 'JWT_REFRESH_SECRET'
  ];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}
