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
      .select('id, affiliate_id, betting_volume, commission_earned')
      .eq('referred_user_id', userId)
      .single();

    if (!referral) return;

    const { data: aff } = await supabase
      .from('affiliates')
      .select('commission_type, commission_rate, approval_status, total_earnings, withdrawal_balance')
      .eq('id', referral.affiliate_id)
      .single();

    if (!aff || aff.approval_status !== 'approved') return;

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
      .select('id, affiliate_id, deposit_total, commission_earned')
      .eq('referred_user_id', userId)
      .single();

    if (!referral) return;

    const { data: aff } = await supabase
      .from('affiliates')
      .select('commission_type, cpa_amount, commission_rate, approval_status, total_earnings, withdrawal_balance')
      .eq('id', referral.affiliate_id)
      .single();

    if (!aff || aff.approval_status !== 'approved') return;

    const newDepositTotal = referral.deposit_total + depositAmount;
    const isFirstDeposit = referral.deposit_total === 0 && depositAmount >= 60;

    let commission = 0;

    if (aff.commission_type === 'revenue_share') {
      // Earn commission_rate % of every deposit
      commission = depositAmount * aff.commission_rate;
    } else if (aff.commission_type === 'cpa') {
      // Fixed amount on first qualifying deposit only
      if (isFirstDeposit) {
        commission = aff.cpa_amount ?? 0;
      }
    } else if (aff.commission_type === 'hybrid') {
      // CPA on first deposit + revenue_share % on every deposit
      if (isFirstDeposit) {
        commission = (aff.cpa_amount ?? 0) + depositAmount * aff.commission_rate;
      } else {
        commission = depositAmount * aff.commission_rate;
      }
    }

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
