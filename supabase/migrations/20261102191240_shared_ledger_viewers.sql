-- A shareholder is allowed to read exactly one owner's ledger.  Write policies
-- remain owner-only on the financial tables below.
create table public.ledger_members (
  ledger_owner_id uuid not null references auth.users(id) on delete cascade,
  member_user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer' check (role = 'viewer'),
  status text not null default 'active' check (status = 'active' or status = 'revoked'),
  created_at timestamptz not null default now(),
  primary key (ledger_owner_id, member_user_id),
  check (ledger_owner_id <> member_user_id)
);

create index ledger_members_active_member_idx
  on public.ledger_members (member_user_id, ledger_owner_id)
  where status = 'active';

alter table public.ledger_members enable row level security;
grant select, insert, update, delete on public.ledger_members to authenticated;

create policy "Owners manage their ledger viewers"
on public.ledger_members for all to authenticated
using ((select auth.uid()) = ledger_owner_id)
with check ((select auth.uid()) = ledger_owner_id and role = 'viewer');

create policy "Viewers read their own ledger access"
on public.ledger_members for select to authenticated
using ((select auth.uid()) = member_user_id);

-- Extend SELECT only. Existing owner-only ALL/INSERT/UPDATE/DELETE policies
-- continue to prevent viewer writes even when a request is forged.
create policy "Authorized viewers read shared suppliers"
on public.suppliers for select to authenticated
using (exists (
  select 1 from public.ledger_members m
  where m.ledger_owner_id = suppliers.user_id
    and m.member_user_id = (select auth.uid())
    and m.role = 'viewer' and m.status = 'active'
));

create policy "Authorized viewers read shared projects"
on public.projects for select to authenticated
using (exists (
  select 1 from public.ledger_members m
  where m.ledger_owner_id = projects.user_id
    and m.member_user_id = (select auth.uid())
    and m.role = 'viewer' and m.status = 'active'
));

create policy "Authorized viewers read shared tickets"
on public.tickets for select to authenticated
using (exists (
  select 1 from public.ledger_members m
  where m.ledger_owner_id = tickets.user_id
    and m.member_user_id = (select auth.uid())
    and m.role = 'viewer' and m.status = 'active'
));

create policy "Authorized viewers read shared refunds"
on public.ticket_refunds for select to authenticated
using (exists (
  select 1 from public.ledger_members m
  where m.ledger_owner_id = ticket_refunds.user_id
    and m.member_user_id = (select auth.uid())
    and m.role = 'viewer' and m.status = 'active'
));

create policy "Authorized viewers read shared 79 settlements"
on public.show79_settlements for select to authenticated
using (exists (
  select 1 from public.ledger_members m
  where m.ledger_owner_id = show79_settlements.user_id
    and m.member_user_id = (select auth.uid())
    and m.role = 'viewer' and m.status = 'active'
));

-- Memberships are deliberately provisioned outside schema migrations. This
-- keeps project-specific account identifiers out of source control and lets a
-- fresh staging database apply this schema before any users have signed in.
