import { getMoolreRetryState, MOOLRE_PROMPT_RETRY_DELAY_MS } from '../src/services/moolrePaymentState';

describe('Moolre payment retry state', () => {
  const now = Date.parse('2026-10-29T17:00:00.000Z');

  it('uses the prompt request time and reports the remaining retry delay', () => {
    const state = getMoolreRetryState({
      created_at: '2026-10-29T16:55:00.000Z',
      metadata: { prompt_requested_at: '2026-10-29T16:59:30.000Z' },
    }, now);

    expect(state).toEqual({ retry_allowed: false, retry_after_seconds: 60 });
  });

  it('allows a retry after 90 seconds', () => {
    const state = getMoolreRetryState({
      created_at: new Date(now - MOOLRE_PROMPT_RETRY_DELAY_MS).toISOString(),
      metadata: {},
    }, now);

    expect(state).toEqual({ retry_allowed: true, retry_after_seconds: 0 });
  });

  it.each([
    { retry_reference: 'MLR-retry' },
    { retry_of: 'MLR-original' },
  ])('does not allow another retry once retry linkage exists', metadata => {
    const state = getMoolreRetryState({
      created_at: '2026-10-29T16:00:00.000Z',
      metadata,
    }, now);

    expect(state).toEqual({ retry_allowed: false, retry_after_seconds: 0 });
  });
});
