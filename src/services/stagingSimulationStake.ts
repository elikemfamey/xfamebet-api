import { randomUUID } from 'crypto';
import { env } from '../config/env';
import { redis, REDIS_KEYS } from '../config/redis';
import { supabase } from '../config/supabase';
import { broadcastWalletUpdate } from '../socket';

export function stagingSimulationStakeEnabled() {
  const stagingUrl = process.env.STAGING_SIMULATION_AUTO_STAKE_DB_URL?.trim().replace(/\/$/, '');
  return Boolean(stagingUrl && stagingUrl === env.SUPABASE_URL?.trim().replace(/\/$/, ''));
}

export async function placeStagingSimulationStake(matchId: string) {
  if (!stagingSimulationStakeEnabled()) return null;

  const { data: user, error: userError } = await supabase.from('users').select('id')
    .eq('email', 'admin@xfamebet.com').eq('role', 'super_admin').single();
  if (userError || !user) throw new Error('Designated staging super-admin not found');

  const lock = REDIS_KEYS.WALLET_LOCK(user.id);
  const owner = randomUUID();
  if (!await redis.set(lock, owner, 'EX', 30, 'NX')) throw new Error('Staging wallet operation in progress');
  try {
    const { data, error } = await supabase.rpc('place_staging_simulation_stake', {
      p_match_id: matchId,
      p_user_id: user.id,
    });
    if (error) throw new Error(error.message);
    if (data.status === 'placed') {
      broadcastWalletUpdate(user.id, Number(data.balance));
      return { status: 'placed', stake: Number(data.stake), selection: String(data.selection) } as const;
    }
    return { status: 'already_staked' } as const;
  } finally {
    await redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0",
      1, lock, owner,
    ).catch(() => undefined);
  }
}
