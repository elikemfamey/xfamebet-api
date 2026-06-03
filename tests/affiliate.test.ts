describe('Affiliate Commission Logic', () => {
  const calcRevShare = (betsTotal: number, winnings: number, bonuses: number, commissionRate: number) => {
    const netRevenue = betsTotal - winnings - bonuses;
    return netRevenue * commissionRate;
  };

  const calcCpa = (cpaAmount: number, qualifiedReferrals: number) => cpaAmount * qualifiedReferrals;

  const calcHybrid = (cpaAmount: number, referrals: number, betsTotal: number, winnings: number, bonuses: number, revShareRate: number) => {
    const cpa = calcCpa(cpaAmount, referrals);
    const revShare = calcRevShare(betsTotal, winnings, bonuses, revShareRate);
    return cpa + revShare;
  };

  it('calculates revenue share correctly', () => {
    const commission = calcRevShare(10000, 7000, 500, 0.15);
    expect(commission).toBe(375); // (10000 - 7000 - 500) * 0.15 = 375
  });

  it('calculates CPA correctly', () => {
    const commission = calcCpa(50, 10);
    expect(commission).toBe(500);
  });

  it('calculates hybrid model', () => {
    const commission = calcHybrid(20, 5, 5000, 3000, 200, 0.10);
    expect(commission).toBe(100 + 180); // CPA: 100, RevShare: (5000-3000-200)*0.10 = 180
  });

  it('negative net revenue gives zero or negative commission', () => {
    const commission = calcRevShare(1000, 1200, 0, 0.15);
    expect(commission).toBeLessThan(0);
  });
});
