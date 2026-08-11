import { env } from '../config/env';
import { supabase } from '../config/supabase';

type MoolreStatus = {
  txstatus?: number | string;
  accountnumber?: string;
  amount?: string | number;
  value?: string | number;
  transactionid?: string | number;
  externalref?: string;
  currency?: string;
};

export type MoolreCollectionResponse = {
  code?: string;
  message?: string | null;
  data?: string;
};

export class MoolreApiError extends Error {
  constructor(public readonly providerCode: string | undefined, message: string) {
    super(message);
  }
}

export class MoolreService {
  static missingConfiguration(): string[] {
    return [
      ['MOOLRE_API_USER', env.MOOLRE_API_USER],
      ['MOOLRE_PUBLIC_KEY', env.MOOLRE_PUBLIC_KEY],
      ['MOOLRE_ACCOUNT_NUMBER', env.MOOLRE_ACCOUNT_NUMBER],
      ['MOOLRE_BUSINESS_EMAIL', env.MOOLRE_BUSINESS_EMAIL],
    ].filter(([, value]) => !value?.trim()).map(([name]) => name);
  }

  static isConfigured(): boolean {
    return this.missingConfiguration().length === 0;
  }

  private static headers() {
    return {
      'Content-Type': 'application/json',
      'X-API-USER': env.MOOLRE_API_USER,
      'X-API-PUBKEY': env.MOOLRE_PUBLIC_KEY,
    };
  }

  static async createPaymentLink(amount: number, reference: string, metadata: Record<string, unknown>) {
    if (!this.isConfigured()) throw new Error('Moolre is not configured');
    const response = await fetch('https://api.moolre.com/embed/link', {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({
        type: 1, amount: amount.toFixed(2), email: env.MOOLRE_BUSINESS_EMAIL,
        externalref: reference, callback: `${env.API_URL}/api/payments/moolre/webhook`,
        redirect: `${env.FRONTEND_URL}/wallet?deposit=moolre`, reusable: '0', expiration_time: 30,
        currency: 'GHS', accountnumber: env.MOOLRE_ACCOUNT_NUMBER, metadata,
      }),
    });
    const body = await response.json() as { status?: number; code?: string; message?: string; data?: { authorization_url?: string; reference?: string } };
    if (!response.ok || body.status !== 1 || !body.data?.authorization_url) {
      throw new MoolreApiError(body.code, body.message || 'Moolre link creation failed');
    }
    return { authorizationUrl: body.data.authorization_url, reference: body.data.reference ?? reference };
  }

  static async getPaymentStatus(reference: string): Promise<MoolreStatus | null> {
    if (!this.isConfigured()) throw new Error('Moolre is not configured');
    const response = await fetch('https://api.moolre.com/open/transact/status', {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({ type: 1, idtype: 1, id: reference, accountnumber: env.MOOLRE_ACCOUNT_NUMBER }),
    });
    const body = await response.json() as { status?: number; data?: MoolreStatus };
    return response.ok && body.status === 1 ? body.data ?? null : null;
  }

  static async requestMobileMoneyPayment(input: {
    amount: number; reference: string; phone: string; channel: string; otpCode?: string;
  }): Promise<MoolreCollectionResponse> {
    if (!this.isConfigured()) throw new Error('Moolre is not configured');
    const response = await fetch('https://api.moolre.com/open/transact/payment', {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({
        type: 1, channel: input.channel, currency: 'GHS', payer: input.phone,
        amount: input.amount.toFixed(2), externalref: input.reference,
        ...(input.otpCode ? { otpcode: input.otpCode } : {}), accountnumber: env.MOOLRE_ACCOUNT_NUMBER,
      }),
    });
    const body = await response.json() as { status?: number | string; code?: string; message?: string | null; data?: string };
    if (!response.ok || Number(body.status) !== 1) throw new MoolreApiError(body.code, body.message || 'Moolre payment request failed');
    return { code: body.code, message: body.message, data: body.data };
  }

  static isVerifiedSuccess(status: MoolreStatus | null, reference: string, amount: number): boolean {
    if (!status) return false;
    return Number(status.txstatus) === 1
      && status.accountnumber === env.MOOLRE_ACCOUNT_NUMBER
      && status.externalref === reference
      && Number(status.amount ?? status.value) === Number(amount);
  }

  /** Verifies with Moolre's status API before the database RPC can credit funds. */
  static async verifyAndCredit(deposit: { id: string; reference: string; amount: number }) {
    const status = await this.getPaymentStatus(deposit.reference);
    if (!this.isVerifiedSuccess(status, deposit.reference, deposit.amount)) return null;
    const transactionId = String(status?.transactionid ?? '');
    if (!transactionId) return null;
    const { data, error } = await supabase.rpc('finalize_moolre_deposit', {
      p_deposit_id: deposit.id, p_transaction_id: transactionId, p_provider_payload: status,
    });
    if (error) throw new Error(error.message);
    return data as { already_completed?: boolean; user_id?: string; amount?: number };
  }
}
