import axios from 'axios';
import { supabase } from '../config/supabase';
import { WalletService } from './walletService';
import { NotificationService } from './notificationService';
import { AffiliateService } from './affiliateService';
import { broadcastBetWon } from '../socket';
import { redis } from '../config/redis';
import { logger } from '../utils/logger';
import { env } from '../config/env';

const CORRECT_SCORE_MARKETS = new Set([
  '0-0','1-0','0-1','1-1','2-0','0-2','2-1','1-2',
  '2-2','3-0','0-3','3-1','1-3','3-2','2-3','3-3',
  '4-0','0-4','4-1','1-4','4-2','2-4',
]);

interface CompletedFootballScore {
  id: string;
  sport_key: string;
  home_team: string;
  away_team: string;
  completed: boolean;
  scores: Array<{ name: string; score: string }> | null;
}

function getMatchWinner(event: CompletedFootballScore): 'home' | 'away' | 'draw' | null {
  if (!event.scores || event.scores.length < 2) return null;
  const homeEntry = event.scores.find(s => s.name === event.home_team);
  const awayEntry = event.scores.find(s => s.name === event.away_team);
  if (!homeEntry || !awayEntry) return null;

  const h = parseFloat(homeEntry.score);
  const a = parseFloat(awayEntry.score);
  if (isNaN(h) || isNaN(a)) return null;
  if (h > a) return 'home';
  if (a > h) return 'away';
  return 'draw';
}

// Determine if a single selection won based on the completed event's score
function selectionWon(
  event: CompletedFootballScore,
  marketType: string,
  selection: string,
): boolean | null {
  if (!event.scores || event.scores.length < 2) return null;
  const homeScore = parseFloat(event.scores.find(s => s.name === event.home_team)?.score ?? '');
  const awayScore = parseFloat(event.scores.find(s => s.name === event.away_team)?.score ?? '');
  if (isNaN(homeScore) || isNaN(awayScore)) return null;

  if (marketType === 'match_winner') {
    const winner = getMatchWinner(event);
    if (winner === null) return null;
    return winner === selection;
  }

  if (marketType === 'double_chance') {
    const winner = getMatchWinner(event);
    if (!winner) return null;
    return (selection === 'home_or_draw' && winner !== 'away') ||
      (selection === 'away_or_draw' && winner !== 'home') ||
      (selection === 'home_or_away' && winner !== 'draw');
  }

  if (marketType === 'over_under') {
    const match = /^(over|under)_(\d+)_(\d+)$/.exec(selection);
    if (!match) return null;
    const line = Number(`${match[2]}.${match[3]}`);
    return match[1] === 'over' ? homeScore + awayScore > line : homeScore + awayScore < line;
  }

  if (marketType === 'btts') return selection === 'yes' ? homeScore > 0 && awayScore > 0 : selection === 'no' ? homeScore === 0 || awayScore === 0 : null;
  if (marketType === 'total_goals_exact') return selection === '0_1' ? homeScore + awayScore <= 1 : selection === '2_3' ? homeScore + awayScore >= 2 && homeScore + awayScore <= 3 : selection === '4plus' ? homeScore + awayScore >= 4 : null;
  if (marketType === 'clean_sheet_home') return selection === 'yes' ? awayScore === 0 : selection === 'no' ? awayScore > 0 : null;
  if (marketType === 'clean_sheet_away') return selection === 'yes' ? homeScore === 0 : selection === 'no' ? homeScore > 0 : null;
  if (marketType === 'anytime_score_home') return selection === 'yes' ? homeScore > 0 : selection === 'no' ? homeScore === 0 : null;
  if (marketType === 'anytime_score_away') return selection === 'yes' ? awayScore > 0 : selection === 'no' ? awayScore === 0 : null;
  if (marketType === 'correct_score') {
    const finalScore = `${homeScore}-${awayScore}`;
    return selection === 'other' ? !CORRECT_SCORE_MARKETS.has(finalScore) : selection === finalScore;
  }

  if (marketType === 'totals') {
    // selection format: "Over 2.5" or "Under 2.5"
    if (!event.scores || event.scores.length < 2) return null;
    const h = parseFloat(event.scores.find(s => s.name === event.home_team)?.score ?? '');
    const a = parseFloat(event.scores.find(s => s.name === event.away_team)?.score ?? '');
    if (isNaN(h) || isNaN(a)) return null;
    const total = h + a;
    const parts = selection.split(' ');
    if (parts.length < 2) return null;
    const direction = parts[0].toLowerCase(); // "over" or "under"
    const line = parseFloat(parts[1]);
    if (isNaN(line)) return null;
    if (direction === 'over') return total > line;
    if (direction === 'under') return total < line;
    return null;
  }

  if (marketType === 'handicap') {
    // selection format: "home +1.5" or "away -2.5"
    if (!event.scores || event.scores.length < 2) return null;
    const h = parseFloat(event.scores.find(s => s.name === event.home_team)?.score ?? '');
    const a = parseFloat(event.scores.find(s => s.name === event.away_team)?.score ?? '');
    if (isNaN(h) || isNaN(a)) return null;
    const parts = selection.split(' ');
    if (parts.length < 2) return null;
    const side = parts[0].toLowerCase(); // "home" or "away"
    const handicap = parseFloat(parts[1]);
    if (isNaN(handicap)) return null;
    if (side === 'home') return (h + handicap) > a;
    if (side === 'away') return (a + handicap) > h;
    return null;
  }

  return null; // unsupported market — leave pending
}

export async function settlePendingBets(): Promise<void> {
  if (!env.API_FOOTBALL_KEY) return;

  // Only real football events use this provider-backed settlement.
  const { data: pendingBets, error } = await supabase
    .from('bets')
    .select('id, user_id, stake, potential_payout, share_code, bet_selections(event_id, market_type, selection)')
    .eq('status', 'pending');

  if (error) { logger.error('[Settlement] Failed to load pending bets', { message: error.message }); return; }
  if (!pendingBets?.length) return;

  // Simulations settle in their own engine; legacy/non-football bets are left
  // untouched until a dedicated settlement source is configured for them.
  const realBets = pendingBets.filter(bet =>
    (bet.bet_selections as any[]).every((sel: any) =>
      sel.event_id.startsWith('upcoming:football:') || sel.event_id.startsWith('live:football:')
    )
  );
  if (!realBets.length) return;

  const allEventIds = [...new Set(
    realBets.flatMap(b => (b.bet_selections as any[]).map((s: any) => s.event_id))
  )];
  const { data: upcomingMappings } = await supabase.from('upcoming_football_fixture_mappings')
    .select('canonical_event_id,sportmonks_fixture_id,api_football_fixture_id,home_team,away_team').in('canonical_event_id', allEventIds);
  const { data: liveMappings } = await supabase.from('live_fixture_mappings')
    .select('canonical_event_id,sportmonks_fixture_id,api_football_fixture_id').in('canonical_event_id', allEventIds);
  const mappings: Array<{ canonical_event_id: string; sportmonks_fixture_id?: number | null; api_football_fixture_id?: number | null; home_team?: string; away_team?: string }> = [
    ...(upcomingMappings ?? []), ...(liveMappings ?? []),
  ];
  const completedEvents = new Map<string, CompletedFootballScore>();
  for (const mapping of mappings) {
    const cacheKey = `settlement:football:${mapping.canonical_event_id}`;
    const cached = await redis.get(cacheKey); if (cached) { completedEvents.set(mapping.canonical_event_id, JSON.parse(cached)); continue; }
    let score: CompletedFootballScore | null = null;
    if (mapping.api_football_fixture_id) {
      try {
        const response = await axios.get('https://v3.football.api-sports.io/fixtures', { params: { id: mapping.api_football_fixture_id }, headers: { 'x-apisports-key': env.API_FOOTBALL_KEY }, timeout: 12_000 });
        const fixture = response.data?.response?.[0];
        if (fixture && ['FT', 'AET', 'PEN'].includes(fixture.fixture?.status?.short)) {
          const homeTeam = mapping.home_team ?? fixture.teams?.home?.name;
          const awayTeam = mapping.away_team ?? fixture.teams?.away?.name;
          if (homeTeam && awayTeam) score = { id: mapping.canonical_event_id, sport_key: 'football', home_team: homeTeam, away_team: awayTeam, completed: true, scores: [{ name: homeTeam, score: String(fixture.goals?.home ?? 0) }, { name: awayTeam, score: String(fixture.goals?.away ?? 0) }] };
        }
      } catch (err: any) { logger.warn('[Settlement] API-Football final-score fetch failed', { eventId: mapping.canonical_event_id, message: err.message }); }
    }
    if (score) { completedEvents.set(mapping.canonical_event_id, score); await redis.setex(cacheKey, 300, JSON.stringify(score)); }
  }

  if (completedEvents.size === 0) return;
  logger.info(`[Settlement] ${completedEvents.size} completed events found`);

  // Settle each pending bet
  for (const bet of realBets) {
    const selections = bet.bet_selections as Array<{
      event_id: string;
      market_type: string;
      selection: string;
    }>;

    let allWon = true;
    let anyLost = false;
    let allComplete = true;

    for (const sel of selections) {
      const event = completedEvents.get(sel.event_id);
      if (!event) { allComplete = false; continue; }

      const won = selectionWon(event, sel.market_type, sel.selection);
      if (won === null) { allComplete = false; continue; } // unsupported market
      if (!won) anyLost = true;
      if (!won) allWon = false;
    }

    // Settle as lost immediately if any leg lost (even if others not done)
    // Settle as won only when every leg is confirmed won
    const shouldSettle = anyLost || (allWon && allComplete);
    if (!shouldSettle) continue;

    const outcome = anyLost ? 'lost' : 'won';

    try {
      const updatePayload: Record<string, unknown> = {
        status: outcome,
        settled_at: new Date().toISOString(),
      };
      if (outcome === 'won') updatePayload.payout = bet.potential_payout;

      await supabase.from('bets').update(updatePayload).eq('id', bet.id);

      if (outcome === 'won') {
        await WalletService.credit(
          bet.user_id, bet.potential_payout, 'bet_win',
          undefined, undefined, `Bet won - auto-settled`,
        );
        const { data: wallet } = await supabase
          .from('wallets').select('currency').eq('user_id', bet.user_id).single();
        const currency = wallet?.currency ?? 'USD';
        await NotificationService.send(
          bet.user_id, 'bet_won', 'Bet Won!',
          `Congratulations! You won ${currency} ${bet.potential_payout}`,
        );
        broadcastBetWon(bet.user_id, {
          betId: bet.id,
          amount: bet.potential_payout,
          currency,
          shareCode: bet.share_code ?? undefined,
        });
      } else {
        await NotificationService.send(
          bet.user_id, 'bet_lost', 'Bet Lost', 'Your bet has been settled.',
        );
      }

      const payout = outcome === 'won' ? (bet.potential_payout ?? 0) : 0;
      AffiliateService.creditBetCommission(bet.user_id, bet.stake, payout).catch(() => {});

      logger.info(`[Settlement] Bet ${bet.id} auto-settled as ${outcome}`);
    } catch (err: any) {
      logger.error(`[Settlement] Failed to settle bet ${bet.id}`, { message: err.message });
    }
  }
}
