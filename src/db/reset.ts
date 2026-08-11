import 'dotenv/config';
import { supabase } from '../config/supabase';
import { hashPassword } from '../utils/crypto';

// This operational reset deliberately preserves all users, teams, players, matches,
// odds/catalogue data, promotion definitions, country settings, and FX rates.
const TABLES_TO_CLEAR = [
  'affiliate_commission_logs', 'affiliate_referrals', 'affiliate_clicks',
  'payment_audit_logs', 'bet_selections', 'social_bet_slips',
  'transactions', 'deposit_requests', 'withdrawal_requests', 'payment_methods',
  'user_bonus_grants', 'notifications', 'fraud_events', 'fraud_cases',
  'responsible_gambling_limits', 'admin_logs', 'creator_profiles',
  'prediction_communities', 'sessions', 'device_fingerprints', 'kyc_documents',
  'bets', 'risk_scores',
] as const;

function requireSuccess(label: string, error: unknown) {
  if (error) throw new Error(`${label} failed: ${JSON.stringify(error)}`);
}

async function clearTable(table: string) {
  const { error } = await supabase.from(table).delete().not('id', 'is', null);
  if ((error as { code?: string } | null)?.code === 'PGRST205') return console.log(`Skipped ${table} (table is not present)`);
  requireSuccess(`Clear ${table}`, error);
  console.log(`Cleared ${table}`);
}

async function reset() {
  if (process.env.RESET_OPERATIONAL_DATA !== 'CONFIRM') {
    throw new Error('Refusing to reset. Run with RESET_OPERATIONAL_DATA=CONFIRM.');
  }
  console.log('Clearing operational data while preserving user and team/reference records.');
  for (const table of TABLES_TO_CLEAR) await clearTable(table);

  const { error: walletsError } = await supabase.from('wallets').update({
    balance: 0, bonus_balance: 0, cashback_balance: 0, currency: 'USD', currency_locked: false,
  }).not('id', 'is', null);
  requireSuccess('Reset wallet balances', walletsError);

  const password_hash = await hashPassword('Nigeria@123456');
  const { data: nigeriaUser, error: nigeriaError } = await supabase.from('users').upsert({
    username: 'ng_test_user', email: 'nigeria.test@xfamebet.com', phone: '+2348012345678',
    country: 'NG', referral_code: 'NGTEST01', role: 'user', kyc_status: 'approved',
    account_status: 'active', email_verified: true, phone_verified: true, password_hash,
  }, { onConflict: 'email' }).select('id, email, country').single();
  requireSuccess('Create Nigerian test account', nigeriaError);
  console.log('Nigerian test account:', nigeriaUser);

  // Upserts the wallet in case this database predates the automatic-wallet trigger.
  const { error: testWalletError } = await supabase.from('wallets').upsert({
    user_id: nigeriaUser!.id, balance: 0, bonus_balance: 0, cashback_balance: 0,
    currency: 'USD', currency_locked: false, frozen: false, withdrawal_frozen: false,
  }, { onConflict: 'user_id' });
  requireSuccess('Set Nigerian test wallet', testWalletError);
  console.log('Operational reset complete.');
}

reset().catch((error) => { console.error(error); process.exitCode = 1; });
