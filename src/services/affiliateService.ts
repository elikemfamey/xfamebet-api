import { supabase } from '../config/supabase';

export class AffiliateService {
  static async creditBetCommission(
    userId: string,
    stake: number,
    payout: number,
  ): Promise<void> {
    const netRevenue = Math.max(0, stake - payout);
    if (netRevenue <= 0) return;

    const { data: referral } = await supabase
      .from('affiliate_referrals')
      .select('id, affiliate_id, betting_volume, commission_earned, affiliates(commission_type, commission_rate, approval_status, total_earnings, withdrawal_balance)')
      .eq('referred_user_id', userId)
      .single();

    if (!referral) return;

    const aff = referral.affiliates as unknown as {
      commission_type: string;
      commission_rate: number;
      approval_status: string;
      total_earnings: number;
      withdrawal_balance: number;
    };

    if (aff.approval_status !== 'approved') return;

    let commission = 0;
    if (aff.commission_type === 'revenue_share' || aff.commission_type === 'hybrid') {
      commission = netRevenue * aff.commission_rate;
    }
    if (commission <= 0) return;

    await supabase
      .from('affiliate_referrals')
      .update({
        betting_volume: referral.betting_volume + stake,
        commission_earned: referral.commission_earned + commission,
      })
      .eq('id', referral.id);

    await supabase
      .from('affiliates')
      .update({
        total_earnings: aff.total_earnings + commission,
        withdrawal_balance: aff.withdrawal_balance + commission,
      })
      .eq('id', referral.affiliate_id);
  }

  static async creditCpaCommission(userId: string, depositAmount: number): Promise<void> {
    const { data: referral } = await supabase
      .from('affiliate_referrals')
      .select('id, affiliate_id, deposit_total, commission_earned, affiliates(commission_type, cpa_amount, approval_status, total_earnings, withdrawal_balance)')
      .eq('referred_user_id', userId)
      .single();

    if (!referral) return;

    const aff = referral.affiliates as unknown as {
      commission_type: string;
      cpa_amount: number;
      approval_status: string;
      total_earnings: number;
      withdrawal_balance: number;
    };

    if (aff.approval_status !== 'approved') return;

    const newDepositTotal = referral.deposit_total + depositAmount;

    // Revenue share affiliates: track deposit volume but no CPA commission
    if (aff.commission_type !== 'cpa' && aff.commission_type !== 'hybrid') {
      await supabase
        .from('affiliate_referrals')
        .update({ deposit_total: newDepositTotal })
        .eq('id', referral.id);
      return;
    }

    // CPA/hybrid: only pay commission on the first qualifying deposit
    const isFirstDeposit = referral.deposit_total === 0 && depositAmount >= 10;
    if (!isFirstDeposit) {
      await supabase
        .from('affiliate_referrals')
        .update({ deposit_total: newDepositTotal })
        .eq('id', referral.id);
      return;
    }

    const commission = aff.cpa_amount ?? 0;

    await supabase
      .from('affiliate_referrals')
      .update({
        deposit_total: newDepositTotal,
        commission_earned: referral.commission_earned + commission,
      })
      .eq('id', referral.id);

    if (commission > 0) {
      await supabase
        .from('affiliates')
        .update({
          total_earnings: aff.total_earnings + commission,
          withdrawal_balance: aff.withdrawal_balance + commission,
        })
        .eq('id', referral.affiliate_id);
    }
  }
}
