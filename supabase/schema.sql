-- 在 Supabase Dashboard 的 SQL Editor 中执行一次。
-- Also execute refunds.sql, project-rules.sql, show79.sql, manual-project-cost.sql.
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
  manual_cost_price boolean,
  manual_supplier boolean,
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
