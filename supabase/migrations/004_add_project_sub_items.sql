-- 仅供已经执行过 003_add_projects_and_agent_pricing.sql 的云端项目使用。
alter table public.projects add column if not exists sub_item_name text not null default '默认套餐';
alter table public.projects add column if not exists normalized_sub_item_name text not null default '默认套餐';
alter table public.projects drop constraint if exists projects_user_id_supplier_id_normalized_name_key;
create unique index if not exists projects_supplier_project_sub_item_idx
  on public.projects (user_id, supplier_id, normalized_name, normalized_sub_item_name);

alter table public.tickets add column if not exists sub_item_name text not null default '默认套餐';
