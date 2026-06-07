import { supabase } from '../config/supabase';

export class AffiliateService {
  /**
   * Call after a bet is settled. Calculates and credits revenue-share commission
   * to the referring affiliate (if any) based on net house revenue from the bet.
   */
  static async creditBetCommission(
    userId: string,
    stake: number,
    payout: number,
  ): Promise<void> {
    const netRevenue = Math.max(0, stake - payout);
    if (netRevenue <= 0) return;

    const { data: user } = await supabase
      .from('users')
      .select('affiliate_id')
      .eq('id', userId)
      .single();
    if (!user?.affiliate_id) return;

    const { data: referral } = await supabase
      .from('affiliate_referrals')
      .select('id, betting_volume, commission_earned, affiliate_id, affiliates(commission_type, commission_rate, approval_status, total_earnings, withdrawal_balance)')
      .eq('affiliate_id', user.affiliate_id)
      .eq('referred_user_id', userId)
      .single();

    if (!referral) return;

    const aff = referral.affiliates as {
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
      .eq('id', user.affiliate_id);
  }

  /**
   * Call when a referred user makes their first qualifying deposit.
   * Credits CPA commission to the referring affiliate.
   */
  static async creditCpaCommission(userId: string, depositAmount: number): Promise<void> {
    const { data: user } = await supabase
      .from('users')
      .select('affiliate_id')
      .eq('id', userId)
      .single();
    if (!user?.affiliate_id) return;

    const { data: referral } = await supabase
      .from('affiliate_referrals')
      .select('id, deposit_total, commission_earned, affiliates(commission_type, cpa_amount, approval_status, total_earnings, withdrawal_balance)')
      .eq('affiliate_id', user.affiliate_id)
      .eq('referred_user_id', userId)
      .single();

    if (!referral) return;

    const aff = referral.affiliates as {
      commission_type: string;
      cpa_amount: number;
      approval_status: string;
      total_earnings: number;
      withdrawal_balance: number;
    };

    if (aff.approval_status !== 'approved') return;
    if (aff.commission_type !== 'cpa' && aff.commission_type !== 'hybrid') return;

    // Only pay CPA on the first qualifying deposit (deposit_total was 0 before)
    const isFirstDeposit = referral.deposit_total === 0 && depositAmount >= 10;
    if (!isFirstDeposit) {
      // Still update deposit_total even if not first deposit
      await supabase
        .from('affiliate_referrals')
        .update({ deposit_total: referral.deposit_total + depositAmount })
        .eq('id', referral.id);
      return;
    }

    const commission = aff.cpa_amount ?? 0;

    await supabase
      .from('affiliate_referrals')
      .update({
        deposit_total: referral.deposit_total + depositAmount,
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
        .eq('id', user.affiliate_id);
    }
  }
}
