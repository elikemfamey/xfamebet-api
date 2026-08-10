import { Router } from 'express';
import { redis } from '../../config/redis';
import { supabase } from '../../config/supabase';
import { sendSuccess } from '../../utils/response';

const router = Router();
const CACHE_KEY = 'countries:public';
const CACHE_TTL = 24 * 60 * 60;

// Public, cached flag catalogue. The database is the source of truth.
router.get('/', async (_req, res) => {
  try {
    const cached = await redis.get(CACHE_KEY);
    if (cached) return sendSuccess(res, JSON.parse(cached));
  } catch {}

  const { data, error } = await supabase
    .from('countries')
    .select('code, name, flag_url')
    .order('name', { ascending: true });

  if (error) return sendSuccess(res, []);
  const countries = data ?? [];
  redis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(countries)).catch(() => {});
  return sendSuccess(res, countries);
});

export default router;
