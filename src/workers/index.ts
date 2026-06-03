import cron from 'node-cron';
import { supabase } from '../config/supabase';
import { SimulationEngine } from '../services/simulationEngine';
import { ingestAllOdds } from '../services/oddsIngestionService';
import { fetchAndCacheLiveScores } from '../services/liveScoreService';
import { logger } from '../utils/logger';

export function startWorkers() {
  // Auto-start scheduled simulations every minute
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date().toISOString();
      const { data: matches } = await supabase
        .from('simulated_matches')
        .select('id')
        .eq('status', 'scheduled')
        .lte('scheduled_at', now);

      if (matches && matches.length > 0) {
        for (const match of matches) {
          await supabase.from('simulated_matches')
            .update({ status: 'live', started_at: now })
            .eq('id', match.id);
          SimulationEngine.startMatch(match.id);
          logger.info(`Auto-started simulation ${match.id}`);
        }
      }
    } catch (err) {
      logger.error('Simulation scheduler error', { err });
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

  // ── Virtual sports rounds (Sportybet-style) ─────────────────────────────
  // 4 simultaneous virtual_football matches every 4 min (~3 min real time each)
  // NOTE: uses only original schema columns — no is_admin_created / competition needed

  const VIRTUAL_COMPETITIONS = [
    {
      name: 'XfameBet Virtual Premier League',
      teams: [['Lions FC', 'Eagles United'], ['City Stars', 'River Hawks'], ['Thunder FC', 'Red Storm'], ['Golden Boys', 'Blue Wolves']],
    },
    {
      name: 'XfameBet Virtual Champions Cup',
      teams: [['Royal Madrid', 'Paris Tigers'], ['Bayern Stars', 'Inter City'], ['London Reds', 'Porto Blues'], ['Ajax Kings', 'Roma Whites']],
    },
    {
      name: 'XfameBet Virtual Africa Cup',
      teams: [['Accra Lions', 'Kumasi Royals'], ['Lagos Stars', 'Abuja Eagles'], ['Cape Town FC', 'Nairobi United'], ['Cairo Giants', 'Dakar Reds']],
    },
    {
      name: 'XfameBet Virtual Super League',
      teams: [['Flame United', 'Ice Warriors'], ['Storm FC', 'Thunder Bolts'], ['Desert Hawks', 'Arctic Bears'], ['Night Wolves', 'Dawn Phoenix']],
    },
  ];

  async function scheduleVirtualRound() {
    const scheduledAt = new Date(Date.now() + 10000).toISOString();
    for (const comp of VIRTUAL_COMPETITIONS) {
      const pick = comp.teams[Math.floor(Math.random() * comp.teams.length)];
      const strA = 4 + Math.random() * 3;
      const strB = 4 + Math.random() * 3;
      try {
        const { data: match } = await supabase.from('simulated_matches').insert({
          team_a: pick[0], team_b: pick[1],
          sport: 'virtual_football',
          duration_minutes: 90,
          league_name: comp.name,
          team_a_strength: strA, team_b_strength: strB,
          goal_probability: 0.025 + Math.random() * 0.02,
          card_probability: 0.04 + Math.random() * 0.02,
          scheduled_at: scheduledAt,
          status: 'scheduled',
        }).select().single();
        if (match) await SimulationEngine.generateOdds(match.id, strA, strB);
      } catch (e) {
        logger.error('Failed to schedule virtual match', { comp: comp.name, e });
      }
    }
    logger.info(`[Virtual] Scheduled round of ${VIRTUAL_COMPETITIONS.length} matches`);
  }

  cron.schedule('*/4 * * * *', async () => {
    try {
      const { count } = await supabase.from('simulated_matches')
        .select('id', { count: 'exact' })
        .in('status', ['scheduled', 'live'])
        .ilike('sport', 'virtual_%');
      if ((count ?? 0) < VIRTUAL_COMPETITIONS.length) await scheduleVirtualRound();
    } catch (err) {
      logger.error('Virtual round scheduler error', { err });
    }
  });

  // ── Real sportsbook data ingestion ─────────────────────────────────────────
  // Sportsbook/Live shows ONLY real odds from The Odds API.
  // Admin can manually publish a simulation to the sportsbook via the admin panel.

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

      // Seed virtual round if none running
      const { count: vCount } = await supabase.from('simulated_matches')
        .select('id', { count: 'exact' })
        .in('status', ['scheduled', 'live'])
        .ilike('sport', 'virtual_%');
      if ((vCount ?? 0) === 0) await scheduleVirtualRound();
    } catch (err) {
      logger.error('Initial ingestion error', { err });
    }
  });

  logger.info('Background workers started');
}
