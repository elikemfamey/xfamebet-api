import { supabase } from '../config/supabase';
import { redis, REDIS_STREAMS } from '../config/redis';
import { RiskLevel } from '../types';

interface FraudEventMeta {
  ip?: string;
  device?: string | undefined;
  [key: string]: unknown;
}

export class FraudService {
  static async emitEvent(userId: string, eventType: string, metadata: FraudEventMeta = {}) {
    const score = await FraudService.calculateEventScore(userId, eventType, metadata);

    await supabase.from('fraud_events').insert({
      user_id: userId, event_type: eventType, risk_score: score,
      ip_address: metadata.ip, device_hash: metadata.device, metadata,
    });

    // Update running risk score
    await FraudService.updateRiskScore(userId);

    // Emit to Redis stream
    await redis.xadd(REDIS_STREAMS.FRAUD_EVENTS, '*',
      'userId', userId, 'eventType', eventType, 'score', String(score), 'meta', JSON.stringify(metadata)
    );

    return score;
  }

  static async calculateEventScore(userId: string, eventType: string, metadata: FraudEventMeta): Promise<number> {
    let score = 0;

    // Base scores per event type
    const baseScores: Record<string, number> = {
      'registration': 5,
      'login': 2,
      'failed_login': 15,
      'deposit': 5,
      'withdrawal': 10,
      'bet_placement': 3,
      'large_bet': 20,
      'vpn_detected': 25,
      'proxy_detected': 20,
      'emulator_detected': 35,
      'multiple_accounts': 50,
      'bonus_abuse': 40,
      'rapid_deposit_withdrawal': 45,
      'structured_deposit': 50,
    };

    score = baseScores[eventType] ?? 5;

    // Check IP-based multi-accounting
    if (metadata.ip) {
      const { count } = await supabase.from('device_fingerprints')
        .select('user_id', { count: 'exact' })
        .eq('ip_address', metadata.ip)
        .neq('user_id', userId);
      if ((count ?? 0) > 3) score += 20;
      if ((count ?? 0) > 10) score += 30;
    }

    // Failed login accumulation
    if (eventType === 'failed_login') {
      const { count } = await supabase.from('fraud_events')
        .select('id', { count: 'exact' })
        .eq('user_id', userId)
        .eq('event_type', 'failed_login')
        .gte('created_at', new Date(Date.now() - 3600000).toISOString());
      if ((count ?? 0) > 5) score += 25;
    }

    return Math.min(score, 100);
  }

  static async updateRiskScore(userId: string) {
    const { data: events } = await supabase
      .from('fraud_events')
      .select('risk_score, event_type')
      .eq('user_id', userId)
      .gte('created_at', new Date(Date.now() - 30 * 24 * 3600000).toISOString());

    if (!events || events.length === 0) return;

    const totalScore = events.reduce((sum, e) => sum + e.risk_score, 0);
    const avgScore = totalScore / events.length;
    const maxScore = Math.max(...events.map(e => e.risk_score));
    const compositeScore = Math.min((avgScore * 0.4 + maxScore * 0.6), 100);

    const level: RiskLevel =
      compositeScore >= 81 ? 'critical' :
      compositeScore >= 61 ? 'high' :
      compositeScore >= 31 ? 'medium' : 'low';

    const factors: Record<string, number> = {};
    events.forEach(e => { factors[e.event_type] = (factors[e.event_type] ?? 0) + 1; });

    await supabase.from('risk_scores')
      .upsert({ user_id: userId, score: compositeScore, level, factors, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });

    // Auto-escalate to fraud case if critical
    if (compositeScore >= 81) {
      const { count } = await supabase.from('fraud_cases')
        .select('id', { count: 'exact' })
        .eq('user_id', userId)
        .eq('status', 'open');
      if ((count ?? 0) === 0) {
        await supabase.from('fraud_cases').insert({ user_id: userId, status: 'open', category: 'auto_escalated' });
      }
    }

    return compositeScore;
  }

  static async captureDeviceFingerprint(userId: string, fingerprintData: {
    device_hash: string; browser: string; os: string;
    screen_resolution?: string; timezone?: string; language?: string;
    webgl_data?: string; canvas_fingerprint?: string;
    ip_address: string; vpn_detected?: boolean; proxy_detected?: boolean; emulator_detected?: boolean;
  }) {
    const existing = await supabase.from('device_fingerprints')
      .select('id, banned').eq('device_hash', fingerprintData.device_hash).single();

    if (existing.data?.banned) {
      return { banned: true };
    }

    await supabase.from('device_fingerprints').upsert({
      user_id: userId, ...fingerprintData,
    }, { onConflict: 'user_id,device_hash' });

    if (fingerprintData.vpn_detected) {
      await FraudService.emitEvent(userId, 'vpn_detected', { ip: fingerprintData.ip_address });
    }
    if (fingerprintData.proxy_detected) {
      await FraudService.emitEvent(userId, 'proxy_detected', { ip: fingerprintData.ip_address });
    }
    if (fingerprintData.emulator_detected) {
      await FraudService.emitEvent(userId, 'emulator_detected', { ip: fingerprintData.ip_address });
    }

    // Check shared device multi-accounting
    const { data: sharedDeviceUsers } = await supabase
      .from('device_fingerprints')
      .select('user_id')
      .eq('device_hash', fingerprintData.device_hash)
      .neq('user_id', userId);

    if (sharedDeviceUsers && sharedDeviceUsers.length > 1) {
      await FraudService.emitEvent(userId, 'multiple_accounts', {
        ip: fingerprintData.ip_address, shared_users: sharedDeviceUsers.length,
      });
    }

    return { banned: false };
  }
}
