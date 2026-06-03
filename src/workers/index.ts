import cron from 'node-cron';
import { supabase } from '../config/supabase';
import { ingestAllOdds } from '../services/oddsIngestionService';
import { fetchAndCacheLiveScores } from '../services/liveScoreService';
import { ScriptedMatchEngine } from '../services/scriptedMatchEngine';
import { logger } from '../utils/logger';

export function startWorkers() {
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

  // Fetch live scores from API-Football every minute
  cron.schedule('* * * * *', async () => {
    try {
      await fetchAndCacheLiveScores();
    } catch (err) {
      logger.error('Live scores worker error', { err });
    }
  });

  // Run one immediate ingestion pass on startup (non-blocking)
  setImmediate(async () => {
    try {
      await ingestAllOdds();
      await fetchAndCacheLiveScores();
    } catch (err) {
      logger.error('Initial ingestion error', { err });
    }
  });

  logger.info('Background workers started');
}
