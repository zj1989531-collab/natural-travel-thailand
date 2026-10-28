-- Production hardening for the ticket ledger.
--
-- This migration is intentionally fail-closed: it refuses to change an
-- installation containing a cross-account supplier reference or a non-finite
-- monetary value. Financial history is never rewritten automatically. The
-- Supabase migration runner owns the transaction boundary.

do $$
begin
  if exists (
    select 1
    from public.projects p
    left join public.suppliers s on s.id = p.supplier_id and s.user_id = p.user_id
    where p.supplier_id is not null and s.id is null
  ) then
    raise exception '存在归属错误的项目供货商引用；请先人工核对，未应用账本加固。';
  end if;

  if exists (
    select 1
    from public.tickets t
    left join public.suppliers s on s.id = t.supplier_id and s.user_id = t.user_id
    where s.id is null
  ) then
    raise exception '存在归属错误的出票供货商引用；请先人工核对，未应用账本加固。';
  end if;

  if exists (
    select 1 from public.projects
    where default_cost_thb::text in ('NaN', 'Infinity', '-Infinity')
       or default_agent_price_thb::text in ('NaN', 'Infinity', '-Infinity')
       or default_cost_thb > 999999999999.99
       or default_agent_price_thb > 999999999999.99
  ) or exists (
    select 1 from public.tickets
    where agent_price_thb::text in ('NaN', 'Infinity', '-Infinity')
       or cost_thb::text in ('NaN', 'Infinity', '-Infinity')
       or coalesce(manual_profit_thb::text, '') in ('NaN', 'Infinity', '-Infinity')
       or agent_price_thb > 999999999999.99
       or cost_thb > 999999999999.99
       or manual_profit_thb > 999999999999.99
  ) or exists (
    select 1 from public.ticket_refunds
    where refund_revenue_thb::text in ('NaN', 'Infinity', '-Infinity')
       or returned_cost_thb::text in ('NaN', 'Infinity', '-Infinity')
       or refund_revenue_thb > 999999999999.99
       or returned_cost_thb > 999999999999.99
  ) then
    raise exception '存在无效金额；请先人工核对，未应用账本加固。';
  end if;
end;
$$;

alter table public.projects
  drop constraint if exists projects_default_cost_thb_check,
  drop constraint if exists projects_default_agent_price_thb_check,
  drop constraint if exists projects_default_cost_thb_valid,
  drop constraint if exists projects_default_agent_price_thb_valid,
  add constraint projects_default_cost_thb_valid check (
    default_cost_thb::text not in ('NaN', 'Infinity', '-Infinity')
    and default_cost_thb >= 0 and default_cost_thb <= 999999999999.99
  ) not valid,
  add constraint projects_default_agent_price_thb_valid check (
    default_agent_price_thb::text not in ('NaN', 'Infinity', '-Infinity')
    and default_agent_price_thb >= 0 and default_agent_price_thb <= 999999999999.99
  ) not valid;
alter table public.projects validate constraint projects_default_cost_thb_valid;
alter table public.projects validate constraint projects_default_agent_price_thb_valid;

alter table public.tickets
  drop constraint if exists tickets_agent_price_thb_check,
  drop constraint if exists tickets_cost_thb_check,
  drop constraint if exists tickets_agent_price_thb_valid,
  drop constraint if exists tickets_cost_thb_valid,
  drop constraint if exists tickets_manual_profit_thb_valid,
  add constraint tickets_agent_price_thb_valid check (
    agent_price_thb::text not in ('NaN', 'Infinity', '-Infinity')
    and agent_price_thb >= 0 and agent_price_thb <= 999999999999.99
  ) not valid,
  add constraint tickets_cost_thb_valid check (
    cost_thb::text not in ('NaN', 'Infinity', '-Infinity')
    and cost_thb >= 0 and cost_thb <= 999999999999.99
  ) not valid,
  add constraint tickets_manual_profit_thb_valid check (
    manual_profit_thb is null or (
      manual_profit_thb::text not in ('NaN', 'Infinity', '-Infinity')
      and manual_profit_thb >= 0 and manual_profit_thb <= 999999999999.99
    )
  ) not valid;
alter table public.tickets validate constraint tickets_agent_price_thb_valid;
alter table public.tickets validate constraint tickets_cost_thb_valid;
alter table public.tickets validate constraint tickets_manual_profit_thb_valid;

alter table public.ticket_refunds
  drop constraint if exists ticket_refunds_refund_revenue_thb_check,
  drop constraint if exists ticket_refunds_returned_cost_thb_check,
  drop constraint if exists ticket_refunds_refund_revenue_thb_valid,
  drop constraint if exists ticket_refunds_returned_cost_thb_valid,
  add constraint ticket_refunds_refund_revenue_thb_valid check (
    refund_revenue_thb::text not in ('NaN', 'Infinity', '-Infinity')
    and refund_revenue_thb >= 0 and refund_revenue_thb <= 999999999999.99
  ) not valid,
  add constraint ticket_refunds_returned_cost_thb_valid check (
    returned_cost_thb::text not in ('NaN', 'Infinity', '-Infinity')
    and returned_cost_thb >= 0 and returned_cost_thb <= 999999999999.99
  ) not valid;
alter table public.ticket_refunds validate constraint ticket_refunds_refund_revenue_thb_valid;
alter table public.ticket_refunds validate constraint ticket_refunds_returned_cost_thb_valid;

-- A composite key binds every non-manual project and every ticket to a
-- supplier from the same account. RLS protects rows; these foreign keys also
-- protect referential integrity when data arrives through another client.
alter table public.suppliers
  add constraint suppliers_id_user_id_key unique (id, user_id);

alter table public.projects drop constraint if exists projects_supplier_id_fkey;
alter table public.projects add constraint projects_supplier_owner_fkey
  foreign key (supplier_id, user_id) references public.suppliers(id, user_id) not valid;
alter table public.projects validate constraint projects_supplier_owner_fkey;

alter table public.tickets drop constraint if exists tickets_supplier_id_fkey;
alter table public.tickets add constraint tickets_supplier_owner_fkey
  foreign key (supplier_id, user_id) references public.suppliers(id, user_id) not valid;
alter table public.tickets validate constraint tickets_supplier_owner_fkey;

-- Existing (user_id, supplier_id) indexes serve ledger reads. The matching
-- (supplier_id, user_id) indexes below also start with the foreign-key column,
-- so supplier lifecycle checks do not scan the child tables.
create index if not exists projects_supplier_owner_idx on public.projects(supplier_id, user_id);
create index if not exists tickets_supplier_owner_idx on public.tickets(supplier_id, user_id);

-- Grant only the DML used by the browser. Existing installations may retain
-- default REFERENCES, TRIGGER or TRUNCATE grants unless they are revoked first.
revoke all privileges on table public.suppliers, public.projects, public.tickets from public, anon, authenticated;
grant select, insert, update on table public.suppliers, public.projects, public.tickets to authenticated;
revoke all privileges on table public.ticket_refunds from public, anon, authenticated;
grant select, insert, update on table public.ticket_refunds to authenticated;
revoke all privileges on table public.show79_settlements from public, anon, authenticated;
grant select, insert on table public.show79_settlements to authenticated;

-- Trigger helpers are internal implementation details, not browser RPCs.
do $$
declare
  function_name regprocedure;
begin
  foreach function_name in array array[
    to_regprocedure('public.ledger_keep_latest_version()'),
    to_regprocedure('public.ledger_validate_refund()'),
    to_regprocedure('public.ledger_protect_refunded_ticket()'),
    to_regprocedure('public.ledger_validate_show79_settlement()')
  ] loop
    if function_name is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', function_name);
    end if;
  end loop;
end;
$$;

notify pgrst, 'reload schema';
