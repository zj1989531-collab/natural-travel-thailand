-- Execute after schema.sql, refunds.sql, project-rules.sql and show79.sql.
-- This is an additive, initially empty payment journal: applying it records no payments.
-- A payment is an immutable increment. Corrections/refunds are later signed increments,
-- never edits to an already paid month. No automatic transfers are performed.
-- Keep all amounts <= 999999999999.99 THB so cents * 40 stays a safe JS integer.
create table if not exists public.show79_settlements (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' and month >= '0001-01'),
  snapshot_profit_thb numeric(16,2) not null,
  snapshot_jimmy_thb numeric(16,2) not null,
  snapshot_partners_thb numeric(16,2) not null,
  prior_jimmy_paid_thb numeric(16,2) not null,
  prior_partners_paid_thb numeric(16,2) not null,
  jimmy_paid_thb numeric(14,2) not null,
  partners_paid_thb numeric(14,2) not null,
  payment_date date not null check (isfinite(payment_date) and payment_date >= date '0001-01-01'),
  note text not null default '' check (char_length(note) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint show79_settlements_nonzero check (jimmy_paid_thb <> 0 or partners_paid_thb <> 0),
  constraint show79_settlements_signed_note check (
    (jimmy_paid_thb >= 0 and partners_paid_thb >= 0) or char_length(btrim(note,
      U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')) > 0
  ),
  constraint show79_settlements_amounts_finite check (
    snapshot_profit_thb::text not in ('NaN','Infinity','-Infinity') and abs(snapshot_profit_thb) <= 999999999999.99 and
    snapshot_jimmy_thb::text not in ('NaN','Infinity','-Infinity') and abs(snapshot_jimmy_thb) <= 999999999999.99 and
    snapshot_partners_thb::text not in ('NaN','Infinity','-Infinity') and abs(snapshot_partners_thb) <= 999999999999.99 and
    prior_jimmy_paid_thb::text not in ('NaN','Infinity','-Infinity') and abs(prior_jimmy_paid_thb) <= 999999999999.99 and
    prior_partners_paid_thb::text not in ('NaN','Infinity','-Infinity') and abs(prior_partners_paid_thb) <= 999999999999.99 and
    jimmy_paid_thb::text not in ('NaN','Infinity','-Infinity') and abs(jimmy_paid_thb) <= 999999999999.99 and
    partners_paid_thb::text not in ('NaN','Infinity','-Infinity') and abs(partners_paid_thb) <= 999999999999.99
  ),
  constraint show79_settlements_snapshot_split check (
    snapshot_jimmy_thb = sign(snapshot_profit_thb) * round(abs(snapshot_profit_thb) * 100 * 40 / 100) / 100 and
    snapshot_partners_thb = snapshot_profit_thb - snapshot_jimmy_thb
  )
);
create index if not exists show79_settlements_user_month_created_idx
  on public.show79_settlements(user_id, month, created_at);
alter table public.show79_settlements enable row level security;
revoke all privileges on public.show79_settlements from public, anon, authenticated;
grant select, insert on public.show79_settlements to authenticated;

drop policy if exists "Users read only their 79 settlements" on public.show79_settlements;
create policy "Users read only their 79 settlements" on public.show79_settlements
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users insert only their 79 settlements" on public.show79_settlements;
create policy "Users insert only their 79 settlements" on public.show79_settlements
  for insert to authenticated with check ((select auth.uid()) = user_id);

-- Both REST INSERT and RPC use this guard; snapshot fields and prior totals in an
-- INSERT are expected values, checked here before being replaced with server values.
create or replace function public.ledger_validate_show79_settlement()
returns trigger language plpgsql security invoker set search_path = public as $$
declare
  current_user_id uuid := auth.uid();
  month_start date;
  month_end date;
  profit_cents numeric;
  prior_jimmy numeric;
  prior_partners numeric;
  amount numeric;
  server_now timestamptz := clock_timestamp();
begin
  if tg_op <> 'INSERT' then
    raise exception '分账记录不可修改或删除；请新增一笔调整记录。' using errcode = '22023';
  end if;
  if current_user_id is null or new.user_id is distinct from current_user_id then
    raise exception '请登录当前账号后登记分账。' using errcode = '42501';
  end if;
  if new.id is null or new.month is null or new.month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or new.month < '0001-01' then
    raise exception '分账月份无效，请选择有效的月份。' using errcode = '22023';
  end if;
  if new.payment_date is null or not isfinite(new.payment_date) or new.payment_date < date '0001-01-01' or
    new.payment_date > (server_now at time zone 'Asia/Bangkok')::date then
    raise exception '付款日期无效，不能晚于泰国今天。' using errcode = '22023';
  end if;
  new.note := btrim(coalesce(new.note, ''),
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
  if char_length(new.note) > 300 then
    raise exception '分账备注最多300个字符。' using errcode = '22023';
  end if;
  foreach amount in array array[
    new.snapshot_profit_thb, new.snapshot_jimmy_thb, new.snapshot_partners_thb,
    new.prior_jimmy_paid_thb, new.prior_partners_paid_thb,
    new.jimmy_paid_thb, new.partners_paid_thb
  ] loop
    if amount is null or amount::text in ('NaN','Infinity','-Infinity') or
      abs(amount) > 999999999999.99 or amount <> trunc(amount, 2) then
      raise exception '分账金额必须有效、最多两位小数且不超过999999999999.99泰铢。' using errcode = '22023';
    end if;
  end loop;
  if new.jimmy_paid_thb = 0 and new.partners_paid_thb = 0 then
    raise exception '请填写本次实际支付或调整金额。' using errcode = '22023';
  end if;
  if (new.jimmy_paid_thb < 0 or new.partners_paid_thb < 0) and new.note = '' then
    raise exception '负数调整请填写原因。' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('show79-settlement:' || current_user_id::text || ':' || new.month, 0));
  select coalesce(sum(jimmy_paid_thb), 0), coalesce(sum(partners_paid_thb), 0)
    into prior_jimmy, prior_partners from public.show79_settlements
    where user_id = current_user_id and month = new.month;
  if new.prior_jimmy_paid_thb is distinct from prior_jimmy or new.prior_partners_paid_thb is distinct from prior_partners then
    raise exception '本月分账已变化，请刷新后重新核对。' using errcode = '40001';
  end if;
  if abs(prior_jimmy + new.jimmy_paid_thb) > 999999999999.99 or
    abs(prior_partners + new.partners_paid_thb) > 999999999999.99 then
    raise exception '累计分账金额过大，请检查输入。' using errcode = '22023';
  end if;

  month_start := (new.month || '-01')::date;
  month_end := (month_start + interval '1 month')::date;
  -- Aggregate each ticket's refunds once. Only active, same-owner refunds count,
  -- and refunds adjust the original ticket month, matching buildShow79Report.
  with active_refunds as (
    select ticket_id, sum(round(refund_revenue_thb * 100)) as revenue_cents,
      sum(round(returned_cost_thb * 100)) as cost_cents
    from public.ticket_refunds where user_id = current_user_id and cancelled_at is null
    group by ticket_id
  ), original_tickets as (
    select t.*, case when t.amount_basis = 'per_person' then coalesce(t.person_count, 0) else 1 end as quantity,
      coalesce(r.revenue_cents, 0) as refund_revenue_cents, coalesce(r.cost_cents, 0) as returned_cost_cents
    from public.tickets t left join active_refunds r on r.ticket_id = t.id
    where t.user_id = current_user_id and t.deleted_at is null and t.issue_date >= month_start and t.issue_date < month_end
      -- NFKC and the JS \s codepoints mirror isShow79Project, including historical names.
      and lower(translate(normalize(t.project_name, NFKC),
        U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF', ''))
        ~ '^(79(成人)?秀|(imagine)?79show($|[^a-z]))'
  )
  select coalesce(sum(case when entry_mode = 'profit_only'
    then round(coalesce(manual_profit_thb, 0) * 100) * quantity
    else round(agent_price_thb * 100) * quantity - round(cost_thb * 100) * quantity
      - refund_revenue_cents + returned_cost_cents end), 0)
    into profit_cents from original_tickets;
  if profit_cents::text in ('NaN','Infinity','-Infinity') or abs(profit_cents) > 99999999999999 then
    raise exception '本月利润金额过大，请检查出票记录。' using errcode = '22023';
  end if;
  if new.snapshot_profit_thb is distinct from profit_cents / 100 then
    raise exception '本月利润已变化，请先同步并刷新后重新核对。' using errcode = '40001';
  end if;
  new.snapshot_profit_thb := profit_cents / 100;
  new.snapshot_jimmy_thb := sign(profit_cents) * round(abs(profit_cents) * 40 / 100) / 100;
  new.snapshot_partners_thb := (profit_cents / 100) - new.snapshot_jimmy_thb;
  new.prior_jimmy_paid_thb := prior_jimmy;
  new.prior_partners_paid_thb := prior_partners;
  new.created_at := server_now;
  new.updated_at := server_now;
  return new;
end;
$$;
revoke execute on function public.ledger_validate_show79_settlement() from public, anon, authenticated;
drop trigger if exists ledger_validate_show79_settlement on public.show79_settlements;
create trigger ledger_validate_show79_settlement
  before insert or update or delete on public.show79_settlements
  for each row execute function public.ledger_validate_show79_settlement();

-- RPC retains unscaled numeric inputs until precision validation has run. Direct
-- table INSERT is also snapshot guarded, but PostgreSQL typmods round its money
-- inputs before a BEFORE trigger; clients should always use this RPC.
create or replace function public.record_show79_settlement(
  p_operation_id uuid,
  p_month text,
  p_payment_date date,
  p_jimmy_paid_thb numeric,
  p_partners_paid_thb numeric,
  p_note text,
  p_expected_profit_thb numeric,
  p_expected_jimmy_paid_thb numeric,
  p_expected_partners_paid_thb numeric
)
returns public.show79_settlements
language plpgsql security invoker set search_path = public as $$
declare
  current_user_id uuid := auth.uid();
  request_note text := btrim(coalesce(p_note, ''),
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
  existing public.show79_settlements%rowtype;
  recorded public.show79_settlements%rowtype;
  amount numeric;
begin
  if current_user_id is null then
    raise exception '请登录后登记分账。' using errcode = '42501';
  end if;
  if p_operation_id is null or p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' or p_month < '0001-01' then
    raise exception '分账月份或操作编号无效。' using errcode = '22023';
  end if;
  foreach amount in array array[p_jimmy_paid_thb, p_partners_paid_thb, p_expected_profit_thb,
    p_expected_jimmy_paid_thb, p_expected_partners_paid_thb] loop
    if amount is null or amount::text in ('NaN','Infinity','-Infinity') or
      abs(amount) > 999999999999.99 or amount <> trunc(amount, 2) then
      raise exception '分账金额必须有效、最多两位小数且不超过999999999999.99泰铢。' using errcode = '22023';
    end if;
  end loop;
  if char_length(request_note) > 300 then
    raise exception '分账备注最多300个字符。' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('show79-settlement:' || current_user_id::text || ':' || p_month, 0));

  -- Retry the same request before comparing mutable profit or paid totals. An
  -- acknowledged operation remains successful even if later orders/refunds changed.
  select * into existing from public.show79_settlements where id = p_operation_id and user_id = current_user_id;
  if found then
    if existing.month is distinct from p_month or existing.payment_date is distinct from p_payment_date or
      existing.jimmy_paid_thb is distinct from p_jimmy_paid_thb or
      existing.partners_paid_thb is distinct from p_partners_paid_thb or existing.note is distinct from request_note then
      raise exception '此操作编号已用于另一笔分账，请刷新后重试。' using errcode = '22023';
    end if;
    return existing;
  end if;

  insert into public.show79_settlements(id, user_id, month, payment_date, note,
    jimmy_paid_thb, partners_paid_thb, snapshot_profit_thb, snapshot_jimmy_thb, snapshot_partners_thb,
    prior_jimmy_paid_thb, prior_partners_paid_thb)
  values(p_operation_id, current_user_id, p_month, p_payment_date, request_note,
    p_jimmy_paid_thb, p_partners_paid_thb, p_expected_profit_thb, 0, 0,
    p_expected_jimmy_paid_thb, p_expected_partners_paid_thb)
  returning * into recorded;
  return recorded;
end;
$$;
revoke execute on function public.record_show79_settlement(uuid, text, date, numeric, numeric, text, numeric, numeric, numeric)
  from public, anon, authenticated;
grant execute on function public.record_show79_settlement(uuid, text, date, numeric, numeric, text, numeric, numeric, numeric)
  to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime' and puballtables) and
    not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'show79_settlements') then
    alter publication supabase_realtime add table public.show79_settlements;
  end if;
end;
$$;
notify pgrst, 'reload schema';

-- Verification plan (run in a transaction and finish with ROLLBACK):
-- 1. Set LOCAL ROLE authenticated and request.jwt.claim.sub to an existing test
--    owner UUID. Pick a month with no 79 tickets/payments, so expected profit=0.
-- 2. RPC with a fresh UUID and increments 1,1 / expected totals 0,0: one row,
--    snapshot 0/0/0, prior 0/0, server timestamps. Retry same UUID: same row even
--    with stale expected values. Same UUID + changed amount: exception.
-- 3. Second UUID with expected totals 0,0: stale-state exception. With 1,1 and
--    increments -1,-1 and a reason: succeeds. Double-zero, missing negative
--    reason, 1.001, NaN, Infinity, future Bangkok payment date: each rejected.
-- 4. Direct INSERT with wrong snapshot/prior values: rejected; with correct
--    expected values: server fills both split fields and timestamps. UPDATE and
--    DELETE: denied; trigger also rejects when attempted as table owner.
-- 5. Impersonate another existing test owner: cannot SELECT original rows or
--    INSERT for their owner. Reusing another owner's UUID fails primary key.
-- 6. Isolated test ticket fixtures: 79 adult/79秀/NFKC/IMAGINE 79SHOW aliases,
--    69 exclusion, per-person/total/profit-only, active/cancelled/cross-owner
--    refunds. Assert server snapshots equal JS buildShow79Report for +/- cents.
-- 7. A two-session test uses the same expected totals and distinct operation IDs:
--    session B waits on the advisory lock, then receives stale-state after A
--    commits. Roll back/remove all fixtures through the outer test transaction;
--    this journal never needs a real financial event for deployment verification.
