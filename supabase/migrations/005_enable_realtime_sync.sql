-- 已创建数据库执行此迁移；可以重复执行，不会删除或重置任何票务记录。
-- 为供货商、项目价格与出票记录启用实时通知，并保证较旧修改不能覆盖较新修改。
-- 显式授予登录账号所需 API 权限；未登录账号不能访问这些应用数据表。
grant usage on schema public to authenticated;
grant select, insert, update on table public.suppliers, public.projects, public.tickets to authenticated;
revoke all privileges on table public.suppliers, public.projects, public.tickets from anon;

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
