import { supabase } from '../config/supabase';
import { redis, REDIS_KEYS } from '../config/redis';
import { TransactionType, PaymentProvider } from '../types';
import { logger } from '../utils/logger';

export class WalletService {
  static async getBalance(userId: string) {
    const { data, error } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) throw new Error('Wallet not found');
    return data;
  }

  static async credit(
    userId: string,
    amount: number,
    type: TransactionType,
    provider?: PaymentProvider,
    reference?: string,
    description?: string,
    metadata?: Record<string, unknown>
  ) {
    const lockKey = REDIS_KEYS.WALLET_LOCK(userId);
    const lockAcquired = await redis.set(lockKey, '1', 'EX', 30, 'NX');
    if (!lockAcquired) throw new Error('Wallet operation in progress');

    try {
      const { data: wallet, error: walletErr } = await supabase
        .from('wallets').select('id, balance, currency').eq('user_id', userId).single();
      if (walletErr || !wallet) throw new Error('Wallet not found');

      const { error: txErr } = await supabase.from('transactions').insert({
        user_id: userId,
        wallet_id: wallet.id,
        type,
        amount,
        currency: wallet.currency,
        status: 'completed',
        payment_provider: provider,
        reference,
        description,
        metadata,
      });
      if (txErr) throw new Error('Transaction creation failed');

      const { error: updateErr } = await supabase
        .from('wallets')
        .update({ balance: wallet.balance + amount, updated_at: new Date().toISOString() })
        .eq('id', wallet.id);
      if (updateErr) throw new Error('Wallet update failed');

      return { success: true, new_balance: wallet.balance + amount };
    } finally {
      await redis.del(lockKey);
    }
  }

  static async creditBonus(userId: string, amount: number, description?: string) {
    const { data: wallet, error } = await supabase
      .from('wallets').select('id, bonus_balance, currency').eq('user_id', userId).single();
    if (error || !wallet) throw new Error('Wallet not found');

    await supabase.from('transactions').insert({
      user_id: userId,
      wallet_id: wallet.id,
      type: 'bonus',
      amount,
      currency: wallet.currency,
      status: 'completed',
      description,
    });

    await supabase.from('wallets')
      .update({ bonus_balance: wallet.bonus_balance + amount })
      .eq('id', wallet.id);

    return { success: true };
  }

  static async debit(
    userId: string,
    amount: number,
    type: TransactionType,
    description?: string,
    metadata?: Record<string, unknown>
  ) {
    const lockKey = REDIS_KEYS.WALLET_LOCK(userId);
    const lockAcquired = await redis.set(lockKey, '1', 'EX', 30, 'NX');
    if (!lockAcquired) throw new Error('Wallet operation in progress');

    try {
      const { data: wallet, error: walletErr } = await supabase
        .from('wallets').select('id, balance, frozen, currency').eq('user_id', userId).single();
      if (walletErr || !wallet) throw new Error('Wallet not found');
      if (wallet.frozen) throw new Error('Wallet is frozen');
      if (wallet.balance < amount) throw new Error('Insufficient balance');

      const { error: txErr } = await supabase.from('transactions').insert({
        user_id: userId,
        wallet_id: wallet.id,
        type,
        amount: -amount,
        currency: wallet.currency,
        status: 'completed',
        description,
        metadata,
      });
      if (txErr) throw new Error('Transaction creation failed');

      const { error: updateErr } = await supabase
        .from('wallets')
        .update({ balance: wallet.balance - amount, updated_at: new Date().toISOString() })
        .eq('id', wallet.id);
      if (updateErr) throw new Error('Wallet update failed');

      return { success: true, new_balance: wallet.balance - amount };
    } finally {
      await redis.del(lockKey);
    }
  }

  static async getTransactions(userId: string, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    const { data, count, error } = await supabase
      .from('transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    return { data, total: count ?? 0 };
  }

  static async freeze(userId: string) {
    await supabase.from('wallets').update({ frozen: true }).eq('user_id', userId);
  }

  static async unfreeze(userId: string) {
    await supabase.from('wallets').update({ frozen: false }).eq('user_id', userId);
  }
}
