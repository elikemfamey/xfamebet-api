import axios from 'axios';
import { supabase } from '../config/supabase';
import { WalletService } from './walletService';
import { NotificationService } from './notificationService';
import { AffiliateService } from './affiliateService';
import { broadcastBetWon } from '../socket';
import { redis } from '../config/redis';
import { logger } from '../utils/logger';
import { env } from '../config/env';

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
  if (marketType === 'match_winner') {
    const winner = getMatchWinner(event);
    if (winner === null) return null;
    return winner === selection;
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
  if (!env.SPORTMONKS_API_TOKEN && !env.API_FOOTBALL_KEY) return;

  // Only real upcoming football events use this provider-backed settlement.
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
      sel.event_id.startsWith('upcoming:football:')
    )
  );
  if (!realBets.length) return;

  const allEventIds = [...new Set(
    realBets.flatMap(b => (b.bet_selections as any[]).map((s: any) => s.event_id))
  )];
  const { data: mappings } = await supabase.from('upcoming_football_fixture_mappings')
    .select('canonical_event_id,sportmonks_fixture_id,api_football_fixture_id,home_team,away_team').in('canonical_event_id', allEventIds);
  const completedEvents = new Map<string, CompletedFootballScore>();
  for (const mapping of mappings ?? []) {
    const cacheKey = `settlement:football:${mapping.canonical_event_id}`;
    const cached = await redis.get(cacheKey); if (cached) { completedEvents.set(mapping.canonical_event_id, JSON.parse(cached)); continue; }
    let score: CompletedFootballScore | null = null;
    if (mapping.sportmonks_fixture_id && env.SPORTMONKS_API_TOKEN) {
      try {
        const response = await axios.get(`https://api.sportmonks.com/v3/football/fixtures/${mapping.sportmonks_fixture_id}`, { params: { api_token: env.SPORTMONKS_API_TOKEN, include: 'participants;scores;state' }, timeout: 12_000 });
        const fixture = response.data?.data; const state = fixture?.state?.developer_name;
        const participants = fixture?.participants ?? []; const home = participants.find((p: any) => p.meta?.location === 'home'); const away = participants.find((p: any) => p.meta?.location === 'away');
        if (['FT', 'AET', 'FT_PEN'].includes(state) && home && away) {
          const scores = fixture.scores ?? [];
          score = { id: mapping.canonical_event_id, sport_key: 'football', home_team: mapping.home_team, away_team: mapping.away_team, completed: true, scores: [{ name: mapping.home_team, score: String(scores.find((s: any) => s.participant_id === home.id && s.description === 'CURRENT')?.score?.goals ?? 0) }, { name: mapping.away_team, score: String(scores.find((s: any) => s.participant_id === away.id && s.description === 'CURRENT')?.score?.goals ?? 0) }] };
        }
      } catch (err: any) { logger.warn('[Settlement] SportMonks final-score fetch failed', { eventId: mapping.canonical_event_id, message: err.message }); }
    }
    if (!score && mapping.api_football_fixture_id && env.API_FOOTBALL_KEY) {
      try {
        const response = await axios.get('https://v3.football.api-sports.io/fixtures', { params: { id: mapping.api_football_fixture_id }, headers: { 'x-apisports-key': env.API_FOOTBALL_KEY }, timeout: 12_000 });
        const fixture = response.data?.response?.[0];
        if (fixture && ['FT', 'AET', 'PEN'].includes(fixture.fixture?.status?.short)) score = { id: mapping.canonical_event_id, sport_key: 'football', home_team: mapping.home_team, away_team: mapping.away_team, completed: true, scores: [{ name: mapping.home_team, score: String(fixture.goals?.home ?? 0) }, { name: mapping.away_team, score: String(fixture.goals?.away ?? 0) }] };
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
        await NotificationService.send(
          bet.user_id, 'bet_won', 'Bet Won!',
          `Congratulations! You won GHS ${bet.potential_payout}`,
        );
        const { data: wallet } = await supabase
          .from('wallets').select('currency').eq('user_id', bet.user_id).single();
        broadcastBetWon(bet.user_id, {
          betId: bet.id,
          amount: bet.potential_payout,
          currency: wallet?.currency ?? 'GHS',
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
