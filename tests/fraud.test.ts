import { FraudService } from '../src/services/fraudService';

jest.mock('../src/config/supabase');
jest.mock('../src/config/redis');

describe('FraudService', () => {
  describe('calculateEventScore', () => {
    it('returns high score for emulator detection', async () => {
      const score = await FraudService.calculateEventScore('user-1', 'emulator_detected', { ip: '1.2.3.4' });
      expect(score).toBeGreaterThanOrEqual(35);
    });

    it('returns low score for normal login', async () => {
      const score = await FraudService.calculateEventScore('user-1', 'login', { ip: '1.2.3.4' });
      expect(score).toBeLessThanOrEqual(10);
    });

    it('caps score at 100', async () => {
      const score = await FraudService.calculateEventScore('user-1', 'multiple_accounts', { ip: '1.2.3.4' });
      expect(score).toBeLessThanOrEqual(100);
    });
  });

  describe('risk levels', () => {
    it('maps scores to correct levels', () => {
      const getLevel = (score: number) =>
        score >= 81 ? 'critical' : score >= 61 ? 'high' : score >= 31 ? 'medium' : 'low';

      expect(getLevel(15)).toBe('low');
      expect(getLevel(45)).toBe('medium');
      expect(getLevel(70)).toBe('high');
      expect(getLevel(90)).toBe('critical');
    });
  });
});
