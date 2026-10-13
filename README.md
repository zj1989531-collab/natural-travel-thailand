# 票务盈利簿

面向手机的个人出票盈利统计工具。先维护供货商的项目、可选子项/套餐、成本与代理售价；出票时选择项目自动带入价格，并统计今日、本月及供货商利润排行。没有套餐区分时，子项可留空，系统会显示为“不分套餐”。

## 启动

需要 Node.js 20+ 与 pnpm：

```bash
pnpm install
pnpm dev
```

访问终端显示的本地地址后，可通过手机浏览器的“添加到主屏幕”安装。生产构建使用 `pnpm build`。

## GitHub 自动部署

目标仓库：[natural-travel-thailand](https://github.com/zj1989531-collab/natural-travel-thailand)。
线上地址：[票务盈利簿](https://zj1989531-collab.github.io/natural-travel-thailand/)。

在仓库 Settings → Pages 将 Source 设为 GitHub Actions。每次推送 main，工作流会安装固定版本依赖、运行测试、构建并发布；失败的检查不会更新线上网站。Pages 项目路径和手机离线资源在构建时自动适配，打开或刷新线上页面可获得最新版本。

本机完成 GitHub Git 登录并关联 origin 后，可以运行：

```bash
pnpm dev:sync
```

它同时打开本地开发服务并监听源码：保存后等待 5 秒，测试和构建通过才自动提交、上传。保持这个终端运行；关闭终端或 Ctrl+C 会停止监听。仅需后台监听可运行 `pnpm sync:watch`，单次上传可运行 `pnpm sync:github`。普通 `pnpm dev` 只启动网站，不上传代码。

自动上传限定为应用源码和部署配置，不会上传浏览器账本、Excel 备份或 `.env.local`。检测到手动暂存、远程新提交或检查失败时会暂停该次上传；不会强制覆盖远程修改。若 GitHub 登录失效，请重新完成本机 Git 登录。

完整的首次设置步骤见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 启用云端同步

1. 新建一个 Supabase 项目，并在 **SQL Editor** 执行 [supabase/schema.sql](./supabase/schema.sql)。
2. 在 Authentication 中启用 Email / Magic Link，并把应用地址加入 Redirect URLs。
3. 复制 `.env.example` 为 `.env.local`，填写项目 URL 与 publishable key 或 anon key。
4. 重启开发服务；登录邮箱后，本机尚未同步的记录会归属到该账号并自动上传。

不配置 Supabase 时，应用仍可离线使用并将数据保存在当前浏览器。清除浏览器网站数据会清除仅本机数据，因此应定期导出 Excel。

线上构建在 GitHub 仓库的 Settings → Secrets and variables → Actions 配置 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY`，然后重新运行 Deploy ticket ledger。两端登录同一邮箱，在线修改会自动同步；离线修改会排队，联网后自动上传。页面恢复前台时会重新核对数据，另有定时重试。

新项目执行 `schema.sql` 即可。若此前已经建库，按当前版本执行需要的 `supabase/migrations/` 升级脚本，再执行 `005_enable_realtime_sync.sql` 启用实时订阅和最新修改优先的数据库保护。

## 功能边界

第一版不包含真实出票、多币种、客户/乘客资料、应收应付、员工协作或历史数据导入。
