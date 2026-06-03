import 'dotenv/config';
import { supabase } from '../config/supabase';
import { hashPassword } from '../utils/crypto';

async function seed() {
  console.log('Seeding database...');

  // Create super admin
  const adminHash = await hashPassword('Admin@123456');
  const { data: admin } = await supabase.from('users').upsert({
    username: 'superadmin',
    email: 'admin@xfamebet.com',
    password_hash: adminHash,
    country: 'GH',
    referral_code: 'ADMIN001',
    role: 'super_admin',
    kyc_status: 'approved',
    account_status: 'active',
    email_verified: true,
  }, { onConflict: 'email' }).select().single();

  console.log('Admin created:', admin?.email);

  // Create fraud analyst
  const analystHash = await hashPassword('Analyst@123456');
  await supabase.from('users').upsert({
    username: 'fraud_analyst1',
    email: 'fraud@xfamebet.com',
    password_hash: analystHash,
    country: 'GH',
    referral_code: 'FRAUD001',
    role: 'fraud_analyst',
    kyc_status: 'approved',
    account_status: 'active',
    email_verified: true,
  }, { onConflict: 'email' });

  // Create test user
  const userHash = await hashPassword('User@123456');
  await supabase.from('users').upsert({
    username: 'testuser1',
    email: 'user@xfamebet.com',
    password_hash: userHash,
    country: 'GH',
    referral_code: 'USER001',
    role: 'user',
    kyc_status: 'approved',
    account_status: 'active',
    email_verified: true,
  }, { onConflict: 'email' });

  // Seed teams
  const teams = [
    { name: 'Lions FC', short_name: 'LFC', sport: 'virtual_football', strength: 7.5 },
    { name: 'Eagles United', short_name: 'EAG', sport: 'virtual_football', strength: 6.8 },
    { name: 'City Stars', short_name: 'CST', sport: 'virtual_football', strength: 7.2 },
    { name: 'River Hawks', short_name: 'RHK', sport: 'virtual_football', strength: 6.5 },
    { name: 'Thunder FC', short_name: 'THU', sport: 'virtual_football', strength: 7.0 },
    { name: 'Blue Wolves', short_name: 'BWO', sport: 'virtual_football', strength: 6.3 },
    { name: 'Golden Boys', short_name: 'GOL', sport: 'virtual_basketball', strength: 7.8 },
    { name: 'Red Storm', short_name: 'RST', sport: 'virtual_basketball', strength: 7.1 },
  ];
  await supabase.from('teams').upsert(teams, { onConflict: 'name,sport' });

  // Seed markets
  const markets = [
    { name: 'Match Winner', key: 'match_winner', sport: 'football' },
    { name: 'Over/Under 2.5', key: 'over_under', sport: 'football' },
    { name: 'Both Teams to Score', key: 'btts', sport: 'football' },
    { name: 'Handicap', key: 'handicap', sport: 'football' },
    { name: 'Correct Score', key: 'correct_score', sport: 'football' },
    { name: 'Double Chance', key: 'double_chance', sport: 'football' },
    { name: 'Draw No Bet', key: 'draw_no_bet', sport: 'football' },
    { name: 'Goal Scorer', key: 'goal_scorer', sport: 'football' },
    { name: 'Corners & Cards', key: 'corners_cards', sport: 'football' },
    { name: 'Player Props', key: 'player_props', sport: 'football' },
  ];
  await supabase.from('markets').upsert(markets, { onConflict: 'key' });

  // Seed bonus promotions
  await supabase.from('bonus_promotions').upsert([
    { name: 'Welcome Bonus', type: 'welcome', description: '100% match on first deposit up to GHS 500', value: 100, value_type: 'percentage', min_deposit: 20, wagering_requirement: 5, status: 'active' },
    { name: 'First Deposit Bonus', type: 'first_deposit', description: '50% bonus on first deposit', value: 50, value_type: 'percentage', min_deposit: 10, wagering_requirement: 3, status: 'active' },
    { name: 'Cashback', type: 'cashback', description: '10% weekly cashback on net losses', value: 10, value_type: 'percentage', wagering_requirement: 1, status: 'active' },
    { name: 'Accumulator Bonus', type: 'accumulator', description: '10% bonus on accumulators with 4+ selections', value: 10, value_type: 'percentage', wagering_requirement: 1, status: 'active' },
  ], { onConflict: 'name' });

  // Seed promo codes
  await supabase.from('promo_codes').upsert([
    { code: 'WELCOME100', promotion_type: 'welcome', value: 100, value_type: 'fixed', usage_limit: 1000, status: 'active' },
    { code: 'XFAME50', promotion_type: 'first_deposit', value: 50, value_type: 'fixed', usage_limit: 500, status: 'active' },
    { code: 'FREBET20', promotion_type: 'free_bet', value: 20, value_type: 'fixed', usage_limit: 200, status: 'active' },
  ], { onConflict: 'code' });

  // Seed sample odds (real football-style)
  await supabase.from('odds_feed').upsert([
    { event_id: 'ext:epl:001', event_name: 'Man City vs Arsenal', market_type: 'match_winner', selection: 'home', odds_value: 1.75, source: 'internal', sport: 'football', status: 'active', starts_at: new Date(Date.now() + 3600000).toISOString() },
    { event_id: 'ext:epl:001', event_name: 'Man City vs Arsenal', market_type: 'match_winner', selection: 'draw', odds_value: 3.60, source: 'internal', sport: 'football', status: 'active' },
    { event_id: 'ext:epl:001', event_name: 'Man City vs Arsenal', market_type: 'match_winner', selection: 'away', odds_value: 4.50, source: 'internal', sport: 'football', status: 'active' },
    { event_id: 'ext:epl:001', event_name: 'Man City vs Arsenal', market_type: 'over_under', selection: 'over_2.5', odds_value: 1.85, source: 'internal', sport: 'football', status: 'active' },
    { event_id: 'ext:epl:001', event_name: 'Man City vs Arsenal', market_type: 'over_under', selection: 'under_2.5', odds_value: 1.95, source: 'internal', sport: 'football', status: 'active' },
    { event_id: 'ext:epl:001', event_name: 'Man City vs Arsenal', market_type: 'btts', selection: 'yes', odds_value: 1.72, source: 'internal', sport: 'football', status: 'active' },
    { event_id: 'ext:epl:001', event_name: 'Man City vs Arsenal', market_type: 'btts', selection: 'no', odds_value: 2.10, source: 'internal', sport: 'football', status: 'active' },
    { event_id: 'ext:laliga:001', event_name: 'Barcelona vs Real Madrid', market_type: 'match_winner', selection: 'home', odds_value: 2.10, source: 'internal', sport: 'football', status: 'active', starts_at: new Date(Date.now() + 7200000).toISOString() },
    { event_id: 'ext:laliga:001', event_name: 'Barcelona vs Real Madrid', market_type: 'match_winner', selection: 'draw', odds_value: 3.40, source: 'internal', sport: 'football', status: 'active' },
    { event_id: 'ext:laliga:001', event_name: 'Barcelona vs Real Madrid', market_type: 'match_winner', selection: 'away', odds_value: 3.20, source: 'internal', sport: 'football', status: 'active' },
    { event_id: 'ext:nba:001', event_name: 'Lakers vs Warriors', market_type: 'match_winner', selection: 'home', odds_value: 1.90, source: 'internal', sport: 'basketball', status: 'active', starts_at: new Date(Date.now() + 5400000).toISOString() },
    { event_id: 'ext:nba:001', event_name: 'Lakers vs Warriors', market_type: 'match_winner', selection: 'away', odds_value: 1.90, source: 'internal', sport: 'basketball', status: 'active' },
  ], { onConflict: 'event_id,market_type,selection' });

  // Schedule a virtual match
  const scheduled = new Date(Date.now() + 30000).toISOString();
  const { data: match } = await supabase.from('simulated_matches').insert({
    team_a: 'Lions FC', team_b: 'Eagles United',
    sport: 'virtual_football',
    duration_minutes: 90,
    league_name: 'XfameBet Virtual Premier League - Round 1',
    team_a_strength: 7.5, team_b_strength: 6.8,
    goal_probability: 0.03, card_probability: 0.05,
    scheduled_at: scheduled,
    status: 'scheduled',
  }).select().single();

  if (match) {
    const { SimulationEngine } = await import('../services/simulationEngine');
    await SimulationEngine.generateOdds(match.id, 7.5, 6.8);
  }

  console.log('Seeding complete!');
  console.log('');
  console.log('Credentials:');
  console.log('  Admin: admin@xfamebet.com / Admin@123456');
  console.log('  Analyst: fraud@xfamebet.com / Analyst@123456');
  console.log('  Test User: user@xfamebet.com / User@123456');
  process.exit(0);
}

seed().catch(console.error);
