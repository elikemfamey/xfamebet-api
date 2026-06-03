export type UserRole = 'user' | 'admin' | 'super_admin' | 'affiliate' | 'fraud_analyst';
export type KycStatus = 'pending' | 'submitted' | 'approved' | 'rejected';
export type AccountStatus = 'active' | 'suspended' | 'frozen' | 'banned';
export type BetStatus = 'pending' | 'won' | 'lost' | 'void' | 'cashed_out';
export type BetType = 'single' | 'multi' | 'accumulator' | 'system' | 'bet_builder';
export type TransactionType = 'deposit' | 'withdrawal' | 'bet_stake' | 'bet_win' | 'bonus' | 'cashback' | 'affiliate_commission' | 'transfer' | 'refund' | 'adjustment';
export type TransactionStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'rejected' | 'approved';
export type PaymentProvider = 'paystack' | 'momo_mtn' | 'momo_telecel' | 'momo_airteltigo' | 'ng_bank_transfer' | 'usdt_trc20' | 'manual';
export type CommissionType = 'cpa' | 'revenue_share' | 'hybrid';
export type AffiliateStatus = 'pending' | 'approved' | 'rejected' | 'blocked';
export type SimulationStatus = 'scheduled' | 'live' | 'completed' | 'cancelled';
export type FraudCaseStatus = 'open' | 'investigating' | 'resolved' | 'dismissed';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type OddsStatus = 'active' | 'suspended' | 'settled' | 'void';
export type DepositStatus = 'pending' | 'approved' | 'rejected' | 'processing' | 'completed';
export type WithdrawalStatus = 'pending' | 'approved' | 'rejected' | 'processing' | 'completed';
export type NotificationType = 'bet_won' | 'bet_lost' | 'deposit_approved' | 'withdrawal_approved' | 'withdrawal_rejected' | 'kyc_approved' | 'kyc_rejected' | 'fraud_alert' | 'promotion' | 'system';

export interface User {
  id: string;
  username: string;
  phone: string;
  email?: string;
  password_hash?: string;
  country: string;
  referral_code: string;
  affiliate_id?: string;
  kyc_status: KycStatus;
  account_status: AccountStatus;
  role: UserRole;
  date_of_birth?: string;
  two_fa_enabled: boolean;
  two_fa_secret?: string;
  created_at: string;
  updated_at: string;
}

export interface Wallet {
  id: string;
  user_id: string;
  balance: number;
  bonus_balance: number;
  cashback_balance: number;
  currency: string;
  frozen: boolean;
  updated_at: string;
}

export interface Transaction {
  id: string;
  user_id: string;
  wallet_id: string;
  type: TransactionType;
  amount: number;
  currency: string;
  status: TransactionStatus;
  payment_provider?: PaymentProvider;
  reference?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface Bet {
  id: string;
  user_id: string;
  event_id?: string;
  odds: number;
  stake: number;
  payout: number;
  status: BetStatus;
  bet_type: BetType;
  placed_at: string;
  settled_at?: string;
}

export interface BetSelection {
  id: string;
  bet_id: string;
  event_id: string;
  market_type: string;
  selection: string;
  odds: number;
  status: BetStatus;
}

export interface OddsFeed {
  id: string;
  event_id: string;
  market_type: string;
  selection: string;
  odds_value: number;
  source: string;
  status: OddsStatus;
  updated_at: string;
}

export interface SimulatedMatch {
  id: string;
  team_a: string;
  team_b: string;
  team_a_score: number;
  team_b_score: number;
  simulation_seed?: string;
  result?: string;
  status: SimulationStatus;
  sport: string;
  duration_minutes: number;
  current_minute: number;
  metadata?: Record<string, unknown>;
  started_at?: string;
  ended_at?: string;
  created_at: string;
}

export interface MatchEvent {
  id: string;
  simulation_id: string;
  minute: number;
  event_type: string;
  player?: string;
  team?: string;
  commentary: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface FraudEvent {
  id: string;
  user_id: string;
  event_type: string;
  risk_score: number;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface DeviceFingerprint {
  id: string;
  user_id: string;
  device_hash: string;
  browser: string;
  os: string;
  screen_resolution?: string;
  timezone?: string;
  language?: string;
  webgl_data?: string;
  ip_address: string;
  vpn_detected: boolean;
  proxy_detected: boolean;
  emulator_detected: boolean;
  created_at: string;
}

export interface RiskScore {
  id: string;
  user_id: string;
  score: number;
  level: RiskLevel;
  category: string;
  factors: Record<string, unknown>;
  updated_at: string;
}

export interface Affiliate {
  id: string;
  user_id: string;
  commission_type: CommissionType;
  commission_rate: number;
  cpa_amount?: number;
  total_earnings: number;
  withdrawal_balance: number;
  approval_status: AffiliateStatus;
  created_at: string;
}

export interface AffiliateReferral {
  id: string;
  affiliate_id: string;
  referred_user_id: string;
  deposit_total: number;
  betting_volume: number;
  commission_earned: number;
  created_at: string;
}

export interface PromoCode {
  id: string;
  code: string;
  promotion_type: string;
  affiliate_id?: string;
  value: number;
  value_type: 'fixed' | 'percentage';
  usage_limit?: number;
  used_count: number;
  starts_at?: string;
  expires_at?: string;
  status: 'active' | 'inactive' | 'expired';
}

export interface Notification {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  message: string;
  read_at?: string;
  created_at: string;
}

export interface AdminLog {
  id: string;
  admin_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface DepositRequest {
  id: string;
  user_id: string;
  amount: number;
  currency: string;
  payment_provider: PaymentProvider;
  reference?: string;
  transaction_id?: string;
  screenshot_url?: string;
  tx_hash?: string;
  status: DepositStatus;
  reviewed_by?: string;
  reviewed_at?: string;
  notes?: string;
  created_at: string;
}

export interface WithdrawalRequest {
  id: string;
  user_id: string;
  amount: number;
  currency: string;
  payment_provider: PaymentProvider;
  account_details: Record<string, unknown>;
  status: WithdrawalStatus;
  reviewed_by?: string;
  reviewed_at?: string;
  notes?: string;
  created_at: string;
}

export interface KycDocument {
  id: string;
  user_id: string;
  document_type: string;
  document_url: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewed_by?: string;
  reviewed_at?: string;
  created_at: string;
}

export interface ResponsibleGamblingLimit {
  id: string;
  user_id: string;
  limit_type: 'deposit' | 'loss' | 'bet' | 'session';
  period: 'daily' | 'weekly' | 'monthly';
  amount_limit?: number;
  current_amount: number;
  self_excluded: boolean;
  exclusion_until?: string;
  created_at: string;
  updated_at: string;
}

export interface BonusPromotion {
  id: string;
  name: string;
  type: string;
  value: number;
  value_type: 'fixed' | 'percentage';
  min_deposit?: number;
  wagering_requirement?: number;
  max_win?: number;
  starts_at?: string;
  expires_at?: string;
  status: 'active' | 'inactive';
  created_at: string;
}

export interface UserBonusGrant {
  id: string;
  user_id: string;
  promotion_id: string;
  amount: number;
  wagering_progress: number;
  wagering_required: number;
  status: 'pending' | 'active' | 'completed' | 'expired' | 'reversed';
  expires_at?: string;
  created_at: string;
}

export interface Session {
  id: string;
  user_id: string;
  token_hash: string;
  device_fingerprint_id?: string;
  ip_address: string;
  expires_at: string;
  revoked_at?: string;
  created_at: string;
}

export interface OddsSnapshot {
  id: string;
  bet_id: string;
  event_id: string;
  market_type: string;
  selection: string;
  odds_value: number;
  source: string;
  captured_at: string;
}

export interface JwtPayload {
  userId: string;
  role: UserRole;
  sessionId: string;
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
