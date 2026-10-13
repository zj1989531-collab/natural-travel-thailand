-- Execute after schema.sql. Refunds are immutable financial events; only voiding is allowed.
create table public.ticket_refunds (
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
create index ticket_refunds_user_ticket_idx on public.ticket_refunds(user_id,ticket_id);
create index ticket_refunds_ticket_idx on public.ticket_refunds(ticket_id);
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

do $$
begin
  if not exists(select 1 from pg_publication where pubname='supabase_realtime' and puballtables) and
    not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='ticket_refunds') then
    alter publication supabase_realtime add table public.ticket_refunds;
  end if;
end;
$$;
