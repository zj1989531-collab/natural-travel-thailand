# 首次上线与同步配置

## 1. GitHub 网站

仓库：https://github.com/zj1989531-collab/natural-travel-thailand

在仓库 Settings → Pages，将 Build and deployment 的 Source 选择为 GitHub Actions。
仓库 Actions 中的 Deploy ticket ledger 成功后，访问：

https://zj1989531-collab.github.io/natural-travel-thailand/

以后每次推送 main 分支都会自动检查、发布。发布需要等待 GitHub 构建完成，并非保存瞬间完成；手机打开或刷新页面会读取最新版本。

## 2. 创建 Supabase 数据库

1. 打开 https://supabase.com/dashboard ，使用自己的账号登录或注册。账号、验证码和数据库密码自己保存，无需发给任何人。
2. 新建 Free 组织和项目；项目可命名为 natural-travel-thailand，区域选 Singapore（若可用）。保存生成的数据库密码，等待项目创建完成。
3. 打开项目 SQL Editor，新建查询，先执行仓库 `supabase/schema.sql`，再执行 `supabase/refunds.sql`。它们会创建供货商、项目套餐、票务记录、退票明细表，以及账号行级权限和实时同步配置。现有项目不要重复创建表；使用对应升级迁移。
4. 在 Authentication → URL Configuration 设置 Site URL 为 https://zj1989531-collab.github.io/natural-travel-thailand/ ，Redirect URLs 添加这个完整地址和 http://localhost:5173/ 。
5. 保留默认 Magic Link 邮件模板，先用注册 Supabase 时的邮箱登录；默认发信服务只允许组织成员的邮箱。其他邮箱需要配置自定义 SMTP 后才可使用。两台设备登录同一个邮箱。

## 3. 连接网站与数据库

从 Supabase 项目的 Connect 或 Settings → API/API Keys 页面复制：

- Project URL：形如 `https://项目编号.supabase.co`。
- Publishable key（`sb_publishable_` 开头）或旧式 anon 公钥。不要使用 secret 或 service_role 管理密钥。

在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加两个 Repository secrets：

- `VITE_SUPABASE_URL` = Project URL。
- `VITE_SUPABASE_ANON_KEY` = publishable/anon 公钥。

到 Actions → Deploy ticket ledger → Run workflow 重新部署。两个值都是浏览器客户端配置，最终会被打包到网站；票务数据的保护依靠数据库行级权限，不能把管理密钥放在这里。

电脑本地项目也需要配置 `.env.local`（此文件不上传），填写相同的两个值，然后重启开发服务。线上与 localhost 是两个不同浏览器存储空间；本地先登录、同步，再在手机线上地址登录同一邮箱，本地已有账本才能传过去。

## 4. 让电脑源码自动上传

本机 Git 必须具备仓库写权限。运行 `pnpm github:login`：它会使用已有 GitHub CLI，或从官方发布下载、校验后安装到项目 `.tools/gh`，接着引导浏览器登录并配置 Git。浏览器/GitHub 插件登录不等于本机 Git 登录。账号授权由你本人完成；密码和 token 不需要发到聊天里。

在项目目录运行 `pnpm dev:sync`。保持终端运行，保存源码后会自动检查、提交并推送；GitHub Actions 接着更新网站。`pnpm sync:watch` 只监听，`pnpm sync:github` 只执行一次。

## 5. 验收

电脑和手机打开线上网站并登录同一个邮箱。新增一笔记录，确认另一台在线设备无需手动刷新就出现，统计同时更新。测试离线新增后联网同步、编辑和删除同步，以及 Excel 导出。确认后可通过手机浏览器“添加到主屏幕”安装。

## 6. 退票记账

主页“退票”选择原票，可整单或部分退票；按本次实际总额填写退给代理的金额及供货商返还金额，不会实际转账。默认按原价格预填，手续费、不返还等情况需调整到实际金额。

退票回算原出票日期和原月份的利润、有效人数及门票数量，不计入退票当日；月结项目仍只计入月报。整单退票不代表利润一定归零，未返还的成本或手续费仍形成损益。

云端模式需联网且原票已同步，数据库锁定原票校验剩余数量和金额，防止两台设备超额退票。退票保存后可在记录的“退票明细”中撤销，恢复统计但保留明细。发生过退票（包括已撤销）的原票不可直接编辑或删除。Excel 导出增加有效人数及退票明细，完整 JSON 备份升级为版本2并保留所有退票及撤销记录。
