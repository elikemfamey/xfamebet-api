begin;

create table if not exists public.flutterwave_deposit_intents (
  reference uuid primary key,
  user_id uuid not null references public.users(id),
  amount numeric(14, 2) not null check (amount > 0),
  transaction_id text unique,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.flutterwave_deposit_intents enable row level security;
revoke all on public.flutterwave_deposit_intents from public, anon, authenticated;
grant select, insert on public.flutterwave_deposit_intents to service_role;

create or replace function public.finalize_flutterwave_ngn_deposit(
  p_reference uuid, p_transaction_id text, p_amount numeric
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  payment public.flutterwave_deposit_intents%rowtype;
  wallet public.wallets%rowtype;
  rate numeric;
  payment_metadata jsonb;
begin
  select * into payment from public.flutterwave_deposit_intents
    where reference = p_reference for update;
  if not found or p_amount is distinct from payment.amount then
    raise exception 'Flutterwave deposit amount or reference does not match';
  end if;
  if p_transaction_id is null or p_transaction_id !~ '^[1-9][0-9]{0,17}$' then
    raise exception 'Invalid Flutterwave transaction ID';
  end if;
  if payment.completed_at is not null then
    if payment.transaction_id is distinct from p_transaction_id then
      raise exception 'Flutterwave reference already completed with another transaction';
    end if;
    return jsonb_build_object('credited', false);
  end if;

  select * into wallet from public.wallets where user_id = payment.user_id for update;
  if not found or wallet.frozen or not exists (
    select 1 from public.users where id = payment.user_id and country = 'NG' and account_status = 'active'
  ) then
    raise exception 'Wallet is unavailable for this deposit';
  end if;
  if wallet.currency is distinct from 'NGN' and (
    coalesce(wallet.currency_locked, false) or coalesce(wallet.balance, 0) <> 0
    or coalesce(wallet.bonus_balance, 0) <> 0 or coalesce(wallet.cashback_balance, 0) <> 0
  ) then
    raise exception 'An NGN wallet is required for this deposit';
  end if;

  select usd_rate into rate from public.currency_exchange_rates where currency = 'NGN';
  payment_metadata := jsonb_strip_nulls(jsonb_build_object(
    'flutterwave_transaction_id', p_transaction_id,
    'wallet_currency', 'NGN',
    'usd_rate', rate,
    'usd_equivalent', round(payment.amount * rate, 2)
  ));
  update public.flutterwave_deposit_intents set transaction_id = p_transaction_id, completed_at = now()
    where reference = p_reference;
  insert into public.deposit_requests (user_id, amount, currency, payment_provider, reference, status, reviewed_at, metadata)
    values (payment.user_id, payment.amount, 'NGN', 'flutterwave', p_reference::text, 'completed', now(), payment_metadata);
  insert into public.transactions (user_id, wallet_id, type, amount, currency, status, payment_provider, reference, description, metadata)
    values (payment.user_id, wallet.id, 'deposit', payment.amount, 'NGN', 'completed', 'flutterwave',
      p_reference::text, 'Flutterwave NGN deposit', payment_metadata);
  update public.wallets set balance = balance + payment.amount, currency = 'NGN', currency_locked = true, updated_at = now()
    where id = wallet.id;

  return jsonb_build_object('credited', true, 'balance', wallet.balance + payment.amount);
end;
$$;

revoke execute on function public.finalize_flutterwave_ngn_deposit(uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.finalize_flutterwave_ngn_deposit(uuid, text, numeric) to service_role;

commit;
