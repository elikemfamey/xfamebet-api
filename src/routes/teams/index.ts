import { Router } from 'express';
import { resolveTeamLogo } from '../../services/teamLogoService';
import { sendSuccess, sendError } from '../../utils/response';
import { logger } from '../../utils/logger';

const router = Router();

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
