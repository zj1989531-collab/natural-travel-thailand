-- Fresh-install baseline captured from the production schema at migration
-- 20261023123233. This file is deliberately a complete, idempotent schema
-- snapshot: a new local/staging database can replay it without the former
-- hand-run root SQL files. Production already records this version and must
-- never run this baseline again.
--
-- One-time historical data correction for the supplier brand is intentionally
-- excluded: an empty database has no business row to correct. Its final
-- normalization trigger is included below.

create table if not exists public.suppliers (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  normalized_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, normalized_name)
);

create table if not exists public.tickets (
  guest_name text not null default '',
  quantity_unit text not null default 'person' check(quantity_unit in ('person','item')),
  id uuid primary key,
  entry_mode text not null default 'standard',
  manual_profit_thb numeric(14, 2),
  issue_time time without time zone,
  person_count integer constraint tickets_person_count_valid check (person_count >= 1),
  amount_basis text not null default 'total',
  user_id uuid not null references auth.users(id) on delete cascade,
  issue_date date not null,
  supplier_id uuid not null references public.suppliers(id),
  supplier_name text not null,
  project_id uuid,
  project_name text not null,
  sub_item_name text not null,
  agent_price_thb numeric(14, 2) not null check (agent_price_thb >= 0),
  cost_thb numeric(14, 2) not null check (cost_thb >= 0),
  note text not null default '',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  settlement_mode text,
  constraint tickets_amount_basis_valid check (
    amount_basis in ('total','per_person') and
    (amount_basis <> 'per_person' or (person_count is not null and person_count >= 1))
  ),
  constraint tickets_entry_mode_valid check (
    (entry_mode='standard' and manual_profit_thb is null) or
    (entry_mode='profit_only' and manual_profit_thb is not null and manual_profit_thb >= 0 and agent_price_thb=0 and cost_thb=0)
  ),
  constraint tickets_quantity_unit_valid check(quantity_unit in ('person','item')),
  constraint tickets_settlement_mode_valid check (
    settlement_mode in ('daily','monthly') and (entry_mode <> 'profit_only' or settlement_mode='monthly')
  )
);

create table if not exists public.projects (
  quantity_unit text not null default 'person' check(quantity_unit in ('person','item')),
  manual_agent_price boolean not null default false,
  manual_cost_price boolean,
  manual_supplier boolean,
  id uuid primary key,
  entry_mode text not null default 'standard',
  user_id uuid not null references auth.users(id) on delete cascade,
  supplier_id uuid references public.suppliers(id),
  supplier_name text not null,
  name text not null,
  normalized_name text not null,
  sub_item_name text not null,
  normalized_sub_item_name text not null,
  default_cost_thb numeric(14, 2) not null check (default_cost_thb >= 0),
  default_agent_price_thb numeric(14, 2) not null check (default_agent_price_thb >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  default_amount_basis text,
  settlement_mode text,
  unique (user_id, supplier_id, normalized_name, normalized_sub_item_name),
  constraint projects_entry_mode_valid check (
    entry_mode in ('standard','profit_only') and
    (entry_mode <> 'profit_only' or (default_cost_thb=0 and default_agent_price_thb=0))
  ),
  constraint projects_quantity_unit_valid check(quantity_unit in ('person','item')),
  constraint projects_default_amount_basis_valid check(default_amount_basis in ('total','per_person')),
  constraint projects_settlement_mode_valid check (
    settlement_mode in ('daily','monthly') and (entry_mode <> 'profit_only' or settlement_mode='monthly')
  ),
  constraint projects_supplier_mode_valid check (
    (manual_supplier is true and supplier_id is null and supplier_name='') or
    (manual_supplier is not true and supplier_id is not null)
  )
);

create index if not exists tickets_user_issue_date_idx on public.tickets (user_id, issue_date desc);
create index if not exists tickets_user_supplier_idx on public.tickets (user_id, supplier_id);
create index if not exists projects_user_supplier_idx on public.projects (user_id, supplier_id);
create unique index if not exists projects_unbound_name_unique
  on public.projects(user_id, normalized_name, normalized_sub_item_name) where supplier_id is null;

alter table public.suppliers enable row level security;
alter table public.projects enable row level security;
alter table public.tickets enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update on table public.suppliers, public.projects, public.tickets to authenticated;
revoke all privileges on table public.suppliers, public.projects, public.tickets from anon;

drop policy if exists "Users manage only their suppliers" on public.suppliers;
create policy "Users manage only their suppliers" on public.suppliers
  for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "Users manage only their projects" on public.projects;
create policy "Users manage only their projects" on public.projects
  for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "Users manage only their tickets" on public.tickets;
create policy "Users manage only their tickets" on public.tickets
  for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Supabase's automatic RLS event trigger is internal, not a client API.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;

create or replace function public.ledger_keep_latest_version()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.updated_at <= old.updated_at then
    return null;
  end if;
  return new;
end;
$$;

do $$
declare
  ledger_table text;
begin
  foreach ledger_table in array array['suppliers', 'projects', 'tickets'] loop
    execute format('drop trigger if exists ledger_keep_latest_version on public.%I', ledger_table);
    execute format('create trigger ledger_keep_latest_version before update on public.%I for each row execute function public.ledger_keep_latest_version()', ledger_table);
  end loop;

  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime' and puballtables) then
    foreach ledger_table in array array['suppliers', 'projects', 'tickets'] loop
      if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = ledger_table
      ) then
        execute format('alter publication supabase_realtime add table public.%I', ledger_table);
      end if;
    end loop;
  end if;
end;
$$;

create table if not exists public.ticket_refunds (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  ticket_id uuid not null references public.tickets(id),
  person_count integer check (person_count >= 1),
  is_full boolean not null,
  refund_revenue_thb numeric(14,2) not null check (refund_revenue_thb >= 0),
  returned_cost_thb numeric(14,2) not null check (returned_cost_thb >= 0),
  refund_date date not null,
  refund_time time without time zone not null,
  note text not null default '',
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint refunds_known_quantity check (person_count is not null or is_full)
);
create index if not exists ticket_refunds_user_ticket_idx on public.ticket_refunds(user_id,ticket_id);
create index if not exists ticket_refunds_ticket_idx on public.ticket_refunds(ticket_id);
alter table public.ticket_refunds enable row level security;
grant select,insert,update on public.ticket_refunds to authenticated;
revoke all privileges on public.ticket_refunds from anon;
revoke delete on public.ticket_refunds from authenticated;
drop policy if exists "Users manage only their refunds" on public.ticket_refunds;
create policy "Users manage only their refunds" on public.ticket_refunds
  for all to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);

create or replace function public.ledger_validate_refund()
returns trigger language plpgsql security invoker set search_path=public as $$
declare
  original public.tickets%rowtype;
  prior_count bigint;
  prior_revenue numeric;
  prior_cost numeric;
  prior_full boolean;
  quantity integer;
begin
  select * into original from public.tickets where id=new.ticket_id and user_id=new.user_id for update;
  if not found then raise exception '当前账号无法退这条出票记录。'; end if;
  if tg_op='UPDATE' then
    if (to_jsonb(new)-'cancelled_at'-'updated_at') is distinct from (to_jsonb(old)-'cancelled_at'-'updated_at') then
      raise exception '退票明细不可修改；请先撤销，再重新登记。';
    end if;
    if new.cancelled_at is not distinct from old.cancelled_at then return null; end if;
    if old.cancelled_at is not null then return null; end if;
    if new.cancelled_at is null or new.updated_at<=old.updated_at then
      raise exception '退票撤销状态无效，请刷新后重试。';
    end if;
    return new;
  end if;
  if new.cancelled_at is not null then raise exception '新增退票不能预先标记撤销。'; end if;
  if original.deleted_at is not null or original.entry_mode='profit_only' then raise exception '此记录不能办理退票。'; end if;
  if new.refund_date is null or not isfinite(new.refund_date) or new.refund_date < date '1000-01-01' or
    new.refund_date > (clock_timestamp() at time zone 'Asia/Bangkok')::date then
    raise exception '退款日期无效，不能晚于曼谷今天。';
  end if;
  select coalesce(sum(person_count),0),coalesce(sum(refund_revenue_thb),0),coalesce(sum(returned_cost_thb),0),coalesce(bool_or(is_full),false)
    into prior_count,prior_revenue,prior_cost,prior_full
    from public.ticket_refunds where ticket_id=new.ticket_id and user_id=new.user_id and cancelled_at is null;
  if prior_full then raise exception '此记录已经全部退票，请勿重复办理。'; end if;
  if original.person_count is null then
    if not new.is_full or new.person_count is not null then raise exception '人数未知的旧记录只能整单退票。'; end if;
  else
    if new.person_count is null or new.person_count<1 or prior_count+new.person_count>original.person_count then
      raise exception '退票数量超过剩余人数，请刷新后核对。';
    end if;
    if new.is_full is distinct from (prior_count+new.person_count=original.person_count) then
      raise exception '整单退票必须包含全部剩余人数。';
    end if;
  end if;
  quantity:=case when original.amount_basis='per_person' then original.person_count else 1 end;
  if prior_revenue+new.refund_revenue_thb>original.agent_price_thb*quantity or prior_cost+new.returned_cost_thb>original.cost_thb*quantity then
    raise exception '累计退款或成本返还超过原金额，请核对。';
  end if;
  return new;
end;
$$;
revoke execute on function public.ledger_validate_refund() from public, anon, authenticated;
drop trigger if exists ledger_validate_refund on public.ticket_refunds;
create trigger ledger_validate_refund before insert or update on public.ticket_refunds
  for each row execute function public.ledger_validate_refund();

-- The final version permits only the historical supplier-brand correction on a
-- refunded ticket; all other ticket edits remain blocked.
create or replace function public.ledger_protect_refunded_ticket()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at')
    and exists (
      select 1 from public.ticket_refunds r
      where r.ticket_id = old.id and r.user_id = old.user_id
    ) then
    if old.user_id = new.user_id
      and strpos(old.supplier_name, '华兴美') > 0
      and new.supplier_name = replace(old.supplier_name, '华兴美', '华星美')
      and (to_jsonb(new) - 'updated_at' - 'supplier_name') is not distinct from
          (to_jsonb(old) - 'updated_at' - 'supplier_name')
      and exists (
        select 1 from public.suppliers s
        where s.id = old.supplier_id and s.user_id = old.user_id
          and s.name in ('华兴美旅行社', '华星美旅行社')
      ) then
      return new;
    end if;
    raise exception '已有退票明细的原票不可编辑或删除，请保留完整记录。';
  end if;
  return new;
end;
$$;
revoke execute on function public.ledger_protect_refunded_ticket() from public, anon, authenticated;
drop trigger if exists ledger_protect_refunded_ticket on public.tickets;
create trigger ledger_protect_refunded_ticket before update on public.tickets
  for each row execute function public.ledger_protect_refunded_ticket();

do $$
begin
  if not exists(select 1 from pg_publication where pubname='supabase_realtime' and puballtables) and
    not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='ticket_refunds') then
    alter publication supabase_realtime add table public.ticket_refunds;
  end if;
end;
$$;

create or replace function public.ledger_preserve_rules()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  new.settlement_mode := coalesce(new.settlement_mode, old.settlement_mode);
  if tg_table_name='projects' then
    new.default_amount_basis := coalesce(new.default_amount_basis, old.default_amount_basis);
  end if;
  return new;
end;
$$;
revoke execute on function public.ledger_preserve_rules() from public, anon, authenticated;
drop trigger if exists ledger_00_preserve_rules on public.projects;
create trigger ledger_00_preserve_rules before update on public.projects for each row execute function public.ledger_preserve_rules();
drop trigger if exists ledger_00_preserve_rules on public.tickets;
create trigger ledger_00_preserve_rules before update on public.tickets for each row execute function public.ledger_preserve_rules();

create or replace function public.ledger_preserve_guest_name()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  new.guest_name := coalesce(nullif(new.guest_name, ''), old.guest_name);
  return new;
end;
$$;
revoke execute on function public.ledger_preserve_guest_name() from public, anon, authenticated;
drop trigger if exists ledger_01_preserve_guest_name on public.tickets;
create trigger ledger_01_preserve_guest_name before update on public.tickets for each row execute function public.ledger_preserve_guest_name();

create or replace function public.ledger_preserve_manual_cost()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  new.manual_cost_price := coalesce(new.manual_cost_price, old.manual_cost_price);
  new.manual_supplier := coalesce(new.manual_supplier, old.manual_supplier);
  return new;
end;
$$;
revoke execute on function public.ledger_preserve_manual_cost() from public, anon, authenticated;
drop trigger if exists ledger_00_preserve_manual_cost on public.projects;
create trigger ledger_00_preserve_manual_cost before update on public.projects for each row execute function public.ledger_preserve_manual_cost();

create or replace function public.ledger_canonical_supplier_brand()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if tg_table_name = 'suppliers' then
    if exists (
      select 1 from public.suppliers s
      where s.user_id = new.user_id
        and s.name in ('华兴美旅行社', '华星美旅行社')
        and (s.id = new.id or new.name in ('华兴美旅行社', '华星美旅行社'))
    ) then
      new.name := replace(new.name, '华兴美', '华星美');
      new.normalized_name := replace(new.normalized_name, '华兴美', '华星美');
    end if;
  elsif tg_table_name in ('projects', 'tickets') then
    if exists (
      select 1 from public.suppliers s
      where s.id = new.supplier_id and s.user_id = new.user_id
        and s.name in ('华兴美旅行社', '华星美旅行社')
    ) then
      new.supplier_name := replace(new.supplier_name, '华兴美', '华星美');
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.ledger_canonical_supplier_brand() from public, anon, authenticated;
drop trigger if exists ledger_00a_canonical_supplier_brand on public.suppliers;
create trigger ledger_00a_canonical_supplier_brand
  before insert or update on public.suppliers
  for each row execute function public.ledger_canonical_supplier_brand();
drop trigger if exists ledger_00a_canonical_supplier_brand on public.projects;
create trigger ledger_00a_canonical_supplier_brand
  before insert or update on public.projects
  for each row execute function public.ledger_canonical_supplier_brand();
drop trigger if exists ledger_00a_canonical_supplier_brand on public.tickets;
create trigger ledger_00a_canonical_supplier_brand
  before insert or update on public.tickets
  for each row execute function public.ledger_canonical_supplier_brand();

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

create or replace function public.record_show79_settlement(
  p_operation_id uuid,
  p_month text,
  p_payment_date date,
  p_jimmy_paid_thb numeric,
  p_partners_paid_thb numeric,
  p_note text,
  p_expected_profit_thb numeric,
  p_expected_jimmy_paid_thb numeric,
  p_expected_partners_paid_thb numeric,
  p_expected_user_id uuid
)
returns public.show79_settlements
language plpgsql security invoker set search_path = public as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_expected_user_id then
    raise exception '账号已切换，请重新打开当前账本再登记分账。' using errcode = '42501';
  end if;
  return public.record_show79_settlement(
    p_operation_id, p_month, p_payment_date, p_jimmy_paid_thb, p_partners_paid_thb,
    p_note, p_expected_profit_thb, p_expected_jimmy_paid_thb, p_expected_partners_paid_thb
  );
end;
$$;
revoke execute on function public.record_show79_settlement(uuid,text,date,numeric,numeric,text,numeric,numeric,numeric,uuid)
  from public, anon, authenticated;
grant execute on function public.record_show79_settlement(uuid,text,date,numeric,numeric,text,numeric,numeric,numeric,uuid)
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
