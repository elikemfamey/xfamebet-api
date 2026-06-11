/**
 * One-time script: correct affiliate data inflated by wrong NGN exchange rate.
 *
 * Bug:  NGN rate was 1/10   (10 NGN  = $1)
 * Fix:  NGN rate is  1/1000 (1000 NGN = $1)
 *
 * What this fixes:
 *   1. affiliate_referrals.deposit_total  — recalculated from raw deposits (ground truth)
 *   2. affiliate_referrals.commission_earned — recalculated from deposits + current commission rules
 *      (only reduced, never increased — avoids crediting commissions that were never paid)
 *   3. affiliates.total_earnings / withdrawal_balance — adjusted by the commission delta
 *      (withdrawal_balance floored at 0 if overpaid)
 *
 * Run dry-run first:   yarn ts-node src/db/fix-ngn-commissions.ts
 * Apply for real:      yarn ts-node src/db/fix-ngn-commissions.ts --apply
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const DRY_RUN = !process.argv.includes('--apply');

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!,
  { auth: { persistSession: false } },
);

const round2 = (n: number) => Math.round(n * 100) / 100;

// ─────────────────────────────────────────────────────────────────────────────

async function tableExists(name: string): Promise<boolean> {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${name}?select=id&limit=1`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY!,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY!}`,
    },
  });
  return res.ok || res.status === 406;
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulate what commission SHOULD be from deposit history at the CORRECT rate
// ─────────────────────────────────────────────────────────────────────────────

function simulateCommission(
  deposits: Array<{ amount: number }>,
  commissionType: string,
  commissionRate: number,
  cpaAmount: number,
): number {
  let cumDepositUsd = 0;
  let totalCommission = 0;

  for (const dep of deposits) {
    const depUsd = dep.amount / 1000; // correct NGN rate
    const isFirst = cumDepositUsd === 0 && depUsd >= 60;

    let comm = 0;
    if (commissionType === 'revenue_share') {
      comm = round2(depUsd * commissionRate);
    } else if (commissionType === 'cpa') {
      if (isFirst) comm = cpaAmount;
    } else if (commissionType === 'hybrid') {
      if (isFirst) {
        comm = round2(cpaAmount + depUsd * commissionRate);
      } else {
        comm = round2(depUsd * commissionRate);
      }
    }

    cumDepositUsd = round2(cumDepositUsd + depUsd);
    totalCommission = round2(totalCommission + comm);
  }

  return totalCommission;
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH A: commission_logs table exists — correct individual log rows first
// ─────────────────────────────────────────────────────────────────────────────

async function fixViaLogs(
  affById: Map<string, Record<string, unknown>>,
  affSnapshot: Map<string, { old_total: number; old_balance: number }>,
) {
  console.log('Strategy: log-based correction\n');

  const { data: ngnLogs } = await supabase
    .from('affiliate_commission_logs')
    .select('*')
    .eq('source_currency', 'NGN');

  if (!ngnLogs || ngnLogs.length === 0) {
    console.log('No NGN commission logs found — nothing to correct.');
    return;
  }
  console.log(`Found ${ngnLogs.length} NGN commission log(s).\n`);

  type Fix = { id: string; old_amount: number; new_amount: number; new_event_type: string };
  const fixes: Fix[] = [];

  for (const log of ngnLogs) {
    const aff = affById.get(log.affiliate_id as string);
    const oldAmt = log.commission_amount as number;
    const srcAmt = log.source_amount as number;
    let newAmt = oldAmt;
    let newType = log.event_type as string;

    if (log.event_type === 'deposit_rev_share') {
      newAmt = round2(oldAmt / 100);
    } else if (log.event_type === 'deposit_cpa') {
      if (srcAmt < 60_000) newAmt = 0; // was wrongly triggered (< $60 at correct rate)
    } else if (log.event_type === 'deposit_hybrid') {
      const rate = (aff?.commission_rate as number) ?? 0;
      const cpa = (aff?.cpa_amount as number) ?? 0;
      if (srcAmt >= 60_000) {
        newAmt = round2(cpa + (srcAmt / 1000) * rate);
      } else {
        newAmt = round2((srcAmt / 1000) * rate);
        newType = 'deposit_rev_share';
      }
    } else {
      continue; // bet_rev_share — always GHS, unaffected
    }

    if (oldAmt !== newAmt || log.event_type !== newType) {
      fixes.push({ id: log.id as string, old_amount: oldAmt, new_amount: newAmt, new_event_type: newType });
    }
  }

  let totalReduced = 0;
  console.log(`Commission log changes (${fixes.length}):`);
  for (const f of fixes) {
    const delta = f.old_amount - f.new_amount;
    totalReduced += delta;
    console.log(`  ${f.id}: $${f.old_amount.toFixed(2)} → $${f.new_amount.toFixed(2)} (−$${delta.toFixed(2)})`);
  }
  console.log(`  Total reduction: $${totalReduced.toFixed(2)}\n`);

  if (!DRY_RUN) {
    for (const f of fixes) {
      const { error } = await supabase
        .from('affiliate_commission_logs')
        .update({ commission_amount: f.new_amount, event_type: f.new_event_type })
        .eq('id', f.id);
      if (error) console.error(`  ✗ Log ${f.id}:`, error.message);
    }
    console.log('Logs updated.\n');
  }

  // Recompute rollups from the (now-corrected) logs
  const userIds = [...new Set(ngnLogs.map(l => l.referred_user_id as string))];
  const affIds = [...new Set(ngnLogs.map(l => l.affiliate_id as string))];

  const RATE_MAP: Record<string, number> = {
    NGN: 1 / 1000, GHS: 1 / 10, KES: 1 / 130, ZAR: 1 / 18.5, USDT: 1, USD: 1,
  };

  console.log(`\nReferral rollups (${userIds.length}):`);
  for (const userId of userIds) {
    const { data: logs } = await supabase
      .from('affiliate_commission_logs')
      .select('event_type, commission_amount, source_amount, source_currency')
      .eq('referred_user_id', userId);

    const all = logs ?? [];
    const depLogs = all.filter(l =>
      ['deposit_rev_share', 'deposit_cpa', 'deposit_hybrid'].includes(l.event_type as string));
    const newDepTotal = round2(
      depLogs.reduce((s, l) => s + (l.source_amount as number) * (RATE_MAP[l.source_currency as string] ?? 1), 0));
    const newCommEarned = round2(all.reduce((s, l) => s + (l.commission_amount as number), 0));
    console.log(`  User ${userId}: deposit_total → $${newDepTotal.toFixed(2)}, commission_earned → $${newCommEarned.toFixed(2)}`);

    if (!DRY_RUN) {
      await supabase.from('affiliate_referrals')
        .update({ deposit_total: newDepTotal, commission_earned: newCommEarned })
        .eq('referred_user_id', userId);
    }
  }

  console.log(`\nAffiliate totals (${affIds.length}):`);
  for (const affId of affIds) {
    const { data: logs } = await supabase
      .from('affiliate_commission_logs')
      .select('commission_amount')
      .eq('affiliate_id', affId);
    const newTotal = round2((logs ?? []).reduce((s, l) => s + (l.commission_amount as number), 0));
    const snap = affSnapshot.get(affId)!;
    const alreadyDeducted = round2(snap.old_total - snap.old_balance);
    const newBalance = round2(Math.max(0, newTotal - alreadyDeducted));
    const overpaid = alreadyDeducted > newTotal;
    console.log(
      `  ${affId}: earnings $${snap.old_total.toFixed(2)} → $${newTotal.toFixed(2)},` +
      ` balance $${snap.old_balance.toFixed(2)} → $${newBalance.toFixed(2)}` +
      (overpaid ? `  ⚠ OVERPAID $${(alreadyDeducted - newTotal).toFixed(2)}` : ''),
    );
    if (!DRY_RUN) {
      await supabase.from('affiliates')
        .update({ total_earnings: newTotal, withdrawal_balance: newBalance })
        .eq('id', affId);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH B: no commission_logs — reconstruct from deposit_requests
// ─────────────────────────────────────────────────────────────────────────────

async function fixViaDeposits(
  affById: Map<string, Record<string, unknown>>,
  affSnapshot: Map<string, { old_total: number; old_balance: number }>,
) {
  console.log('Strategy: deposit-based reconstruction (commission_logs not found)\n');

  // Fetch all approved NGN deposits, oldest first (order matters for CPA first-deposit logic)
  const { data: ngnDeposits, error: depErr } = await supabase
    .from('deposit_requests')
    .select('id, user_id, amount, currency, created_at')
    .eq('currency', 'NGN')
    .eq('status', 'approved')
    .order('created_at', { ascending: true });

  if (depErr) { console.error('Cannot fetch deposits:', depErr.message); process.exit(1); }
  if (!ngnDeposits || ngnDeposits.length === 0) {
    console.log('No approved NGN deposits found — nothing to fix.'); return;
  }
  console.log(`Found ${ngnDeposits.length} approved NGN deposit(s).\n`);

  // Fetch all affiliate_referrals
  const { data: referrals } = await supabase
    .from('affiliate_referrals')
    .select('id, affiliate_id, referred_user_id, deposit_total, commission_earned');
  if (!referrals) { console.error('Cannot fetch referrals'); process.exit(1); }

  const referralByUser = new Map(referrals.map(r => [r.referred_user_id as string, r]));

  // Group NGN deposits by user
  const depositsByUser = new Map<string, Array<{ amount: number; created_at: string }>>();
  for (const dep of ngnDeposits) {
    const uid = dep.user_id as string;
    if (!depositsByUser.has(uid)) depositsByUser.set(uid, []);
    depositsByUser.get(uid)!.push({ amount: dep.amount as number, created_at: dep.created_at as string });
  }

  type ReferralFix = { id: string; new_deposit_total: number; new_commission_earned: number };
  const referralFixes: ReferralFix[] = [];
  const affCommDelta = new Map<string, number>(); // affiliate_id → commission delta

  let anyChanges = false;
  console.log('Referral corrections:');

  for (const [userId, userDeposits] of depositsByUser) {
    const referral = referralByUser.get(userId);
    if (!referral) continue;

    const aff = affById.get(referral.affiliate_id as string);
    if (!aff) continue;

    const actualDepTotal = referral.deposit_total as number;
    const actualCommEarned = referral.commission_earned as number;

    // What the wrong rate (1/10) would have produced for these NGN deposits
    const wrongDepTotal = round2(userDeposits.reduce((s, d) => s + d.amount / 10, 0));
    // Ground-truth correct deposit total
    const correctDepTotal = round2(userDeposits.reduce((s, d) => s + d.amount / 1000, 0));

    // Only adjust deposit_total if the actual value is close to what the WRONG rate would produce.
    // If they don't match, these deposits were never processed through commission (or there are
    // mixed-currency deposits we can't isolate safely) — leave deposit_total alone.
    const wrongRateWasUsed = Math.abs(actualDepTotal - wrongDepTotal) < Math.max(1, wrongDepTotal * 0.02);
    const newDepTotal = wrongRateWasUsed ? correctDepTotal : actualDepTotal;

    if (!wrongRateWasUsed) {
      console.log(
        `  User ${userId}: deposit_total $${actualDepTotal.toFixed(2)} does not match` +
        ` expected wrong-rate value $${wrongDepTotal.toFixed(2)} — deposits may not have been` +
        ` processed via commission function. Skipping deposit_total.`,
      );
    }

    // Simulate correct commission from deposits in chronological order
    const correctComm = wrongRateWasUsed
      ? simulateCommission(userDeposits, aff.commission_type as string, aff.commission_rate as number, (aff.cpa_amount as number) ?? 0)
      : actualCommEarned; // no change if deposit wasn't processed at wrong rate

    // Safety: never INCREASE commission (we might be missing non-deposit sources like bet commissions)
    const safeNewComm = Math.min(actualCommEarned, correctComm);

    const depChanged = Math.abs(actualDepTotal - newDepTotal) > 0.001;
    const commChanged = Math.abs(actualCommEarned - safeNewComm) > 0.001;

    if (!depChanged && !commChanged) continue;

    anyChanges = true;
    const commDelta = round2(safeNewComm - actualCommEarned);

    console.log(
      `  User ${userId}:` +
      (depChanged ? ` deposit_total $${actualDepTotal.toFixed(2)} → $${correctDepTotal.toFixed(2)}` : '') +
      (commChanged ? `, commission_earned $${actualCommEarned.toFixed(2)} → $${safeNewComm.toFixed(2)}` : ''),
    );

    if (commChanged) {
      const affId = referral.affiliate_id as string;
      affCommDelta.set(affId, round2((affCommDelta.get(affId) ?? 0) + commDelta));
    }

    referralFixes.push({ id: referral.id as string, new_deposit_total: newDepTotal, new_commission_earned: safeNewComm });
  }

  if (!anyChanges) {
    console.log('  No corrections needed — all deposit_totals and commissions are already accurate.');
    return;
  }

  // Affiliate summary
  console.log(`\nAffiliate totals:`);
  for (const [affId, delta] of affCommDelta) {
    const snap = affSnapshot.get(affId)!;
    const newTotal = round2(snap.old_total + delta);
    const alreadyDeducted = round2(snap.old_total - snap.old_balance);
    const newBalance = round2(Math.max(0, newTotal - alreadyDeducted));
    const overpaid = alreadyDeducted > newTotal;
    console.log(
      `  ${affId}: earnings $${snap.old_total.toFixed(2)} → $${newTotal.toFixed(2)},` +
      ` balance $${snap.old_balance.toFixed(2)} → $${newBalance.toFixed(2)}` +
      (overpaid ? `  ⚠ OVERPAID $${(alreadyDeducted - newTotal).toFixed(2)}` : ''),
    );
  }

  if (DRY_RUN) return;

  // Apply referral fixes
  for (const fix of referralFixes) {
    const { error } = await supabase
      .from('affiliate_referrals')
      .update({ deposit_total: fix.new_deposit_total, commission_earned: fix.new_commission_earned })
      .eq('id', fix.id);
    if (error) console.error(`  ✗ Referral ${fix.id}:`, error.message);
  }
  console.log('\nReferral rollups updated.');

  // Apply affiliate fixes
  for (const [affId, delta] of affCommDelta) {
    const snap = affSnapshot.get(affId)!;
    const newTotal = round2(snap.old_total + delta);
    const alreadyDeducted = round2(snap.old_total - snap.old_balance);
    const newBalance = round2(Math.max(0, newTotal - alreadyDeducted));
    const { error } = await supabase
      .from('affiliates')
      .update({ total_earnings: newTotal, withdrawal_balance: newBalance })
      .eq('id', affId);
    if (error) console.error(`  ✗ Affiliate ${affId}:`, error.message);
  }
  console.log('Affiliate totals updated.');
}

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== XfameBet: Fix NGN Commissions [${DRY_RUN ? 'DRY RUN — no changes written' : 'LIVE — writing changes'}] ===\n`);
  if (DRY_RUN) console.log('Pass --apply to commit. Showing what WOULD change.\n');

  // Snapshot all affiliates
  const { data: allAffiliates, error: affErr } = await supabase
    .from('affiliates')
    .select('id, commission_type, commission_rate, cpa_amount, approval_status, total_earnings, withdrawal_balance');
  if (affErr || !allAffiliates) { console.error('Cannot fetch affiliates:', affErr?.message); process.exit(1); }

  const affById = new Map(allAffiliates.map(a => [a.id as string, a]));
  const affSnapshot = new Map(allAffiliates.map(a => [a.id as string, {
    old_total: a.total_earnings as number,
    old_balance: a.withdrawal_balance as number,
  }]));

  const logsExist = await tableExists('affiliate_commission_logs');
  console.log(`affiliate_commission_logs table: ${logsExist ? 'EXISTS' : 'NOT FOUND'}\n`);

  if (logsExist) {
    await fixViaLogs(affById, affSnapshot);
  } else {
    await fixViaDeposits(affById, affSnapshot);
  }

  console.log(
    DRY_RUN
      ? '\n=== Dry run complete. Run with --apply to commit. ==='
      : '\n=== All NGN commission corrections applied. ===',
  );
}

main().catch(err => { console.error('\nFatal:', err); process.exit(1); });
