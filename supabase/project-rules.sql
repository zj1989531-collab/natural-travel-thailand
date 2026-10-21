-- Execute after schema.sql. Nullable columns preserve pre-upgrade snapshots.
alter table public.projects add column if not exists default_amount_basis text;
alter table public.projects add column if not exists settlement_mode text;
alter table public.tickets add column if not exists settlement_mode text;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid='public.projects'::regclass and conname='projects_default_amount_basis_valid') then
    alter table public.projects add constraint projects_default_amount_basis_valid check (default_amount_basis in ('total','per_person'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.projects'::regclass and conname='projects_settlement_mode_valid') then
    alter table public.projects add constraint projects_settlement_mode_valid check (settlement_mode in ('daily','monthly') and (entry_mode <> 'profit_only' or settlement_mode='monthly'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.tickets'::regclass and conname='tickets_settlement_mode_valid') then
    alter table public.tickets add constraint tickets_settlement_mode_valid check (settlement_mode in ('daily','monthly') and (entry_mode <> 'profit_only' or settlement_mode='monthly'));
  end if;
end;
$$;

-- Runs before version/refund guards. Old clients omit new columns in upserts;
-- their NULL values must not erase explicit rules or immutable ticket snapshots.
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
notify pgrst, 'reload schema';
