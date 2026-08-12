import cron from 'node-cron';
import { supabase } from '../config/supabase';
import { redis } from '../config/redis';
import { fetchAndCacheLiveScores as fetchFromSportMonks, fetchLatestLiveScoreUpdates } from '../services/sportmonksLiveScoreService';
import { fetchAndCacheLiveScores as fetchFromApiFootball, getCachedLiveScores } from '../services/liveScoreService';
import { ensureSportMonksFixtureMapping, resolveCanonicalEventId } from '../services/liveFixtureIdentityService';
import { ingestLiveOddsForEvents } from '../services/sportmonksLiveOddsService';
import { SimulationEngine } from '../services/simulationEngine';
import { ScriptedMatchEngine } from '../services/scriptedMatchEngine';
import { refreshPopularMatches } from '../services/popularMatchService';
import { logger } from '../utils/logger';
import { MoolreService } from '../services/moolreService';
import { ingestUpcomingFootballOdds, expireStaleUpcomingFootballOdds } from '../services/upcomingFootballOddsService';
import { settlePendingBets } from '../services/betSettlementService';

async function fetchLiveScores(): Promise<void> {
  try {
    await fetchFromApiFootball();
    await redis.set('live_scores:provider_health', JSON.stringify({ activeSource: 'api_football', lastSuccessAt: new Date().toISOString(), lastFailureAt: null }));
  } catch (apiErr: any) {
    logger.warn('[LiveScores] API-Football failed, falling back to SportMonks', { message: apiErr.message });
    await fetchFromSportMonks();
    await redis.set('live_scores:provider_health', JSON.stringify({ activeSource: 'sportmonks', lastSuccessAt: new Date().toISOString(), lastFailureAt: new Date().toISOString(), lastFailure: apiErr.message }));
  }
}

async function fetchLiveOdds(): Promise<void> {
  const scores = await getCachedLiveScores();
  const events = await Promise.all(scores.map(async score => {
    const eventId = await resolveCanonicalEventId(score);
    // Mapping is an optimisation for SportMonks odds. It must not prevent the
    // independent Odds API fallback from running during a SportMonks outage.
    try { await ensureSportMonksFixtureMapping(score, eventId); }
    catch (err: any) { logger.warn('[LiveOdds] SportMonks fixture mapping failed', { eventId, message: err.message }); }
    return { eventId, eventName: `${score.home_team} vs ${score.away_team}`, league: score.league || null, startsAt: score.starts_at ?? null,
      homeScore: score.home_score, awayScore: score.away_score, minute: score.minute, status: score.status_short };
  }));
  await ingestLiveOddsForEvents(events);
}

export function startWorkers() {
  // Recover Moolre deposits when a provider callback was delayed or missed.
  cron.schedule('*/15 * * * *', async () => {
    if (!MoolreService.isConfigured()) return;
    try {
      const { data: pending } = await supabase.from('deposit_requests')
        .select('id, reference, amount').eq('payment_provider', 'moolre').eq('status', 'pending')
        .lt('created_at', new Date(Date.now() - 60_000).toISOString()).limit(100);
      for (const deposit of pending ?? []) {
        try { await MoolreService.verifyAndCredit(deposit); }
        catch (err) { logger.warn('Moolre reconciliation failed', { depositId: deposit.id, err }); }
      }
    } catch (err) { logger.error('Moolre reconciliation worker error', { err }); }
  });
  // Refresh popular matches every day at midnight
  cron.schedule('0 0 * * *', async () => {
    try {
      await refreshPopularMatches();
    } catch (err) {
      logger.error('Popular matches refresh error', { err });
    }
  });

  // Reset responsible gambling daily counters at midnight
  cron.schedule('0 0 * * *', async () => {
    try {
      await supabase.from('responsible_gambling_limits')
        .update({ current_amount: 0, period_reset_at: new Date().toISOString() })
        .eq('period', 'daily');
      logger.info('Daily RG limits reset');
    } catch (err) {
      logger.error('RG limits reset error', { err });
    }
  });

  // Reset weekly limits on Monday midnight
  cron.schedule('0 0 * * 1', async () => {
    try {
      await supabase.from('responsible_gambling_limits')
        .update({ current_amount: 0, period_reset_at: new Date().toISOString() })
        .eq('period', 'weekly');
      logger.info('Weekly RG limits reset');
    } catch (err) {
      logger.error('Weekly RG reset error', { err });
    }
  });

  // Reset monthly limits on 1st of month
  cron.schedule('0 0 1 * *', async () => {
    try {
      await supabase.from('responsible_gambling_limits')
        .update({ current_amount: 0, period_reset_at: new Date().toISOString() })
        .eq('period', 'monthly');
      logger.info('Monthly RG limits reset');
    } catch (err) {
      logger.error('Monthly RG reset error', { err });
    }
  });

  // Expire promo codes every hour
  cron.schedule('0 * * * *', async () => {
    try {
      await supabase.from('promo_codes')
        .update({ status: 'expired' })
        .eq('status', 'active')
        .lt('expires_at', new Date().toISOString());
    } catch (err) {
      logger.error('Promo code expiry error', { err });
    }
  });

  // Expire bonus grants
  cron.schedule('0 * * * *', async () => {
    try {
      await supabase.from('user_bonus_grants')
        .update({ status: 'expired' })
        .eq('status', 'active')
        .lt('expires_at', new Date().toISOString());
    } catch (err) {
      logger.error('Bonus grant expiry error', { err });
    }
  });

  // Claim due matches every five seconds. The status predicate makes this safe across workers.
  setInterval(async () => {
    try {
      const { data: due } = await supabase
        .from('simulated_matches')
        .select('id, is_scripted, sport')
        .eq('status', 'scheduled')
        .lte('scheduled_at', new Date().toISOString());

      for (const match of due ?? []) {
        const { data: claimed } = await supabase.from('simulated_matches')
          .update({ status: 'live', started_at: new Date().toISOString(), paused_at: null })
          .eq('id', match.id).eq('status', 'scheduled').select('id').single();
        if (!claimed) continue;
        const isScripted = (match as any).is_scripted;
        if (isScripted) {
          if (!ScriptedMatchEngine.isActive(match.id)) {
            await ScriptedMatchEngine.startMatch(match.id);
            logger.info(`Auto-started scripted match ${match.id}`);
          }
        } else {
          if (!SimulationEngine.isActive(match.id)) {
            await SimulationEngine.startMatch(match.id);
            logger.info(`Auto-started simulation match ${match.id}`);
          }
        }
      }
    } catch (err) {
      logger.error('Match auto-start error', { err });
    }
  }, 5_000);

  // Sportsbook/live data ingestion. Simulations are started only through admin routes.

  // Upcoming football is deliberately independent from live odds: SportMonks
  // is primary and The Odds API is used only by its dedicated fallback service.
  cron.schedule('0 */5 * * *', () => {
    ingestUpcomingFootballOdds().catch(err => logger.error('Upcoming football odds worker error', { err }));
  });
  // A five-hour refresh must not leave old prices bettable for the remaining gap.
  cron.schedule('0 * * * *', () => {
    expireStaleUpcomingFootballOdds().catch(err => logger.error('Upcoming football odds expiry error', { err }));
  });
  cron.schedule('*/5 * * * *', () => {
    settlePendingBets().catch(err => logger.error('Football settlement worker error', { err }));
  });

  // Fetch live scores every minute — SportMonks primary, api-football fallback
  setInterval(async () => {
    try {
      await fetchLiveScores();
    } catch (err) {
      logger.error('Live scores worker error', { err });
    }
  }, 30_000);

  // Poll SportMonks /livescores/latest every 15 seconds for incremental updates
  // (only fixtures that changed in the last 10s — cheap, high-frequency)
  setInterval(() => { fetchLiveOdds().catch(err => logger.warn('Live odds worker error', { err })); }, 15_000);

  // Run one immediate ingestion pass on startup (non-blocking)
  setImmediate(async () => {
    // Start the small, customer-facing upcoming pipeline first. The older
    // live-score refresh may take longer and must not delay it.
    ingestUpcomingFootballOdds().catch(err => logger.error('Initial upcoming football ingestion error', { err }));
    try {
      await fetchLiveScores();
      await fetchLiveOdds();
      await settlePendingBets();
      await refreshPopularMatches();
    } catch (err) {
      logger.error('Initial ingestion error', { err });
    }
  });

  // Recover simulations that were live when the server last crashed/restarted.
  // resumeMatch calculates the correct minute from started_at, so the timer
  // picks up at the actual elapsed time rather than the last saved DB tick.
  setImmediate(async () => {
    try {
      const { data: liveMatches } = await supabase
        .from('simulated_matches')
        .select('id, is_scripted')
        .eq('status', 'live');
      for (const match of liveMatches ?? []) {
        if ((match as any).is_scripted) {
          await ScriptedMatchEngine.resumeMatch(match.id);
        } else {
          await SimulationEngine.resumeMatch(match.id);
        }
        logger.info(`Recovered live simulation ${match.id} after restart`);
      }
    } catch (err) {
      logger.error('Simulation recovery error', { err });
    }
  });

  logger.info('Background workers started');
}
