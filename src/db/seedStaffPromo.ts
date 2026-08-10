import 'dotenv/config';
import { supabase } from '../config/supabase';

export const STAFF_PROMO = {
  code: 'STAFF50',
  promotion_type: 'staff_seed',
  value: 50,
  value_type: 'fixed',
  usage_limit: 2,
  status: 'active',
} as const;

const STAFF_EMAILS = ['admin@xfamebet.com', 'fraud@xfamebet.com'];

function requireSuccess<T>(label: string, result: { data: T; error: unknown }) {
  if (result.error) throw new Error(`${label} failed: ${JSON.stringify(result.error)}`);
  return result.data;
}

export async function seedStaffPromo() {
  const existing = requireSuccess('Find staff promo', await supabase
    .from('promo_codes').select('id').eq('code', STAFF_PROMO.code).maybeSingle());

  const promo = existing ?? requireSuccess('Create staff promo', await supabase
    .from('promo_codes').insert(STAFF_PROMO).select('id').single());
  if (!promo) throw new Error('Create staff promo failed: no promo returned');

  for (const email of STAFF_EMAILS) {
    const user = requireSuccess(`Find ${email}`, await supabase
      .from('users').select('id').eq('email', email).single());
    if (!user) throw new Error(`Find ${email} failed: no user returned`);
    const wallet = requireSuccess(`Find ${email} wallet`, await supabase
      .from('wallets').select('id, bonus_balance').eq('user_id', user.id).single());
    if (!wallet) throw new Error(`Find ${email} wallet failed: no wallet returned`);
    const granted = requireSuccess(`Find ${email} staff bonus`, await supabase
      .from('user_bonus_grants').select('id').eq('user_id', user.id).eq('promo_code_id', promo.id).maybeSingle());
    if (granted) {
      // Recover safely if a prior run created the grant but stopped before the
      // wallet credit (for example when an older database lacks credit_bonus).
      if (Number(wallet.bonus_balance) !== 0) continue;
    } else {
    requireSuccess(`Grant ${email} staff bonus`, await supabase.from('user_bonus_grants').insert({
      user_id: user.id, promo_code_id: promo.id, amount: STAFF_PROMO.value,
      wagering_required: STAFF_PROMO.value * 3,
    }));
    }
    const credit = await supabase.rpc('credit_bonus', { p_wallet_id: wallet.id, p_amount: STAFF_PROMO.value });
    if (credit.error && (credit.error as { code?: string }).code !== 'PGRST202') {
      requireSuccess(`Credit ${email} staff bonus`, credit);
    }
    if (credit.error) {
      requireSuccess(`Credit ${email} staff bonus directly`, await supabase.from('wallets').update({
        bonus_balance: Number(wallet.bonus_balance) + STAFF_PROMO.value,
      }).eq('id', wallet.id));
    }
    console.log(`Granted ${STAFF_PROMO.code} to ${email}`);
  }
  console.log(`Staff promo ready: ${STAFF_PROMO.code} (GHS ${STAFF_PROMO.value})`);
}

if (require.main === module) {
  seedStaffPromo().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
