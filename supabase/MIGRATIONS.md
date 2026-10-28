# 数据库迁移与可复现基线

`supabase/migrations/` 是唯一可执行的数据库迁移链。根目录的 `schema.sql`、`refunds.sql` 等文件是早期 Dashboard 手动部署的兼容参考，不能再作为新库安装或已有库升级的执行入口。

## 已固化的生产基线

- `20261013093949_initialize_ticket_ledger.sql` 是完整、可重复执行的空库基线，包含当前账本的表、RLS、权限、触发器、RPC 与 Realtime 配置。
- 后续 13 个时间戳文件是与既有生产数据库完全相同的历史版本标记；它们是显式 no-op，避免为了补齐仓库而改写线上迁移历史。
- 首个名为 `*_harden_ledger_integrity.sql` 的迁移真正位于基线之后，负责金额、同账号供货商外键、索引与最小权限加固。其时间戳必须与实际执行环境记录的版本一致。
- `supabase/legacy-migrations/` 保留了旧的 `002`–`005` 文件供审计；它们依赖旧结构，不能由 Supabase CLI 回放。

因此，空数据库依次回放可得到当前结构；已有生产库则已经拥有前 14 个版本，只会接收之后的新迁移。无需、也不得使用 `migration repair` 或人为篡改生产迁移历史。

## 新环境验证

这个流程需要 Supabase CLI、Docker 和一个**本地或临时**数据库；GitHub Pages 工作流不执行数据库迁移。

1. 在克隆仓库后运行 `supabase init`（生成可提交的 `supabase/config.toml`），然后运行 `supabase start`。
2. 执行 `supabase db reset`，它会从空数据库按时间顺序回放全部 SQL 迁移。不要对生产库使用 `supabase db reset --linked`。
3. 执行 `pnpm test`，再对临时环境执行 RLS、RPC、Realtime 和离线同步验收。
4. 仅当验证通过后，才用 `supabase link --project-ref <temporary-project-ref>` 和 `supabase db push --dry-run` 检查临时云环境。

## 已有生产库升级

1. 先在 Dashboard 创建备份，运行 `supabase migration list` 确认前 14 个时间戳与仓库一致。
2. 先在 Supabase Branch 或恢复的临时副本执行 `supabase db push --dry-run`，再验证实际迁移。
3. 确认无误后再对生产库执行 `supabase db push`。生产环境只会运行晚于 `20261023123233` 的迁移。若因紧急修复使用 Supabase MCP 的 `apply_migration`，它会生成服务器时间戳：立刻运行 `supabase migration list`（或 MCP 的迁移列表），把仓库中同名迁移文件改为该**已记录的**时间戳，再提交；不要用 `migration repair` 伪造版本。

## 日常规则

- 每次结构变更先用 `supabase migration new <name>` 创建时间戳迁移，在临时环境 `supabase db reset` 回放后再发布。
- 不在 GitHub Pages 构建期间执行数据库迁移；页面发布和数据库变更必须分别验证。
- 若线上结构曾通过 Dashboard 或 SQL Editor 临时改动，先用 `supabase db pull` 固化为新迁移，再发布依赖该结构的前端版本。
- 不提交生产数据、用户资料、数据库密码或服务端密钥。

参考：<https://supabase.com/docs/guides/local-development/cli-workflows>
