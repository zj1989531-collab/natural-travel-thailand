-- Correct this supplier's literal brand spelling without changing identities or
-- financial snapshots. Run as one transaction after refunds.sql. Safe to rerun.
-- Resolve the business by its unique natural name; no generated IDs are embedded.
begin;

create or replace function public.ledger_canonical_supplier_brand()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if tg_table_name = 'suppliers' then
    -- The existing business row anchors its account. A stale browser may also
    -- try to insert the old natural name under a new local supplier UUID.
    if exists (
      select 1 from public.suppliers s
      where s.user_id = new.user_id
        and s.name in ('华兴美旅行社', '华星美旅行社')
        and (s.id = new.id or new.name in ('华兴美旅行社', '华星美旅行社'))
    ) then
      new.name := replace(new.name, '华兴美', '华星美');
      new.normalized_name := replace(new.normalized_name, '华兴美', '华星美');
    end if;
  elsif tg_table_name in ('projects', 'tickets') then
    -- A textual match alone cannot rename another supplier's snapshot.
    if exists (
      select 1 from public.suppliers s
      where s.id = new.supplier_id and s.user_id = new.user_id
        and s.name in ('华兴美旅行社', '华星美旅行社')
    ) then
      new.supplier_name := replace(new.supplier_name, '华兴美', '华星美');
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.ledger_protect_refunded_ticket()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at')
    and exists (
      select 1 from public.ticket_refunds r
      where r.ticket_id = old.id and r.user_id = old.user_id
    ) then
    -- Sole exception: the same supplier/account/record and every other field
    -- remain identical; only the exact old spelling becomes its corrected form.
    if old.user_id = new.user_id
      and strpos(old.supplier_name, '华兴美') > 0
      and new.supplier_name = replace(old.supplier_name, '华兴美', '华星美')
      and (to_jsonb(new) - 'updated_at' - 'supplier_name') is not distinct from
          (to_jsonb(old) - 'updated_at' - 'supplier_name')
      and exists (
        select 1 from public.suppliers s
        where s.id = old.supplier_id and s.user_id = old.user_id
          and s.name in ('华兴美旅行社', '华星美旅行社')
      ) then
      return new;
    end if;
    raise exception '已有退票明细的原票不可编辑或删除，请保留完整记录。';
  end if;
  return new;
end;
$$;

-- PostgreSQL runs same-event triggers alphabetically. Normalize stale client
-- text before ledger_keep_latest_version / ledger_protect_refunded_ticket.
drop trigger if exists ledger_00a_canonical_supplier_brand on public.suppliers;
create trigger ledger_00a_canonical_supplier_brand
  before insert or update on public.suppliers
  for each row execute function public.ledger_canonical_supplier_brand();
drop trigger if exists ledger_00a_canonical_supplier_brand on public.projects;
create trigger ledger_00a_canonical_supplier_brand
  before insert or update on public.projects
  for each row execute function public.ledger_canonical_supplier_brand();
drop trigger if exists ledger_00a_canonical_supplier_brand on public.tickets;
create trigger ledger_00a_canonical_supplier_brand
  before insert or update on public.tickets
  for each row execute function public.ledger_canonical_supplier_brand();

do $$
declare
  target_owner public.suppliers.user_id%type;
  target_supplier public.suppliers.id%type;
  target_normalized_name text;
  business_rows bigint;
  business_owners bigint;
  expected_suppliers jsonb;
  expected_projects jsonb;
  expected_tickets jsonb;
  original_refunds jsonb;
  actual_rows jsonb;
  changed_suppliers bigint;
  changed_projects bigint;
  changed_tickets bigint;
begin
  select count(*), count(distinct s.user_id)
    into business_rows, business_owners
  from public.suppliers s
  where s.name in ('华兴美旅行社', '华星美旅行社');
  if business_rows <> 1 or business_owners <> 1 then
    raise exception '品牌自然键必须唯一对应一个供货商和账号；未修改任何数据。';
  end if;
  select s.user_id, s.id, replace(s.normalized_name, '华兴美', '华星美')
    into strict target_owner, target_supplier, target_normalized_name
  from public.suppliers s
  where s.name in ('华兴美旅行社', '华星美旅行社');
  if exists (
    select 1 from public.suppliers s
    where s.user_id = target_owner and s.id <> target_supplier
      and replace(s.normalized_name, '华兴美', '华星美') = target_normalized_name
  ) then
    raise exception '当前账号存在同名供货商，需先核对目录身份；未修改任何数据。';
  end if;

  -- Snapshot all rows belonging to this owner. Compare complete JSON sets after
  -- the correction, excluding timestamps only; each permitted text change is
  -- calculated explicitly. IDs, prices, counts, dates and notes stay in the check.
  select coalesce(jsonb_agg(
    (to_jsonb(s) - 'updated_at') || case when s.id = target_supplier then
      jsonb_build_object('name', replace(s.name, '华兴美', '华星美'),
                         'normalized_name', replace(s.normalized_name, '华兴美', '华星美'))
      else '{}'::jsonb end order by s.id), '[]'::jsonb)
    into expected_suppliers from public.suppliers s where s.user_id = target_owner;
  select coalesce(jsonb_agg(
    (to_jsonb(p) - 'updated_at') || case when p.supplier_id = target_supplier then
      jsonb_build_object('supplier_name', replace(p.supplier_name, '华兴美', '华星美'))
      else '{}'::jsonb end order by p.id), '[]'::jsonb)
    into expected_projects from public.projects p where p.user_id = target_owner;
  select coalesce(jsonb_agg(
    (to_jsonb(t) - 'updated_at') || case when t.supplier_id = target_supplier then
      jsonb_build_object('supplier_name', replace(t.supplier_name, '华兴美', '华星美'))
      else '{}'::jsonb end order by t.id), '[]'::jsonb)
    into expected_tickets from public.tickets t where t.user_id = target_owner;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]'::jsonb)
    into original_refunds from public.ticket_refunds r where r.user_id = target_owner;

  update public.suppliers s
  set name = replace(s.name, '华兴美', '华星美'),
      normalized_name = replace(s.normalized_name, '华兴美', '华星美'),
      updated_at = greatest(clock_timestamp(), s.updated_at + interval '1 millisecond')
  where s.user_id = target_owner and s.id = target_supplier
    and (strpos(s.name, '华兴美') > 0 or strpos(s.normalized_name, '华兴美') > 0);
  get diagnostics changed_suppliers = row_count;
  update public.projects p
  set supplier_name = replace(p.supplier_name, '华兴美', '华星美'),
      updated_at = greatest(clock_timestamp(), p.updated_at + interval '1 millisecond')
  where p.user_id = target_owner and p.supplier_id = target_supplier
    and strpos(p.supplier_name, '华兴美') > 0;
  get diagnostics changed_projects = row_count;
  update public.tickets t
  set supplier_name = replace(t.supplier_name, '华兴美', '华星美'),
      updated_at = greatest(clock_timestamp(), t.updated_at + interval '1 millisecond')
  where t.user_id = target_owner and t.supplier_id = target_supplier
    and strpos(t.supplier_name, '华兴美') > 0;
  get diagnostics changed_tickets = row_count;

  select coalesce(jsonb_agg(to_jsonb(s) - 'updated_at' order by s.id), '[]'::jsonb)
    into actual_rows from public.suppliers s where s.user_id = target_owner;
  if actual_rows is distinct from expected_suppliers then
    raise exception '供货商核对失败：出现预期之外的字段或记录变化。';
  end if;
  select coalesce(jsonb_agg(to_jsonb(p) - 'updated_at' order by p.id), '[]'::jsonb)
    into actual_rows from public.projects p where p.user_id = target_owner;
  if actual_rows is distinct from expected_projects then
    raise exception '价格目录核对失败：出现预期之外的字段或记录变化。';
  end if;
  select coalesce(jsonb_agg(to_jsonb(t) - 'updated_at' order by t.id), '[]'::jsonb)
    into actual_rows from public.tickets t where t.user_id = target_owner;
  if actual_rows is distinct from expected_tickets then
    raise exception '票据核对失败：出现预期之外的字段或记录变化。';
  end if;
  select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]'::jsonb)
    into actual_rows from public.ticket_refunds r where r.user_id = target_owner;
  if actual_rows is distinct from original_refunds then
    raise exception '退款事件核对失败：退款记录不得发生任何变化。';
  end if;
  if exists (select 1 from public.suppliers s where s.user_id = target_owner and
      (strpos(s.name, '华兴美') > 0 or strpos(s.normalized_name, '华兴美') > 0))
    or exists (select 1 from public.projects p where p.user_id = target_owner and strpos(p.supplier_name, '华兴美') > 0)
    or exists (select 1 from public.tickets t where t.user_id = target_owner and strpos(t.supplier_name, '华兴美') > 0) then
    raise exception '仍存在旧品牌拼写；所有修改已回滚。';
  end if;
  raise notice '品牌更正完成：供货商 %、价格目录 %、票据 %；其余字段及退款事件保持原样。',
    changed_suppliers, changed_projects, changed_tickets;
end;
$$;

commit;
