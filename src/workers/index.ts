import cron from 'node-cron';
import { supabase } from '../config/supabase';
import { ingestAllOdds, getActiveSports } from '../services/oddsIngestionService';
import { fetchAndCacheLiveScores as fetchFromSportMonks, fetchLatestLiveScoreUpdates } from '../services/sportmonksLiveScoreService';
import { fetchAndCacheLiveScores as fetchFromApiFootball } from '../services/liveScoreService';
import { fetchAllSportsScores } from '../services/oddsApiScoreService';
import { settlePendingBets } from '../services/betSettlementService';
import { SimulationEngine } from '../services/simulationEngine';
import { ScriptedMatchEngine } from '../services/scriptedMatchEngine';
import { refreshPopularMatches } from '../services/popularMatchService';
import { logger } from '../utils/logger';

async function fetchLiveScores(): Promise<void> {
  try {
    await fetchFromSportMonks();
  } catch (smErr: any) {
    logger.warn('[LiveScores] SportMonks failed, falling back to api-football', { message: smErr.message });
    await fetchFromApiFootball();
  }
}

export function startWorkers() {
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

  // Auto-start scripted matches at their scheduled time (checks every minute)
  cron.schedule('* * * * *', async () => {
    try {
      const { data: due } = await supabase
        .from('simulated_matches')
        .select('id')
        .eq('status', 'scheduled')
        .eq('is_scripted', true)
        .lte('scheduled_at', new Date().toISOString());

      for (const match of due ?? []) {
        if (!ScriptedMatchEngine.isActive(match.id)) {
          await supabase.from('simulated_matches')
            .update({ status: 'live', started_at: new Date().toISOString() })
            .eq('id', match.id);
          await ScriptedMatchEngine.startMatch(match.id);
          logger.info(`Auto-started scripted match ${match.id}`);
        }
      }
    } catch (err) {
      logger.error('Scripted match auto-start error', { err });
    }
  });

  // Sportsbook/live data ingestion. Simulations are started only through admin routes.

  // Ingest real odds from The Odds API every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      await ingestAllOdds();
    } catch (err) {
      logger.error('Odds ingestion worker error', { err });
    }
  });

  // Fetch live scores every minute — SportMonks primary, api-football fallback
  cron.schedule('* * * * *', async () => {
    try {
      await fetchLiveScores();
    } catch (err) {
      logger.error('Live scores worker error', { err });
    }
  });

  // Poll SportMonks /livescores/latest every 15 seconds for incremental updates
  // (only fixtures that changed in the last 10s — cheap, high-frequency)
  setInterval(async () => {
    try {
      await fetchLatestLiveScoreUpdates();
    } catch (err: any) {
      logger.debug('[LiveScores] Latest-update poll error', { message: err.message });
    }
  }, 15_000);

  // Fetch Odds API scores for all active sports every 2 minutes (covers all sports)
  cron.schedule('*/2 * * * *', async () => {
    try {
      const sports = await getActiveSports();
      await fetchAllSportsScores(sports.map(s => s.key));
    } catch (err) {
      logger.error('Odds API scores worker error', { err });
    }
  });

  // Auto-settle completed bets every 5 minutes using Odds API scores
  cron.schedule('*/5 * * * *', async () => {
    try {
      await settlePendingBets();
    } catch (err) {
      logger.error('Bet settlement worker error', { err });
    }
  });

  // Run one immediate ingestion pass on startup (non-blocking)
  setImmediate(async () => {
    try {
      await ingestAllOdds();
      await fetchLiveScores();
      const sports = await getActiveSports();
      await fetchAllSportsScores(sports.map(s => s.key));
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
