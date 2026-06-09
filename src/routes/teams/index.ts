import { Router } from 'express';
import { resolveTeamLogo } from '../../services/teamLogoService';
import { teamLogoLimiter } from '../../middleware/rateLimiter';
import { sendSuccess, sendError } from '../../utils/response';
import { logger } from '../../utils/logger';

const router = Router();

router.use(teamLogoLimiter);

// POST /api/team-logos/batch — resolve up to 100 team logos in one round-trip
router.post('/batch', async (req, res) => {
  const teams = req.body?.teams;
  if (!Array.isArray(teams) || teams.length === 0) {
    return sendError(res, 'teams array required', 400);
  }
  const capped = (teams as Array<{ name: string; sport?: string }>).slice(0, 100);
  const results = await Promise.all(
    capped.map(async ({ name, sport }) => {
      if (!name?.trim()) return { name, logo_url: null };
      const r = await resolveTeamLogo(name.trim(), undefined, sport);
      return { name: r.team_name, logo_url: r.logo_url };
    })
  );
  return sendSuccess(res, results);
});

// GET /api/team-logo/:teamName?sport=football|tennis|basketball…
// Returns { team_name, logo_url, source } — logo_url is null when not found.
router.get('/:teamName', async (req, res) => {
  const raw = req.params.teamName?.trim();
  if (!raw) return sendError(res, 'teamName is required', 400);

  const sport = req.query.sport as string | undefined;

  try {
    const result = await resolveTeamLogo(decodeURIComponent(raw), undefined, sport);
    return sendSuccess(res, result);
  } catch (err: any) {
    logger.error('[TeamLogo] Route error', { teamName: raw, error: err.message });
    return sendError(res, 'Failed to resolve team logo', 500);
  }
});

export default router;
