import { sendError } from '../src/utils/response';

describe('withdrawal deposit requirement API errors', () => {
  it('returns a stable migration-required error contract', () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const response = { status } as never;

    sendError(
      response,
      'Database migration 031 must be applied before this setting can be changed',
      503,
      'WITHDRAWAL_REQUIREMENT_MIGRATION_REQUIRED',
    );

    expect(status).toHaveBeenCalledWith(503);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: 'Database migration 031 must be applied before this setting can be changed',
      code: 'WITHDRAWAL_REQUIREMENT_MIGRATION_REQUIRED',
    });
  });
});
