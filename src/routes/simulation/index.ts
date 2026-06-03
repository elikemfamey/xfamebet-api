import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../../config/supabase';
import { authenticate, requireAdmin } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { sendSuccess, sendError, sendPaginated } from '../../utils/response';
import { SimulationEngine } from '../../services/simulationEngine';

const router = Router();

// ── Public read endpoints ─────────────────────────────────────────────────────

// GET /simulation/live — virtual-sports tab only (ilike virtual_% excludes admin football sims)
router.get('/live', async (_req, res) => {
  const { data } = await supabase.from('simulated_matches')
    .select('*')
    .eq('status', 'live')
    .ilike('sport', 'virtual_%')
    .order('started_at', { ascending: false });
  return sendSuccess(res, data ?? []);
});

// GET /simulation/scheduled
router.get('/scheduled', async (_req, res) => {
  const { data } = await supabase.from('simulated_matches')
    .select('*')
    .eq('status', 'scheduled')
    .ilike('sport', 'virtual_%')
    .order('scheduled_at', { ascending: true })
    .limit(20);
  return sendSuccess(res, data ?? []);
});

// GET /simulation/:id
router.get('/:id', async (req, res) => {
  const { data } = await supabase.from('simulated_matches')
    .select('*').eq('id', req.params.id).single();
  if (!data) return sendError(res, 'Match not found', 404);
  return sendSuccess(res, data);
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

// ── Admin endpoints ───────────────────────────────────────────────────────────

const createSchema = z.object({
  // Teams
  team_a: z.string().min(1),
  team_b: z.string().min(1),
  home_logo: z.string().url().optional(),
  away_logo: z.string().url().optional(),

  // Match metadata
  sport: z.string().default('football'),         // 'football' = appears in live/sportsbook
  competition: z.string().default('XfameBet League'),
  venue: z.string().optional(),
  duration_minutes: z.number().min(1).max(90).default(90),

  // AI parameters
  team_a_strength: z.number().min(1).max(10).default(6),
  team_b_strength: z.number().min(1).max(10).default(6),
  home_tactics: z.enum(['attacking', 'balanced', 'defensive', 'possession']).default('balanced'),
  away_tactics: z.enum(['attacking', 'balanced', 'defensive', 'possession']).default('balanced'),
  goal_probability: z.number().min(0.005).max(0.12).default(0.03),
  card_probability: z.number().min(0.005).max(0.15).default(0.05),
  corner_probability: z.number().min(0.01).max(0.3).default(0.08),

  // Initial odds
  initial_home_odds: z.number().min(1.01).optional(),
  initial_draw_odds: z.number().min(1.01).optional(),
  initial_away_odds: z.number().min(1.01).optional(),

  // Markets to enable
  markets: z.array(z.string()).default(['match_winner', 'over_under', 'btts']),

  // Scheduling
  start_time: z.enum(['now']).or(z.string().datetime()).default('now'),
});

// POST /simulation/admin/create
router.post('/admin/create', authenticate, requireAdmin, validateBody(createSchema), async (req, res) => {
  const body = req.body;
  const user = (req as any).user;

  const scheduledAt = body.start_time === 'now'
    ? new Date(Date.now() + 5000).toISOString()   // 5 seconds from now
    : body.start_time;

  // Build insert with only columns guaranteed to exist.
  // Migration 003 adds extra columns — insert them only if they exist to avoid errors.
  const baseInsert: Record<string, unknown> = {
    team_a: body.team_a,
    team_b: body.team_b,
    sport: body.sport,
    league_name: body.competition,  // league_name exists in original schema
    duration_minutes: body.duration_minutes,
    team_a_strength: body.team_a_strength,
    team_b_strength: body.team_b_strength,
    goal_probability: body.goal_probability,
    card_probability: body.card_probability,
    scheduled_at: scheduledAt,
    status: 'scheduled',
  };

  // Extended columns from migration 003 — safe to include; Supabase ignores unknown cols in upsert
  // but errors on insert — wrap in try/catch and fall back to base if needed
  const extendedInsert = {
    ...baseInsert,
    home_logo: body.home_logo,
    away_logo: body.away_logo,
    competition: body.competition,
    venue: body.venue,
    home_tactics: body.home_tactics,
    away_tactics: body.away_tactics,
    corner_probability: body.corner_probability,
    initial_home_odds: body.initial_home_odds,
    initial_draw_odds: body.initial_draw_odds,
    initial_away_odds: body.initial_away_odds,
    markets: body.markets,
    is_admin_created: true,
    created_by: user?.id,
  };

  let insertResult = await supabase.from('simulated_matches').insert(extendedInsert).select().single();
  if (insertResult.error) {
    // Migration 003 not yet applied — fall back to base columns
    insertResult = await supabase.from('simulated_matches').insert(baseInsert).select().single();
  }
  const { data, error } = insertResult;

  if (error) return sendError(res, error.message, 500);

  await SimulationEngine.generateOdds(data.id, data.team_a_strength, data.team_b_strength, {
    homeOdds: body.initial_home_odds,
    drawOdds: body.initial_draw_odds,
    awayOdds: body.initial_away_odds,
  });

  return sendSuccess(res, data, 201);
});

// POST /simulation/admin/:id/start
router.post('/admin/:id/start', authenticate, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { data: match } = await supabase.from('simulated_matches').select('*').eq('id', id).single();
  if (!match) return sendError(res, 'Match not found', 404);
  if (!['scheduled', 'paused'].includes(match.status)) return sendError(res, 'Match cannot be started', 400);

  await supabase.from('simulated_matches')
    .update({ status: 'live', started_at: new Date().toISOString(), paused_at: null })
    .eq('id', id);
  SimulationEngine.startMatch(id);

  return sendSuccess(res, { message: 'Match started' });
});

// POST /simulation/admin/:id/pause
router.post('/admin/:id/pause', authenticate, requireAdmin, async (req, res) => {
  const { id } = req.params;
  SimulationEngine.pauseMatch(id);
  await supabase.from('simulated_matches')
    .update({ status: 'paused', paused_at: new Date().toISOString() })
    .eq('id', id);
  return sendSuccess(res, { message: 'Match paused' });
});

// POST /simulation/admin/:id/resume
router.post('/admin/:id/resume', authenticate, requireAdmin, async (req, res) => {
  const { id } = req.params;
  SimulationEngine.resumeMatch(id);
  await supabase.from('simulated_matches')
    .update({ status: 'live', paused_at: null })
    .eq('id', id);
  return sendSuccess(res, { message: 'Match resumed' });
});

// POST /simulation/admin/:id/stop
router.post('/admin/:id/stop', authenticate, requireAdmin, async (req, res) => {
  const { id } = req.params;
  SimulationEngine.stopMatch(id);
  await supabase.from('simulated_matches')
    .update({ status: 'cancelled', ended_at: new Date().toISOString() })
    .eq('id', id);
  return sendSuccess(res, { message: 'Match stopped' });
});

// POST /simulation/admin/:id/edit-score
router.post('/admin/:id/edit-score', authenticate, requireAdmin, validateBody(z.object({
  home_score: z.number().int().min(0),
  away_score: z.number().int().min(0),
})), async (req, res) => {
  const { id } = req.params;
  SimulationEngine.overrideScore(id, req.body.home_score, req.body.away_score);
  await supabase.from('simulated_matches')
    .update({ team_a_score: req.body.home_score, team_b_score: req.body.away_score })
    .eq('id', id);
  return sendSuccess(res, { message: 'Score updated' });
});

// POST /simulation/admin/:id/inject-event
router.post('/admin/:id/inject-event', authenticate, requireAdmin, validateBody(z.object({
  event_type: z.enum(['goal', 'yellow_card', 'red_card', 'foul', 'corner', 'substitution']),
  team: z.enum(['home', 'away']),
  player_name: z.string().optional(),
  commentary: z.string().optional(),
})), async (req, res) => {
  const { id } = req.params;
  await SimulationEngine.injectEvent(id, req.body.event_type, req.body.team, req.body.player_name, req.body.commentary);
  return sendSuccess(res, { message: 'Event injected' });
});

// GET /simulation/admin/all — monitoring dashboard
router.get('/admin/all', authenticate, requireAdmin, async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  const { data, count } = await supabase.from('simulated_matches')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  return sendPaginated(res, data ?? [], count ?? 0, page, limit);
});

export default router;
