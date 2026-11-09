# NodeWarden 邀请申请与免 Cron 改造方案

目标项目：[shuaiplus/nodewarden](https://github.com/shuaiplus/nodewarden)；本 fork：[buzhidao10068/nodewarden-invite](https://github.com/buzhidao10068/nodewarden-invite)。更新于 2026-11-09，当前实现与最初的自动分发方案已有调整，部署以 [README.md](README.md) 为准。

## 当前实现

用户填写邮箱和 1–5000 字的申请说明，通过 Turnstile、来源限流及文本查重后进入待审核。管理员查看申请，自行在 NodeWarden 管理页创建邀请码，通过自己的邮箱手动发送，再将申请标记为已发送或拒绝。

管理员既可在本项目的 `/admin` 网页登录审核，也可继续使用 PowerShell/API。`ADMIN_ACCESS_MODE` 支持 `web`（仅网页）、`api`（仅 API）、`both`（两者同时启用，默认）。两个入口复用同一套 D1 申请、风控和审计逻辑。

用户用填写的邮箱查询最新申请状态。查询只返回通用审核状态，不返回申请说明、管理员备注、邀请码或注册链接。页面无需保存或恢复秘密回执。

公开提交不会调用 NodeWarden 创建邀请码，没有每日发码总量限制、余量显示、发码名额预留或归还逻辑。保留 IP / 设备每日申请限制、处理中与已领取限制，以及每分钟限流。已发送 / 创建记录参与文本查重，人工审核负责最终判断。

## 原项目的 Cron 做了什么

原项目 [`hekuo5310/nl-invite-auto`](https://github.com/hekuo5310/nl-invite-auto) 面向 NodeLoc，其定时处理包括：

| 任务 | 原用途 | 本项目处理方式 |
| --- | --- | --- |
| 定时访问 NodeLoc | 维护 Cookie / CSRF 会话 | 管理员自行登录 NodeWarden；可选 API 按需获取短期令牌 |
| 每日补充库存 | 预生成固定数量邀请码保存到数据库 | 管理员审核后手动创建，没有库存补货任务 |
| 删除到期领取码 | 扫描删除队列，回收已发出的码 | NodeWarden 自身校验有效期与一次性使用状态 |

原 README 的每 30 分钟触发配置与代码中每 5 分钟删除分支并不相同，直接删除 Cron 不能让原版继续完整工作。本 fork 已替换这些流程。

## 无需 Cron 的申请流程

```text
填写邮箱、申请说明
    ↓
Turnstile、频率和来源检查
    ↓
D1 原子写入申请、邮箱及 IP / 设备限制
    ↓
文本查重 → 不通过则拒绝
    ↓
等待管理员人工审核
    ↓
管理员在 NodeWarden 创建邀请码，手动发邮件
    ↓
标记已发送，用户通过邮箱查询状态
```

日期限制通过记录中的日期判断，限流使用分钟窗口，无需每日清零。过期限流记录在请求时小批清理，申请与审计历史保留。管理人员需主动查看列表，没有邮件自动发送或后台通知任务。

## 数据和旧版升级

- 历史申请保存在 `nw_applications`，新增邮箱存放在独立的 `nw_application_emails` 表，使已有数据库可以重复执行建表文件升级。
- `schema.sql` 会删除旧每日发码计数表与触发器，保留历史申请、身份限制、已加密邀请码和审计记录。
- 旧申请没有邮箱，管理员仍可按 ID 查询；旧创建结果不明的记录继续通过受保护的恢复 / 释放接口人工核对。
- 旧秘密回执列仅为兼容现有数据库保留，新申请不生成回执，公开查询不再使用它。

升级必须在原申请服务 D1 执行完整最新版 `schema.sql`，保留原 `HASH_SALT` 和历史邀请码所用加密密钥，再部署最新 Worker。不要把申请库与 NodeWarden 业务库混用。

## 管理员与 NodeWarden API

基础申请服务只需 D1、Turnstile、随机盐和管理令牌。查看申请、手动发邮件、标记已发送和拒绝申请都无需给 Worker NodeWarden API 凭据。

### 网页与 PowerShell 可任选或同时使用

在 Cloudflare **Worker → Settings → Variables & Secrets** 添加 Text 变量 `ADMIN_ACCESS_MODE`，保存并部署：

| 值 | 网页 | PowerShell/API |
| --- | --- | --- |
| `web` | 开放 `/admin` 和网页会话接口 | `/internal/...` 返回 404 |
| `api` | `/admin` 和网页会话接口返回 404 | 保留原 Bearer 接口 |
| `both` 或未设置 | 开放 | 开放 |

管理员网页使用 `ADMIN_TOKEN` 登录，支持申请列表、状态筛选、每页 50 条分页、详情、管理员备注、标记邮件已发送、拒绝和释放资格。网页不会创建邀请码或发邮件，管理员在 NodeWarden 和自己的邮箱中完成这些步骤后，再回本项目记录结果。

网页通过 HTTPS 登录取得有效期 8 小时的签名 Cookie，具有 `HttpOnly`、`Secure` 和 `SameSite=Strict` 属性；不将管理令牌保存在网页源码或本地存储。写操作检查同源 `Origin`，登录另有限流。PowerShell 继续使用 `Authorization: Bearer <ADMIN_TOKEN>`。两种方式处理的是相同记录，其他窗口操作后刷新即可看到结果。

### 管理员网页 2FA

- 运行 `npm run admin:totp-setup` 在本地生成独立 Base32 随机密钥，手动添加至验证器，再将同一密钥保存为 Cloudflare Worker 的运行时 Secret `ADMIN_TOTP_SECRET`。
- 配置后网页必须同时验证 `ADMIN_TOKEN` 和 6 位 TOTP 动态码，使用 RFC 6238 的 SHA1、30 秒周期，允许前后一个周期偏差；配置错误或为空时拒绝登录，不自动降级。
- D1 原子写入已使用时间步，防止同一动态码的并发重复使用；复用 `nw_rate_limits` 的过期清理，无需新表、迁移或 Cron。未保存验证码明文或 2FA 密钥。
- 会话签名绑定管理令牌与 2FA 密钥，启用、更换或移除 2FA 后旧会话失效。已登录的 8 小时会话内无须每次操作重复输入验证码。
- PowerShell Bearer 认证保留；如要求所有管理入口均经 2FA，应选择 `ADMIN_ACCESS_MODE=web`。`both` 仍允许令牌直接访问管理 API。
- 验证器丢失可用私密备份密钥恢复，或通过 Cloudflare 控制台更换 Secret。具体绑定与恢复步骤见 README。

| 路径 | 用途 |
| --- | --- |
| `GET /admin` | 管理员登录与审核页 |
| `GET /admin/api/session` | 检查会话 |
| `POST /admin/api/session` | 管理令牌登录；配置 2FA 后需同时提交 `totp` 动态码 |
| `DELETE /admin/api/session` | 退出登录 |
| `GET /admin/api/applications?status=reviewing&offset=0` | 网页列表、状态筛选和分页 |
| `GET /admin/api/applications/:id` | 网页查看申请说明和邮箱 |
| `POST /admin/api/applications/:id/sent`、`reject`、`release` | 网页审核操作 |
| `/internal/applications...` | 原 PowerShell/API 路径，使用 Bearer 认证 |

选择仅网页模式后，旧记录恢复、撤码、封禁等上游管理可在 NodeWarden 自己的管理页处理；如需使用本项目的相关 API，可切换到 `both`。本次网页功能不新增数据库表，已部署人工审核版本可直接升级并沿用原令牌。

如需关联已手动发送的邀请码、查询使用情况、撤销或封禁用户，可配置 NodeWarden 管理员 API Key、`user.<管理员 UUID>`、主密码认证派生值和 AES-GCM 加密密钥。详细获取管理员 ID、API Key、Cloudflare Secret 的操作见 [README 的可选 API 接入](README.md#可选接入-nodewarden-管理-api)。

邮箱查询不验证邮箱所有权，因此仅返回状态；申请邮箱和申请文字只通过受保护的管理员网页或 API 读取。IP / 设备只是辅助风控信号，不能保证身份真实，也不能阻止邀请码转送。撤销邀请码不会封禁已经注册的用户。

## Cloudflare GitHub 部署

使用 Workers，从仓库根运行 `npm run deploy`，正式 `wrangler.jsonc` 指定 `src/index.ts` 入口，申请页和管理员网页均由 Worker 返回。无需静态资源目录。控制台建表、运行时变量、网页登录和管理员 PowerShell 示例，均见 [README](README.md)。

正式配置显式包含：

```json
{ "triggers": { "crons": [] } }
```

空数组用于移除此前部署的定时触发器。部署后在 Worker Settings → Triggers 中确认没有 Cron。本项目不再预生成邀请码，也不自动发送邮件。

## 验证范围

本地验证包含 Miniflare + D1 测试、TypeScript 检查和 Wrangler 试打包。测试覆盖邮箱申请和查询、人工处理状态、并发来源限制、旧数据库升级、历史邀请码管理，以及管理员网页会话、同源保护、三种管理模式、网页/API 状态共享、分页筛选和页面安全渲染。真实 Cloudflare 运行环境、NodeWarden 管理操作与邮件收信应在部署后验证。
