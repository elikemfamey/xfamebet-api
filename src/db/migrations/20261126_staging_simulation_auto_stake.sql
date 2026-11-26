-- Apply to the isolated staging database used for simulation settlement tests.
begin;

create or replace function public.place_staging_simulation_stake(p_match_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_match simulated_matches%rowtype;
  v_wallet wallets%rowtype;
  v_event_id text := 'sim:' || p_match_id::text;
  v_home integer;
  v_away integer;
  v_selection text;
  v_odds numeric;
  v_stake numeric;
  v_bet_id uuid;
  v_code text;
  v_balance numeric;
begin
  select * into v_match from simulated_matches where id = p_match_id for update;
  if not found or v_match.status <> 'scheduled' or v_match.started_at is not null
      or v_match.is_scripted is distinct from true or v_match.is_admin_created is distinct from true then
    raise exception 'A scheduled scripted match is required';
  end if;

  if not exists (select 1 from users where id = p_user_id
      and lower(email) = 'admin@xfamebet.com' and role = 'super_admin') then
    raise exception 'Designated staging super-admin not found';
  end if;

  select * into v_wallet from wallets where user_id = p_user_id for update;
  if not found or v_wallet.currency is distinct from 'GHS'
      or v_wallet.withdrawal_frozen is distinct from true or v_wallet.frozen is true then
    raise exception 'An active GHS wallet with withdrawals frozen is required';
  end if;

  if exists (select 1 from transactions where user_id = p_user_id and type = 'bet_stake'
      and metadata->>'staging_simulation_id' = p_match_id::text) then
    return jsonb_build_object('status', 'already_staked');
  end if;

  select count(*) filter (where event->>'team' = 'home'),
         count(*) filter (where event->>'team' = 'away')
    into v_home, v_away
    from jsonb_array_elements(coalesce(v_match.script_events::jsonb, '[]'::jsonb)) as events(event)
    where event->>'type' = 'goal'
      and (event->>'minute')::integer between 1 and v_match.duration_minutes;
  v_selection := coalesce(v_match.declared_result::text,
    case when v_home > v_away then 'home' when v_away > v_home then 'away' else 'draw' end);

  select odds_value into v_odds from odds_feed
    where event_id = v_event_id and market_type = 'match_winner' and selection = v_selection
      and status = 'active' and source = 'simulation';
  if v_odds is null or v_odds <= 1 then
    raise exception 'Active match winner odds are required';
  end if;

  v_stake := 500 + floor(random() * 1501);
  if v_wallet.balance < v_stake then
    raise exception 'Insufficient staging wallet balance for the sampled stake';
  end if;

  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into bets (user_id, event_id, odds, stake, potential_payout, payout, status, bet_type, use_bonus, share_code)
    values (p_user_id, v_event_id, v_odds, v_stake, round(v_stake * v_odds, 2), 0, 'pending', 'single', false, v_code)
    returning id into v_bet_id;
  insert into bet_selections (bet_id, event_id, event_name, market_type, selection, odds)
    values (v_bet_id, v_event_id, v_match.team_a || ' vs ' || v_match.team_b, 'match_winner', v_selection, v_odds);
  insert into odds_snapshots (bet_id, event_id, market_type, selection, odds_value, source, captured_at)
    values (v_bet_id, v_event_id, 'match_winner', v_selection, v_odds, 'internal', now());
  update wallets set balance = balance - v_stake, updated_at = now()
    where id = v_wallet.id returning balance into v_balance;
  insert into transactions (user_id, wallet_id, type, amount, currency, status, description, metadata)
    values (p_user_id, v_wallet.id, 'bet_stake', -v_stake, 'GHS', 'completed', 'Staging simulation test stake',
      jsonb_build_object('staging_simulation_id', p_match_id, 'bet_id', v_bet_id));

  return jsonb_build_object('status', 'placed', 'stake', v_stake, 'selection', v_selection, 'balance', v_balance);
end;
$$;

revoke all on function public.place_staging_simulation_stake(uuid, uuid) from public, anon, authenticated;
grant execute on function public.place_staging_simulation_stake(uuid, uuid) to service_role;

commit;
