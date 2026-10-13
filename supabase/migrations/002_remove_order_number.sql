-- 仅供已经执行过旧版 schema.sql 的项目使用。
-- 新项目只执行根目录的 schema.sql 即可，不需要执行本文件。
drop index if exists public.tickets_active_order_number_idx;
alter table public.tickets drop column if exists order_number;
