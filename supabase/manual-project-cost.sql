-- Additive upgrade; run before releasing clients that support manual costs.
-- NULL means an old client has not supplied this setting, not an explicit false.
alter table public.projects add column if not exists manual_cost_price boolean;
alter table public.projects add column if not exists manual_supplier boolean;
alter table public.projects alter column supplier_id drop not null;
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.projects'::regclass and conname='projects_supplier_mode_valid') then
    alter table public.projects add constraint projects_supplier_mode_valid check (
      (manual_supplier is true and supplier_id is null and supplier_name='') or
      (manual_supplier is not true and supplier_id is not null)
    );
  end if;
end $$;
create unique index if not exists projects_unbound_name_unique on public.projects(user_id, normalized_name, normalized_sub_item_name) where supplier_id is null;
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
notify pgrst, 'reload schema';
