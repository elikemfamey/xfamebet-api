import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../../config/supabase';
import { redis } from '../../config/redis';
import { authenticate, requireAdmin } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { sendSuccess, sendError, sendPaginated } from '../../utils/response';
import { SimulationEngine } from '../../services/simulationEngine';
import { ScriptedMatchEngine } from '../../services/scriptedMatchEngine';
import { getIO } from '../../socket';

async function bustLiveFeedCache(sport?: string) {
  await Promise.all([
    redis.del('live_feed:'),
    sport ? redis.del(`live_feed:${sport}`) : Promise.resolve(),
  ]);
}

const router = Router();

// ── Shared engine dispatcher ──────────────────────────────────────────────────

function engine(isScripted: boolean) {
  return isScripted ? ScriptedMatchEngine : SimulationEngine;
}

// Strip admin-only fields before sending match data to regular users
const ADMIN_FIELDS = ['is_scripted', 'script_events', 'script_stats', 'is_admin_created', 'created_by'] as const;
function redact(row: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...row };
  for (const key of ADMIN_FIELDS) delete clean[key];
  return clean;
}

// ── Public read endpoints ─────────────────────────────────────────────────────

// GET /simulation/live — virtual sports tab only
router.get('/live', async (_req, res) => {
  const { data } = await supabase.from('simulated_matches')
    .select('*')
    .eq('status', 'live')
    .ilike('sport', 'virtual_%')
    .order('started_at', { ascending: false });
  return sendSuccess(res, (data ?? []).map(redact));
});

// GET /simulation/scheduled — upcoming virtual matches
router.get('/scheduled', async (_req, res) => {
  const { data } = await supabase.from('simulated_matches')
    .select('*')
    .eq('status', 'scheduled')
    .ilike('sport', 'virtual_%')
    .order('scheduled_at', { ascending: true })
    .limit(20);
  return sendSuccess(res, (data ?? []).map(redact));
});

// GET /simulation/:id
router.get('/:id', async (req, res) => {
  const { data } = await supabase.from('simulated_matches')
    .select('*').eq('id', req.params.id).single();
  if (!data) return sendError(res, 'Match not found', 404);
  return sendSuccess(res, redact(data as Record<string, unknown>));
});

// GET /simulation/:id/stats
router.get('/:id/stats', async (req, res) => {
  const stats = await SimulationEngine.getMatchStats(req.params.id);
  return sendSuccess(res, stats);
});

// GET /simulation/:id/commentary
router.get('/:id/commentary', async (req, res) => {
  const { data } = await supabase.from('match_events')
    .select('*').eq('simulation_id', req.params.id)
    .order('minute', { ascending: true });
  return sendSuccess(res, data ?? []);
});

// GET /simulation/:id/heatmap
router.get('/:id/heatmap', async (req, res) => {
  const heatmap = await SimulationEngine.generateHeatmap(req.params.id);
  return sendSuccess(res, heatmap);
});

// ── Validation schemas ────────────────────────────────────────────────────────

const scriptEventSchema = z.object({
  minute:      z.number().int().min(1).max(120),
  type:        z.enum(['goal', 'yellow_card', 'red_card', 'foul', 'corner', 'substitution', 'penalty_missed', 'var_check', 'offside']),
  team:        z.enum(['home', 'away']),
  player:      z.string().optional(),
  player_off:  z.string().optional(),
  player_on:   z.string().optional(),
  assist:      z.string().optional(),
  commentary:  z.string().optional(),
});

const scriptStatsSchema = z.object({
  final_possession_home: z.number().min(20).max(80).optional(),
  final_shots_home:      z.number().int().min(0).max(40).optional(),
  final_shots_away:      z.number().int().min(0).max(40).optional(),
  final_fouls_home:      z.number().int().min(0).max(30).optional(),
  final_fouls_away:      z.number().int().min(0).max(30).optional(),
  final_corners_home:    z.number().int().min(0).max(20).optional(),
  final_corners_away:    z.number().int().min(0).max(20).optional(),
});

const createSchema = z.object({
  // Teams
  team_a:    z.string().min(1),
  team_b:    z.string().min(1),
  home_logo: z.string().url().optional(),
  away_logo: z.string().url().optional(),

  // Match metadata
  sport:            z.string().default('football'),
  competition:      z.string().default('XfameBet League'),
  venue:            z.string().optional(),
  duration_minutes: z.number().min(1).max(90).default(90),

  // Simulation parameters (used only for non-scripted matches)
  team_a_strength:    z.number().min(1).max(10).default(6),
  team_b_strength:    z.number().min(1).max(10).default(6),
  home_tactics:       z.enum(['attacking', 'balanced', 'defensive', 'possession']).default('balanced'),
  away_tactics:       z.enum(['attacking', 'balanced', 'defensive', 'possession']).default('balanced'),
  goal_probability:   z.number().min(0.005).max(0.12).default(0.03),
  card_probability:   z.number().min(0.005).max(0.15).default(0.05),
  corner_probability: z.number().min(0.01).max(0.3).default(0.08),

  // Odds
  initial_home_odds: z.number().min(1.01).optional(),
  initial_draw_odds: z.number().min(1.01).optional(),
  initial_away_odds: z.number().min(1.01).optional(),

  // Markets
  markets: z.array(z.string()).default(['match_winner', 'over_under', 'btts']),

  // Scheduling — use 'now' to start immediately or an ISO datetime string
  scheduled_at: z.enum(['now']).or(z.string().datetime()).default('now'),

  // Scripted match fields
  is_scripted:     z.boolean().default(false),
  script_events:   z.array(scriptEventSchema).default([]),
  script_stats:    scriptStatsSchema.optional(),
  // Declare the winner upfront so the system knows how to settle bets
  declared_result: z.enum(['home', 'draw', 'away']).optional(),
});

const editSchema = z.object({
  team_a:            z.string().min(1).optional(),
  team_b:            z.string().min(1).optional(),
  home_logo:         z.string().url().optional(),
  away_logo:         z.string().url().optional(),
  competition:       z.string().optional(),
  venue:             z.string().optional(),
  scheduled_at:      z.string().datetime().optional(),
  initial_home_odds: z.number().min(1.01).optional(),
  initial_draw_odds: z.number().min(1.01).optional(),
  initial_away_odds: z.number().min(1.01).optional(),
  markets:           z.array(z.string()).optional(),
  script_events:     z.array(scriptEventSchema).optional(),
  script_stats:      scriptStatsSchema.optional(),
  declared_result:   z.enum(['home', 'draw', 'away']).optional(),
});

// ── Admin: create ─────────────────────────────────────────────────────────────

router.post('/admin/create', authenticate, requireAdmin, validateBody(createSchema), async (req, res) => {
  const body = req.body;
  const user = (req as any).user;

  const scheduledAt = body.scheduled_at === 'now'
    ? new Date(Date.now() + 5000).toISOString()
    : body.scheduled_at;

  const baseInsert: Record<string, unknown> = {
    team_a:           body.team_a,
    team_b:           body.team_b,
    sport:            body.sport,
    league_name:      body.competition,
    duration_minutes: body.duration_minutes,
    team_a_strength:  body.team_a_strength,
    team_b_strength:  body.team_b_strength,
    goal_probability: body.goal_probability,
    card_probability: body.card_probability,
    scheduled_at:     scheduledAt,
    status:           'scheduled',
  };

  const extendedInsert = {
    ...baseInsert,
    home_logo:         body.home_logo,
    away_logo:         body.away_logo,
    competition:       body.competition,
    venue:             body.venue,
    home_tactics:      body.home_tactics,
    away_tactics:      body.away_tactics,
    corner_probability: body.corner_probability,
    initial_home_odds: body.initial_home_odds,
    initial_draw_odds: body.initial_draw_odds,
    initial_away_odds: body.initial_away_odds,
    markets:           body.markets,
    is_admin_created:  true,
    created_by:        user?.id,
    // scripted fields
    is_scripted:     body.is_scripted,
    script_events:   body.script_events,
    script_stats:    body.script_stats ?? {},
    declared_result: body.declared_result ?? null,
  };

  let insertResult = await supabase.from('simulated_matches').insert(extendedInsert).select().single();
  if (insertResult.error) {
    // Fallback: extended columns not yet migrated
    insertResult = await supabase.from('simulated_matches').insert(baseInsert).select().single();
  }
  const { data, error } = insertResult;
  if (error) return sendError(res, error.message, 500);

  // Generate initial odds
  if ((data as any).is_scripted) {
    await ScriptedMatchEngine.generateOdds(data.id, {
      homeOdds: body.initial_home_odds,
      drawOdds: body.initial_draw_odds,
      awayOdds: body.initial_away_odds,
    });
  } else {
    await SimulationEngine.generateOdds(data.id, data.team_a_strength, data.team_b_strength, {
      homeOdds: body.initial_home_odds,
      drawOdds: body.initial_draw_odds,
      awayOdds: body.initial_away_odds,
    });
  }

  return sendSuccess(res, data, 201);
});

// ── Admin: edit match before it starts ───────────────────────────────────────

router.patch('/admin/:id/edit', authenticate, requireAdmin, validateBody(editSchema), async (req, res) => {
  const { id } = req.params;

  const { data: match } = await supabase.from('simulated_matches').select('status').eq('id', id).single();
  if (!match) return sendError(res, 'Match not found', 404);
  if (match.status !== 'scheduled') return sendError(res, 'Only scheduled matches can be edited', 400);

  const updates: Record<string, unknown> = {};
  const b = req.body;
  if (b.team_a !== undefined)            updates.team_a = b.team_a;
  if (b.team_b !== undefined)            updates.team_b = b.team_b;
  if (b.home_logo !== undefined)         updates.home_logo = b.home_logo;
  if (b.away_logo !== undefined)         updates.away_logo = b.away_logo;
  if (b.competition !== undefined)       { updates.competition = b.competition; updates.league_name = b.competition; }
  if (b.venue !== undefined)             updates.venue = b.venue;
  if (b.scheduled_at !== undefined)      updates.scheduled_at = b.scheduled_at;
  if (b.initial_home_odds !== undefined) updates.initial_home_odds = b.initial_home_odds;
  if (b.initial_draw_odds !== undefined) updates.initial_draw_odds = b.initial_draw_odds;
  if (b.initial_away_odds !== undefined) updates.initial_away_odds = b.initial_away_odds;
  if (b.markets !== undefined)           updates.markets = b.markets;
  if (b.script_events !== undefined)     updates.script_events = b.script_events;
  if (b.script_stats !== undefined)      updates.script_stats = b.script_stats;
  if (b.declared_result !== undefined)   updates.declared_result = b.declared_result;

  const { data, error } = await supabase.from('simulated_matches')
    .update(updates).eq('id', id).select().single();
  if (error) return sendError(res, error.message, 500);

  // Re-generate odds if any odds field changed
  const oddsChanged = b.initial_home_odds !== undefined || b.initial_draw_odds !== undefined || b.initial_away_odds !== undefined;
  if (oddsChanged) {
    const { data: m } = await supabase.from('simulated_matches').select('is_scripted').eq('id', id).single();
    if ((m as any)?.is_scripted) {
      await ScriptedMatchEngine.generateOdds(id, { homeOdds: b.initial_home_odds, drawOdds: b.initial_draw_odds, awayOdds: b.initial_away_odds });
    } else {
      await SimulationEngine.generateOdds(id, 6, 6, { homeOdds: b.initial_home_odds, drawOdds: b.initial_draw_odds, awayOdds: b.initial_away_odds });
    }
  }

  return sendSuccess(res, data);
});

// ── Admin: start ──────────────────────────────────────────────────────────────

router.post('/admin/:id/start', authenticate, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { data: match } = await supabase.from('simulated_matches').select('*').eq('id', id).single();
  if (!match) return sendError(res, 'Match not found', 404);
  if (!['scheduled', 'paused'].includes(match.status)) return sendError(res, 'Match cannot be started', 400);

  await supabase.from('simulated_matches')
    .update({ status: 'live', started_at: new Date().toISOString(), paused_at: null })
    .eq('id', id);

  // Ensure any accidentally-suspended odds are cleared before the match goes live
  await supabase.from('odds_feed')
    .update({ status: 'active' })
    .eq('event_id', `sim:${id}`)
    .eq('source', 'simulation');

  if ((match as any).is_scripted) {
    await ScriptedMatchEngine.startMatch(id);
  } else {
    SimulationEngine.startMatch(id);
  }

  // Notify all connected clients that a match went live and bust the cached feed
  try {
    getIO().emit('simulation:live', { matchId: id, status: 'live', sport: match.sport });
  } catch {}
  await bustLiveFeedCache(match.sport);

  return sendSuccess(res, { message: 'Match started' });
});

// ── Admin: pause ──────────────────────────────────────────────────────────────

router.post('/admin/:id/pause', authenticate, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { data: match } = await supabase.from('simulated_matches').select('is_scripted').eq('id', id).single();

  if ((match as any)?.is_scripted) ScriptedMatchEngine.pauseMatch(id);
  else SimulationEngine.pauseMatch(id);

  await supabase.from('simulated_matches')
    .update({ status: 'paused', paused_at: new Date().toISOString() })
    .eq('id', id);
  return sendSuccess(res, { message: 'Match paused' });
});

// ── Admin: resume ─────────────────────────────────────────────────────────────

router.post('/admin/:id/resume', authenticate, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { data: match } = await supabase.from('simulated_matches').select('is_scripted').eq('id', id).single();

  // Clear any suspended odds before resuming
  await supabase.from('odds_feed')
    .update({ status: 'active' })
    .eq('event_id', `sim:${id}`)
    .eq('source', 'simulation');

  if ((match as any)?.is_scripted) await ScriptedMatchEngine.resumeMatch(id);
  else SimulationEngine.resumeMatch(id);

  await supabase.from('simulated_matches')
    .update({ status: 'live', paused_at: null })
    .eq('id', id);
  return sendSuccess(res, { message: 'Match resumed' });
});

// ── Admin: stop ───────────────────────────────────────────────────────────────

router.post('/admin/:id/stop', authenticate, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { data: match } = await supabase.from('simulated_matches').select('is_scripted').eq('id', id).single();

  if ((match as any)?.is_scripted) ScriptedMatchEngine.stopMatch(id);
  else SimulationEngine.stopMatch(id);

  const { data: stoppedMatch } = await supabase.from('simulated_matches')
    .update({ status: 'cancelled', ended_at: new Date().toISOString() })
    .eq('id', id)
    .select('sport')
    .single();

  try {
    getIO().emit('simulation:live', { matchId: id, status: 'cancelled' });
  } catch {}
  await bustLiveFeedCache(stoppedMatch?.sport);

  return sendSuccess(res, { message: 'Match stopped' });
});

// ── Admin: override score ─────────────────────────────────────────────────────

router.post('/admin/:id/edit-score', authenticate, requireAdmin, validateBody(z.object({
  home_score: z.number().int().min(0),
  away_score: z.number().int().min(0),
})), async (req, res) => {
  const { id } = req.params;
  const { data: match } = await supabase.from('simulated_matches').select('is_scripted, sport').eq('id', id).single();

  const isScripted = (match as any)?.is_scripted;
  const eventId = `sim:${id}`;

  // Suspend odds for 5 seconds so users can't bet on stale odds during update
  await supabase.from('odds_feed').update({ status: 'suspended' })
    .eq('event_id', eventId).eq('source', 'simulation');
  try { getIO().emit('odds:suspended', { eventId }); } catch {}

  await new Promise(resolve => setTimeout(resolve, 5000));

  if (isScripted) ScriptedMatchEngine.overrideScore(id, req.body.home_score, req.body.away_score);
  else SimulationEngine.overrideScore(id, req.body.home_score, req.body.away_score);

  await supabase.from('simulated_matches')
    .update({ team_a_score: req.body.home_score, team_b_score: req.body.away_score })
    .eq('id', id);

  // Reopen odds and push updated score to all connected clients
  await supabase.from('odds_feed').update({ status: 'active' })
    .eq('event_id', eventId).eq('source', 'simulation');
  try { getIO().emit('odds:active', { eventId }); } catch {}

  if (isScripted) ScriptedMatchEngine.broadcastState(id);
  else SimulationEngine.broadcastState(id);

  await bustLiveFeedCache(match?.sport);

  return sendSuccess(res, { message: 'Score updated' });
});

// ── Admin: inject event ───────────────────────────────────────────────────────

router.post('/admin/:id/inject-event', authenticate, requireAdmin, validateBody(z.object({
  event_type:  z.enum(['goal', 'yellow_card', 'red_card', 'foul', 'corner', 'substitution', 'penalty_missed', 'var_check', 'offside']),
  team:        z.enum(['home', 'away']),
  player_name: z.string().optional(),
  commentary:  z.string().optional(),
})), async (req, res) => {
  const { id } = req.params;
  const { data: match } = await supabase.from('simulated_matches').select('is_scripted').eq('id', id).single();
  const isScriptedMatch = (match as any)?.is_scripted ?? false;
  const eng = engine(isScriptedMatch);

  await eng.injectEvent(id, req.body.event_type, req.body.team, req.body.player_name, req.body.commentary);

  // Push updated score to clients immediately after goal injection
  if (isScriptedMatch) ScriptedMatchEngine.broadcastState(id);
  else SimulationEngine.broadcastState(id);

  return sendSuccess(res, { message: 'Event injected' });
});

// ── Admin: delete simulation ──────────────────────────────────────────────────

router.delete('/admin/:id', authenticate, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const eventId = `sim:${id}`;

  const { data: match } = await supabase
    .from('simulated_matches')
    .select('is_scripted, sport, status')
    .eq('id', id)
    .single();

  if (!match) return sendError(res, 'Simulation not found', 404);

  // Stop the engine if it is actively running
  if (['live', 'paused'].includes((match as any).status)) {
    if ((match as any).is_scripted) ScriptedMatchEngine.stopMatch(id);
    else SimulationEngine.stopMatch(id);
  }

  // Remove all odds for this simulation from the sportsbook
  await supabase.from('odds_feed').delete().eq('event_id', eventId);

  // Hard-delete the match record (cascades to match_events)
  await supabase.from('simulated_matches').delete().eq('id', id);

  // Bust every relevant cache entry
  const cacheKeys: string[] = ['live_feed:', `live_feed:${(match as any).sport}`, `live_odds:${eventId}`];
  const extraKeys = await redis.keys(`live_feed:*`);
  const allKeys = Array.from(new Set([...cacheKeys, ...extraKeys]));
  if (allKeys.length > 0) await redis.del(...allKeys);

  // Notify all connected clients so they remove the match instantly
  try {
    getIO().emit('simulation:deleted', { matchId: id });
  } catch {}

  return sendSuccess(res, { message: 'Simulation deleted' });
});

// ── Admin: monitoring dashboard ───────────────────────────────────────────────

router.get('/admin/all', authenticate, requireAdmin, async (req, res) => {
  const page  = parseInt(req.query.page as string) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  const { data, count } = await supabase.from('simulated_matches')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  return sendPaginated(res, data ?? [], count ?? 0, page, limit);
});

export default router;
