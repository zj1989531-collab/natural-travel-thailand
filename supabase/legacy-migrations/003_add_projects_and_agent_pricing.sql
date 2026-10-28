-- Archived pre-timestamp migration. It predates the reproducible baseline and
-- is retained only as historical source; Supabase must not replay it.
-- 仅供已运行过早期 schema.sql 的 Supabase 项目使用。
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'tickets' and column_name = 'revenue_thb') then
    alter table public.tickets rename column revenue_thb to agent_price_thb;
  end if;
end $$;

alter table public.tickets add column if not exists project_id uuid;
alter table public.tickets add column if not exists project_name text not null default '未分类项目';

create table if not exists public.projects (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id),
  supplier_name text not null,
  name text not null,
  normalized_name text not null,
  default_cost_thb numeric(14, 2) not null check (default_cost_thb >= 0),
  default_agent_price_thb numeric(14, 2) not null check (default_agent_price_thb >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, supplier_id, normalized_name)
);
create index if not exists projects_user_supplier_idx on public.projects (user_id, supplier_id);
alter table public.projects enable row level security;
create policy "Users manage only their projects" on public.projects
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
