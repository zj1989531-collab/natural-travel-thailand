-- Existing installations: additive upgrade, preserving all records and RLS.
-- manual_agent_price=true means the stored default price is a placeholder;
-- the entry form starts blank and requires an explicitly entered actual price.
alter table public.projects add column if not exists manual_agent_price boolean not null default false;
alter table public.projects add column if not exists quantity_unit text not null default 'person';
alter table public.tickets add column if not exists quantity_unit text not null default 'person';
do $$
begin
  if not exists(select 1 from pg_constraint where conname='projects_quantity_unit_valid' and conrelid='public.projects'::regclass) then
    alter table public.projects add constraint projects_quantity_unit_valid check(quantity_unit in ('person','item'));
  end if;
  if not exists(select 1 from pg_constraint where conname='tickets_quantity_unit_valid' and conrelid='public.tickets'::regclass) then
    alter table public.tickets add constraint tickets_quantity_unit_valid check(quantity_unit in ('person','item'));
  end if;
end;
$$;
