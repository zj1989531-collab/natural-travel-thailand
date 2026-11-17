-- Refunds are retained only as legacy audit rows. A valid refund must remove
-- its original order from every active view, report and device immediately.
create or replace function public.ledger_delete_ticket_on_refund()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.cancelled_at is null then
    update public.tickets
    set deleted_at = coalesce(deleted_at, now()),
        updated_at = now()
    where id = new.ticket_id
      and user_id = new.user_id
      and deleted_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists ledger_delete_ticket_on_refund on public.ticket_refunds;
create trigger ledger_delete_ticket_on_refund
  after insert on public.ticket_refunds
  for each row execute function public.ledger_delete_ticket_on_refund();

-- Close the gap created by refunds written after the prior one-time migration.
update public.tickets t
set deleted_at = coalesce(t.deleted_at, now()),
    updated_at = now()
where t.deleted_at is null
  and exists (
    select 1
    from public.ticket_refunds r
    where r.ticket_id = t.id
      and r.user_id = t.user_id
      and r.cancelled_at is null
  );
