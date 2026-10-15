-- Existing installations: add the customer name used by the 79 show voucher.
-- Ownership, RLS, realtime publication and refund guards remain unchanged.
alter table public.tickets add column if not exists guest_name text not null default '';

-- An older device's upsert omits guest_name and receives the empty default.
-- Keep the previously saved customer name rather than silently erasing it.
create or replace function public.ledger_preserve_guest_name()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  new.guest_name := coalesce(nullif(new.guest_name, ''), old.guest_name);
  return new;
end;
$$;
revoke execute on function public.ledger_preserve_guest_name() from public, anon, authenticated;
drop trigger if exists ledger_01_preserve_guest_name on public.tickets;
create trigger ledger_01_preserve_guest_name before update on public.tickets for each row execute function public.ledger_preserve_guest_name();
notify pgrst, 'reload schema';
