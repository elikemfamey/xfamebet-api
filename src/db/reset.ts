import 'dotenv/config';
import { supabase } from '../config/supabase';
import { hashPassword } from '../utils/crypto';
import { seedStaffPromo } from './seedStaffPromo';

// Reference data intentionally retained by this reset: teams, team_logos,
// players, simulation_leagues, and casino_games.
// The list is ordered from dependent records to their parents.
const TABLES_TO_CLEAR = [
  'affiliate_commission_logs',
  'affiliate_referrals',
  'affiliate_clicks',
  'payment_audit_logs',
  'bet_selections',
  'social_bet_slips',
  'match_events',
  'odds_snapshots',
  'transactions',
  'deposit_requests',
  'withdrawal_requests',
  'payment_methods',
  'user_bonus_grants',
  'notifications',
  'fraud_events',
  'fraud_cases',
  'responsible_gambling_limits',
  'admin_logs',
  'creator_profiles',
  'prediction_communities',
  'sessions',
  'device_fingerprints',
  'kyc_documents',
  'promo_codes',
  'affiliates',
  'bets',
  'simulated_matches',
  'odds_feed',
  'bonus_promotions',
  'markets',
  'risk_scores',
  'wallets',
  'users',
] as const;

function requireSuccess(label: string, result: { error: unknown }) {
  if (result.error) {
    throw new Error(`${label} failed: ${JSON.stringify(result.error)}`);
  }
}

async function clearTable(table: string) {
  // A filter is required by PostgREST for delete requests. Every application
  // table has an id primary key, and this condition matches every row.
  const result = await supabase.from(table).delete().not('id', 'is', null);
  // This project supports deployments that have not yet received every
  // optional migration. Missing tables have no data to reset.
  if ((result.error as { code?: string } | null)?.code === 'PGRST205') {
    console.log(`Skipped ${table} (not present in this database)`);
    return;
  }
  requireSuccess(`Clear ${table}`, result);
  console.log(`Cleared ${table}`);
}

async function seedUser(label: string, password: string, user: Record<string, unknown>) {
  const password_hash = await hashPassword(password);
  const { data, error } = await supabase.from('users').insert({ ...user, password_hash }).select('email, role').single();
  requireSuccess(label, { error });
  console.log(`${label}: ${data!.email} (${data!.role})`);
}

async function reset() {
  console.log('Resetting operational data; team and platform reference data will be retained.');
  for (const table of TABLES_TO_CLEAR) {
    await clearTable(table);
  }

  await seedUser('Seeded super admin', 'Admin@123456', {
    username: 'superadmin', email: 'admin@xfamebet.com', phone: '+233200000001',
    country: 'GH', referral_code: 'ADMIN001', role: 'super_admin',
    kyc_status: 'approved', account_status: 'active', email_verified: true,
  });
  await seedUser('Seeded fraud analyst', 'Analyst@123456', {
    username: 'fraud_analyst1', email: 'fraud@xfamebet.com', phone: '+233200000002',
    country: 'GH', referral_code: 'FRAUD001', role: 'fraud_analyst',
    kyc_status: 'approved', account_status: 'active', email_verified: true,
  });
  await seedStaffPromo();

  const { data, error } = await supabase.from('users').select('email, role').order('email');
  requireSuccess('Verify seeded accounts', { error });
  console.log('Reset complete. Users:', data);
}

reset().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
