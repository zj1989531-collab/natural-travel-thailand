-- A cancellation is now represented as a deleted order. Deleted orders are
-- excluded everywhere in the client; the tombstone remains only to prevent an
-- offline device from restoring a stale order.
create or replace function public.ledger_protect_refunded_ticket()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if (to_jsonb(new) - 'updated_at' - 'deleted_at') is distinct from (to_jsonb(old) - 'updated_at' - 'deleted_at')
    and exists (select 1 from public.ticket_refunds r where r.ticket_id = old.id and r.user_id = old.user_id) then
    raise exception '已有历史退票的订单只能删除，不能再编辑。';
  end if;
  return new;
end;
$$;

update public.tickets t
set deleted_at = coalesce(deleted_at, now()), updated_at = now()
where t.deleted_at is null
  and exists (select 1 from public.ticket_refunds r where r.ticket_id = t.id and r.cancelled_at is null);
