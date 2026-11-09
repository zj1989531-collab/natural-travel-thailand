-- Each table gets one SELECT policy that covers both its owner and an active
-- viewer. Write policies stay owner-only.
drop policy if exists "Owners manage their ledger viewers" on public.ledger_members;
drop policy if exists "Viewers read their own ledger access" on public.ledger_members;
create policy "Ledger members can read relevant access"
on public.ledger_members for select to authenticated
using ((select auth.uid()) = ledger_owner_id or (select auth.uid()) = member_user_id);
create policy "Owners add ledger viewers"
on public.ledger_members for insert to authenticated
with check ((select auth.uid()) = ledger_owner_id and role = 'viewer');
create policy "Owners update ledger viewers"
on public.ledger_members for update to authenticated
using ((select auth.uid()) = ledger_owner_id)
with check ((select auth.uid()) = ledger_owner_id and role = 'viewer');
create policy "Owners remove ledger viewers"
on public.ledger_members for delete to authenticated
using ((select auth.uid()) = ledger_owner_id);

drop policy if exists "Users manage only their suppliers" on public.suppliers;
drop policy if exists "Authorized viewers read shared suppliers" on public.suppliers;
create policy "Owners and viewers read suppliers" on public.suppliers for select to authenticated
using ((select auth.uid()) = user_id or exists (select 1 from public.ledger_members m where m.ledger_owner_id = suppliers.user_id and m.member_user_id = (select auth.uid()) and m.role = 'viewer' and m.status = 'active'));
create policy "Owners insert suppliers" on public.suppliers for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Owners update suppliers" on public.suppliers for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Owners delete suppliers" on public.suppliers for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Users manage only their projects" on public.projects;
drop policy if exists "Authorized viewers read shared projects" on public.projects;
create policy "Owners and viewers read projects" on public.projects for select to authenticated
using ((select auth.uid()) = user_id or exists (select 1 from public.ledger_members m where m.ledger_owner_id = projects.user_id and m.member_user_id = (select auth.uid()) and m.role = 'viewer' and m.status = 'active'));
create policy "Owners insert projects" on public.projects for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Owners update projects" on public.projects for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Owners delete projects" on public.projects for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Users manage only their tickets" on public.tickets;
drop policy if exists "Authorized viewers read shared tickets" on public.tickets;
create policy "Owners and viewers read tickets" on public.tickets for select to authenticated
using ((select auth.uid()) = user_id or exists (select 1 from public.ledger_members m where m.ledger_owner_id = tickets.user_id and m.member_user_id = (select auth.uid()) and m.role = 'viewer' and m.status = 'active'));
create policy "Owners insert tickets" on public.tickets for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Owners update tickets" on public.tickets for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Owners delete tickets" on public.tickets for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Users manage only their refunds" on public.ticket_refunds;
drop policy if exists "Authorized viewers read shared refunds" on public.ticket_refunds;
create policy "Owners and viewers read refunds" on public.ticket_refunds for select to authenticated
using ((select auth.uid()) = user_id or exists (select 1 from public.ledger_members m where m.ledger_owner_id = ticket_refunds.user_id and m.member_user_id = (select auth.uid()) and m.role = 'viewer' and m.status = 'active'));
create policy "Owners insert refunds" on public.ticket_refunds for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Owners update refunds" on public.ticket_refunds for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Owners delete refunds" on public.ticket_refunds for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "Users read only their 79 settlements" on public.show79_settlements;
drop policy if exists "Authorized viewers read shared 79 settlements" on public.show79_settlements;
create policy "Owners and viewers read 79 settlements" on public.show79_settlements for select to authenticated
using ((select auth.uid()) = user_id or exists (select 1 from public.ledger_members m where m.ledger_owner_id = show79_settlements.user_id and m.member_user_id = (select auth.uid()) and m.role = 'viewer' and m.status = 'active'));
