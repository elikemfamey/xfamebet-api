export const MOOLRE_PROMPT_RETRY_DELAY_MS = 90_000;

export type MoolreMetadata = Record<string, unknown>;

export function getMoolreMetadata(value: unknown): MoolreMetadata {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as MoolreMetadata : {};
}

export function getMoolreRetryState(
  deposit: { created_at: string; metadata?: unknown },
  now = Date.now(),
) {
  const metadata = getMoolreMetadata(deposit.metadata);
  const requestedAtValue = typeof metadata.prompt_requested_at === 'string'
    ? metadata.prompt_requested_at
    : deposit.created_at;
  const requestedAt = new Date(requestedAtValue).getTime();
  const elapsed = Number.isFinite(requestedAt) ? Math.max(0, now - requestedAt) : 0;
  const retryAlreadyUsed = typeof metadata.retry_reference === 'string' || typeof metadata.retry_of === 'string';
  const retryAfterMs = retryAlreadyUsed ? 0 : Math.max(0, MOOLRE_PROMPT_RETRY_DELAY_MS - elapsed);
  return {
    retry_allowed: !retryAlreadyUsed && retryAfterMs === 0,
    retry_after_seconds: Math.ceil(retryAfterMs / 1000),
  };
}
