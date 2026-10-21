-- 在 Supabase Dashboard 的 SQL Editor 中执行一次。
-- Complete schema for a new Supabase project. It includes refund records;
-- no additional SQL file is required for a fresh installation.
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
  constraint tickets_amount_basis_valid check (amount_basis in ('total','per_person') and (amount_basis <> 'per_person' or (person_count is not null and person_count >= 1))),
  constraint tickets_entry_mode_valid check (
    (entry_mode='standard' and manual_profit_thb is null) or
    (entry_mode='profit_only' and manual_profit_thb is not null and manual_profit_thb >= 0 and agent_price_thb=0 and cost_thb=0)
  )
);

create index if not exists tickets_user_issue_date_idx on public.tickets (user_id, issue_date desc);
create index if not exists tickets_user_supplier_idx on public.tickets (user_id, supplier_id);

create table if not exists public.projects (
  quantity_unit text not null default 'person' check(quantity_unit in ('person','item')),
  manual_agent_price boolean not null default false,
  id uuid primary key,
  entry_mode text not null default 'standard',
  user_id uuid not null references auth.users(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id),
  supplier_name text not null,
  name text not null,
  normalized_name text not null,
  sub_item_name text not null,
  normalized_sub_item_name text not null,
  default_cost_thb numeric(14, 2) not null check (default_cost_thb >= 0),
  default_agent_price_thb numeric(14, 2) not null check (default_agent_price_thb >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, supplier_id, normalized_name, normalized_sub_item_name),
  constraint projects_entry_mode_valid check (entry_mode in ('standard','profit_only') and (entry_mode <> 'profit_only' or (default_cost_thb=0 and default_agent_price_thb=0)))
);

create index if not exists projects_user_supplier_idx on public.projects (user_id, supplier_id);
alter table public.suppliers enable row level security;
alter table public.projects enable row level security;
alter table public.tickets enable row level security;

-- Explicit API privileges; row-level policies still restrict each user's rows.
grant usage on schema public to authenticated;
grant select, insert, update on table public.suppliers, public.projects, public.tickets to authenticated;
revoke all privileges on table public.suppliers, public.projects, public.tickets from anon;

create policy "Users manage only their suppliers" on public.suppliers
  for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "Users manage only their projects" on public.projects
  for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

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

-- Refunds are immutable financial events; only voiding is allowed.
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
  if new.refund_date<original.issue_date then raise exception '退票日期不能早于出票日期。'; end if;
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
create trigger ledger_validate_refund before insert or update on public.ticket_refunds
  for each row execute function public.ledger_validate_refund();

create or replace function public.ledger_protect_refunded_ticket()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
  if (to_jsonb(new)-'updated_at') is distinct from (to_jsonb(old)-'updated_at') and
    exists(select 1 from public.ticket_refunds where ticket_id=old.id and user_id=old.user_id) then
    raise exception '已有退票明细的原票不可编辑或删除，请保留完整记录。';
  end if;
  return new;
end;
$$;
create trigger ledger_protect_refunded_ticket before update on public.tickets
  for each row execute function public.ledger_protect_refunded_ticket();

-- Reject an older concurrent upload before it can overwrite the latest record.
-- Equal timestamps are already acknowledged and must not emit another UPDATE.
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
    foreach ledger_table in array array['suppliers', 'projects', 'tickets', 'ticket_refunds'] loop
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
