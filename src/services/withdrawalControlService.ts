import { supabase } from '../config/supabase';
import { redis } from '../config/redis';

export const GLOBAL_PLATFORM_CONTROLS_ID = '00000000-0000-0000-0000-000000000001';
export const DEFAULT_WITHDRAWAL_LOCK_MESSAGE = 'Withdrawals are temporarily unavailable. Please try again later.';
const WITHDRAWAL_CONTROL_CACHE_KEY = 'platform:withdrawal-control:v1';

export type WithdrawalControl = {
  withdrawals_locked: boolean;
  withdrawals_lock_reason: string | null;
  updated_by: string | null;
  updated_at: string;
};

function isMissingControlSchema(error: { code?: string; message?: string } | null): boolean {
  return Boolean(error && (
    error.code === '42P01'
    || error.code === 'PGRST205'
    || error.message?.includes("Could not find the table 'public.platform_controls'")
    || error.message?.includes('relation "platform_controls" does not exist')
  ));
}

function parseCachedControl(raw: string | null): WithdrawalControl | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<WithdrawalControl>;
    if (typeof value.withdrawals_locked !== 'boolean') return null;
    return {
      withdrawals_locked: value.withdrawals_locked,
      withdrawals_lock_reason: typeof value.withdrawals_lock_reason === 'string' ? value.withdrawals_lock_reason : null,
      updated_by: typeof value.updated_by === 'string' ? value.updated_by : null,
      updated_at: typeof value.updated_at === 'string' ? value.updated_at : '',
    };
  } catch {
    return null;
  }
}

export async function getWithdrawalControl(): Promise<WithdrawalControl> {
  try {
    const cached = parseCachedControl(await redis.get(WITHDRAWAL_CONTROL_CACHE_KEY));
    if (cached) return cached;
  } catch {
    // Supabase remains the durable source when Redis is temporarily unavailable.
  }

  const { data, error } = await supabase
    .from('platform_controls')
    .select('withdrawals_locked, withdrawals_lock_reason, updated_by, updated_at')
    .eq('id', GLOBAL_PLATFORM_CONTROLS_ID)
    .single();

  if (error || !data) {
    if (!error || isMissingControlSchema(error)) {
      return {
        withdrawals_locked: false,
        withdrawals_lock_reason: null,
        updated_by: null,
        updated_at: '',
      };
    }
    throw new Error(error.message);
  }

  const control = data as WithdrawalControl;
  await redis.set(WITHDRAWAL_CONTROL_CACHE_KEY, JSON.stringify(control)).catch(() => {});
  return control;
}

export async function setWithdrawalControl(input: {
  locked: boolean;
  reason: string | null;
  adminId: string;
}): Promise<WithdrawalControl> {
  const next: WithdrawalControl = {
    withdrawals_locked: input.locked,
    withdrawals_lock_reason: input.locked ? input.reason : null,
    updated_by: input.adminId,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('platform_controls')
    .update(next)
    .eq('id', GLOBAL_PLATFORM_CONTROLS_ID)
    .select('withdrawals_locked, withdrawals_lock_reason, updated_by, updated_at')
    .single();

  if (error && !isMissingControlSchema(error)) throw new Error(error.message);
  const stored = (data as WithdrawalControl | null) ?? next;

  try {
    await redis.set(WITHDRAWAL_CONTROL_CACHE_KEY, JSON.stringify(stored));
  } catch (redisError) {
    if (!data) throw redisError;
  }
  return stored;
}

export function withdrawalLockReason(errorMessage?: string): string | null {
  if (!errorMessage?.includes('WITHDRAWALS_LOCKED:')) return null;
  return errorMessage.split('WITHDRAWALS_LOCKED:')[1]?.trim() || DEFAULT_WITHDRAWAL_LOCK_MESSAGE;
}

export function isMissingAffiliateWithdrawalFunction(error: { code?: string; message?: string } | null): boolean {
  return Boolean(error && (
    error.code === 'PGRST202'
    || error.code === '42883'
    || error.message?.includes('create_affiliate_withdrawal_request')
  ));
}
