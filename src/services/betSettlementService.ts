import axios from 'axios';
import { supabase } from '../config/supabase';
import { WalletService } from './walletService';
import { NotificationService } from './notificationService';
import { AffiliateService } from './affiliateService';
import { broadcastBetWon } from '../socket';
import { redis } from '../config/redis';
import { logger } from '../utils/logger';
import { env } from '../config/env';

interface OddsApiScore {
  id: string;
  sport_key: string;
  home_team: string;
  away_team: string;
  completed: boolean;
  scores: Array<{ name: string; score: string }> | null;
}

async function fetchScoresForSport(sportKey: string): Promise<OddsApiScore[]> {
  const cacheKey = `settlement:scores:${sportKey}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  try {
    const resp = await axios.get(
      `https://api.the-odds-api.com/v4/sports/${sportKey}/scores/`,
      {
        params: { apiKey: env.ODDS_API_KEY, daysFrom: 2 },
        timeout: 15000,
      },
    );
    const scores: OddsApiScore[] = resp.data ?? [];
    await redis.setex(cacheKey, 300, JSON.stringify(scores)); // cache 5 min per sport
    return scores;
  } catch (err: any) {
    if (err.response?.status === 422) return []; // sport has no scores endpoint
    logger.error(`[Settlement] Score fetch failed for ${sportKey}`, { message: err.message });
    return [];
  }
}

function getMatchWinner(event: OddsApiScore): 'home' | 'away' | 'draw' | null {
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
  event: OddsApiScore,
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
  if (!env.ODDS_API_KEY) return;

  // Load all pending bets that came from the real Odds API (not simulated)
  const { data: pendingBets, error } = await supabase
    .from('bets')
    .select('id, user_id, stake, potential_payout, share_code, bet_selections(event_id, market_type, selection)')
    .eq('status', 'pending');

  if (error) { logger.error('[Settlement] Failed to load pending bets', { message: error.message }); return; }
  if (!pendingBets?.length) return;

  // Filter out purely simulated bets (event_id starts with sim: or af:)
  const realBets = pendingBets.filter(bet =>
    (bet.bet_selections as any[]).every((sel: any) =>
      !sel.event_id.startsWith('sim:') && !sel.event_id.startsWith('af:')
    )
  );
  if (!realBets.length) return;

  // Collect all unique event IDs and resolve their sport_key from Redis cache
  const allEventIds = [...new Set(
    realBets.flatMap(b => (b.bet_selections as any[]).map((s: any) => s.event_id))
  )];

  const sportKeyToEventIds = new Map<string, Set<string>>();
  for (const eventId of allEventIds) {
    const sportKey = await redis.get(`event:sport_key:${eventId}`);
    if (!sportKey) continue;
    if (!sportKeyToEventIds.has(sportKey)) sportKeyToEventIds.set(sportKey, new Set());
    sportKeyToEventIds.get(sportKey)!.add(eventId);
  }

  if (sportKeyToEventIds.size === 0) return;

  // Fetch completed scores per sport key and build a result map: eventId → OddsApiScore
  const completedEvents = new Map<string, OddsApiScore>();
  for (const sportKey of sportKeyToEventIds.keys()) {
    const scores = await fetchScoresForSport(sportKey);
    for (const evt of scores) {
      if (evt.completed) completedEvents.set(evt.id, evt);
    }
    await new Promise(r => setTimeout(r, 250)); // polite pause between API calls
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
