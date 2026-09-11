import { sendError } from '../src/utils/response';

describe('global withdrawal lock API contract', () => {
  it('returns the stable lock code and HTTP 423', () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const response = { status } as any;

    sendError(response, 'Scheduled payout maintenance', 423, 'WITHDRAWALS_LOCKED');

    expect(status).toHaveBeenCalledWith(423);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: 'Scheduled payout maintenance',
      code: 'WITHDRAWALS_LOCKED',
    });
  });
});
