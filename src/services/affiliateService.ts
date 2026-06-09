import { supabase } from '../config/supabase';

// Approximate mid-market rates — kept in sync with admin/payments page
const TO_USD: Record<string, number> = {
  GHS: 1 / 11,
  NGN: 1 / 1550,
  KES: 1 / 130,
  ZAR: 1 / 18.5,
  USDT: 1,
  USD: 1,
};

function toUsd(amount: number, currency: string): number {
  return parseFloat((amount * (TO_USD[currency] ?? 1)).toFixed(2));
}

export class AffiliateService {
  // Bets are placed from the GHS wallet, so stake/payout are always GHS
  static async creditBetCommission(
    userId: string,
    stake: number,
    payout: number,
  ): Promise<void> {
    const netRevenue = Math.max(0, stake - payout);
    if (netRevenue <= 0) return;

    const stakeUsd = toUsd(stake, 'GHS');
    const netRevenueUsd = toUsd(netRevenue, 'GHS');

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
      commission = parseFloat((netRevenueUsd * aff.commission_rate).toFixed(2));
    }
    if (commission <= 0) return;

    await supabase
      .from('affiliate_referrals')
      .update({
        betting_volume: referral.betting_volume + stakeUsd,
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

    await supabase.from('affiliate_commission_logs').insert({
      affiliate_id: referral.affiliate_id,
      referred_user_id: userId,
      event_type: 'bet_rev_share',
      commission_amount: commission,
      source_amount: stake,
      source_currency: 'GHS',
    });
  }

  static async creditCpaCommission(userId: string, depositAmount: number, depositCurrency = 'GHS'): Promise<void> {
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

    // Convert deposit to USD — all affiliate monetary values are stored in USD
    const depositUsd = toUsd(depositAmount, depositCurrency);
    const newDepositTotal = referral.deposit_total + depositUsd;
    const isFirstDeposit = referral.deposit_total === 0 && depositUsd >= 60;

    let commission = 0;
    let eventType = '';

    if (aff.commission_type === 'revenue_share') {
      commission = parseFloat((depositUsd * aff.commission_rate).toFixed(2));
      eventType = 'deposit_rev_share';
    } else if (aff.commission_type === 'cpa') {
      if (isFirstDeposit) {
        commission = aff.cpa_amount ?? 0;
        eventType = 'deposit_cpa';
      }
    } else if (aff.commission_type === 'hybrid') {
      if (isFirstDeposit) {
        commission = parseFloat(((aff.cpa_amount ?? 0) + depositUsd * aff.commission_rate).toFixed(2));
        eventType = 'deposit_hybrid';
      } else {
        commission = parseFloat((depositUsd * aff.commission_rate).toFixed(2));
        eventType = 'deposit_rev_share';
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

      await supabase.from('affiliate_commission_logs').insert({
        affiliate_id: referral.affiliate_id,
        referred_user_id: userId,
        event_type: eventType,
        commission_amount: commission,
        source_amount: depositAmount,       // original native amount for display
        source_currency: depositCurrency,   // original currency for display
      });
    }
  }
}
