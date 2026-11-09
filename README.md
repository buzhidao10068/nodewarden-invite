# NodeWarden 邀请码自动分发

这个 Worker 是从 [`hekuo5310/nl-invite-auto`](https://github.com/hekuo5310/nl-invite-auto) 改造而来（原项目 Apache-2.0）。它保留 Turnstile、申请文字查重、AI 审核、D1 申请记录和领取风控，但将上游改为 NodeWarden 管理员 API。

申请通过后才即时创建一枚 NodeWarden 单次邀请码，默认有效 1 小时。有效期由 NodeWarden 校验，不依赖预生成库存、定时删除或会话保活，因此 Wrangler 配置显式使用 `"triggers": { "crons": [] }`。

## 处理流程

1. 浏览器生成申请 ID、一次性回执和设备标识；服务端验证 Turnstile、IP、请求频率和输入长度。
2. D1 批量事务一次性写入每日申请锁、IP/设备资格锁和当天发放配额。任何唯一约束或配额失败都会整批回滚。
3. 文本查重和 AI 审核通过后，Worker 使用 NodeWarden 的 `client_credentials` 获取短期管理员访问令牌。
4. 使用条件更新把申请从 `reviewing` 改为 `creating`，只有抢到这个状态的请求才调用 `POST /api/admin/invites`，提交 `expiresInHours` 和 `masterPasswordHash`。
5. 邀请码用 AES-GCM 加密后保存到 D1，页面凭秘密回执查询注册链接和有效期。日志不记录邀请码和密钥；受认证保护的管理员接口可查看邀请码。

### 未知结果必须人工核对

如果 NodeWarden 请求超时、返回 5xx 或响应无法解析，服务会把申请标记为 `uncertain`，保留资格和配额，不会盲目重试创建。管理员可先查询 NodeWarden，再使用受保护的内部接口恢复关联、撤销未使用的码，或确认没有可用码后释放资格。NodeWarden 当前创建接口没有幂等键，因此不能由 Worker 自动推断超时请求是否已经成功。

## 配置和部署

需要 Node.js 22 或更新的受支持版本、Cloudflare Workers / D1 账号，以及已经部署并能正常创建邀请码的 NodeWarden。以下命令在本仓库根目录运行。

### 1. 安装依赖，创建独立 D1

```powershell
npm ci
Copy-Item -LiteralPath wrangler.jsonc.example -Destination wrangler.jsonc
npx wrangler login
npx wrangler d1 create nodewarden-invite
```

把创建结果中的 `database_id` 填进 `wrangler.jsonc` 的 `d1_databases`，保留 `binding: "DB"`。然后初始化远程数据库：

```powershell
npx wrangler d1 execute nodewarden-invite --remote --file=schema.sql
```

这是**分发服务自己的全新 D1**，不要填写 NodeWarden 正在使用的数据库 ID。`schema.sql` 不迁移旧 NodeLoc 库存、领取记录和删除队列；已有旧服务需要自行处理未完成任务与历史限制，再切换到新服务。

### 2. 获取 NodeWarden 管理凭据

使用专门的管理员账户，确认其角色为 `admin`、状态为 `active`，在 NodeWarden 网页设置中查看个人 API Key：

- `NODEWARDEN_CLIENT_ID`：`user.<管理员用户 ID>`。用户 ID 可在自己已登录页面的 Network 面板中，从 `GET /api/accounts/profile` 的响应 `id` 读取。
- `NODEWARDEN_CLIENT_SECRET`：该账户的个人 API Key，不是登录密码或浏览器 Cookie。
- `NODEWARDEN_MASTER_PASSWORD_HASH`：NodeWarden 网页端根据主密码和账户 KDF 参数计算的认证派生值。可在自己的 Network 面板中，查看“获取 API Key”请求（`POST /api/accounts/api-key`）的请求体，取 `masterPasswordHash`；也可从一次正常手动创建邀请码的请求体获取。不要填写明文主密码，也不要把该值当作数据库里存储的密码摘要。

这些值具有管理员权限，仅在本机配置到 Wrangler Secret，勿贴到聊天、截图、HAR、代码或日志中。当前上游没有仅允许创建邀请码的细粒度 API Key。修改管理员主密码或 KDF 参数后应重新获取派生值；轮换 API Key 后应更新 `NODEWARDEN_CLIENT_SECRET`。不需要关闭两步验证，也不需要维护 Cookie / CSRF 会话。

接入依据为 NodeWarden 提交 [`fbc0e65`](https://github.com/shuaiplus/nodewarden/tree/fbc0e65df8f405c3120887569e939d615ab68229) 和[管理员 API 文档](https://nodewarden.app/zh/guide/core/api-reference#管理员接口)。更旧或更新版本应先在测试实例核对。

### 3. 填写公开配置和 Secret

`wrangler.jsonc` 的 `vars` 配置如下；配置文件已被 `.gitignore` 忽略，但仍只放非敏感值：

| 配置 | 用途 / 默认值 |
| --- | --- |
| `NODEWARDEN_URL` | NodeWarden 的 HTTPS origin，例如 `https://vault.example.com`，不要带路径、查询或账号密码 |
| `NODEWARDEN_CLIENT_ID` | `user.<管理员用户 ID>` |
| `AI_API_URL` | 兼容 Chat Completions 的完整 HTTPS 接口地址，例如以 `/v1/chat/completions` 结尾 |
| `AI_MODEL` | 你的审核模型名称；需要支持返回 JSON 文本 |
| `TURNSTILE_SITE_KEY` | Turnstile 公开 Site Key，在控制台允许申请页实际域名 |
| `DAILY_INVITE_LIMIT` | 每个北京时间自然日的发放上限，默认 `3` |
| `INVITE_EXPIRES_IN_HOURS` | 邀请码有效小时数，默认 `1`，范围 `1–720` |

分别生成三份随机值，用于 `DATA_ENCRYPTION_KEY`、`HASH_SALT`、`ADMIN_TOKEN`。每次运行会生成新的 32 字节随机值：

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

逐项执行以下命令，在交互输入中粘贴对应值：

```powershell
npx wrangler secret put NODEWARDEN_CLIENT_SECRET
npx wrangler secret put NODEWARDEN_MASTER_PASSWORD_HASH
npx wrangler secret put DATA_ENCRYPTION_KEY
npx wrangler secret put HASH_SALT
npx wrangler secret put AI_API_KEY
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put ADMIN_TOKEN
```

`DATA_ENCRYPTION_KEY` 必须是 Base64 编码的恰好 32 字节密钥；`HASH_SALT` 和 `ADMIN_TOKEN` 至少 32 个字符，建议用上述随机值。长期保存加密密钥和盐：随意更换加密密钥会导致历史邀请码无法解密，更换盐会破坏回执查询和既有领取限制。`ADMIN_TOKEN` 仅用于本分发服务的内部管理接口，和 NodeWarden API Key 分开生成。

### 4. 验证并部署

```powershell
npm test
npm run typecheck
npx wrangler deploy --dry-run
npm run deploy
```

试打包不会部署，也不会验证真实密钥。正式部署后，在测试实例完成一轮申请、回执查询、一次性注册和原生过期验证，再开放领取。注册链接由配置的 `NODEWARDEN_URL` 构造，忽略上游返回链接中的其他主机。

配置保留 `"triggers": { "crons": [] }`，用于显式移除已有的 Cron。省略该字段可能保留旧触发器；重新部署后可在 Cloudflare 控制台确认。

### 本地开发

```powershell
Copy-Item -LiteralPath .dev.vars.example -Destination .dev.vars
# 编辑 .dev.vars，填入测试实例的真实配置。
npx wrangler d1 execute nodewarden-invite --local --file=schema.sql
npm run dev
```

`.dev.vars` 只在本地使用，不会代替生产 Secret。需要本地跳过 Turnstile 时，将其中的 `TURNSTILE_SECRET=""`、`TURNSTILE_SITE_KEY=""` 设为空字符串，保留 `ALLOW_INSECURE_LOCAL_DEV="true"`，并使用 `http://localhost:8787`。空值会覆盖 `wrangler.jsonc` 的 Site Key，避免本地页面仍加载验证组件。该开关只对 localhost / 回环地址生效；生产请求缺少 Turnstile 配置时会拒绝申请。

本地 D1 与远程 D1 分离，但本地运行仍会请求所配置的真实 NodeWarden 和 AI 服务，并可能创建邀请码，请使用测试实例。

## 领取与配额规则

- 默认每个北京时间自然日最多预留 / 发放 3 张码。审核中的预留也计入余量，拒绝和明确技术失败会归还配额。
- 每天首次成功预留会固定当天上限；修改 `DAILY_INVITE_LIMIT` 后，新配置从下一天开始生效。
- 同一 IP 或设备每天最多一次审核机会；审核拒绝后次日可再申请。成功领取后保留永久限制，即使码已过期或被撤销。
- AI、鉴权等明确技术失败不占当天机会，可用新申请重试。超时等未知创建结果继续占用资格与配额，等待人工处理。
- 同申请 ID 和秘密回执的重复提交只返回原状态，不再创建邀请码。连接中断时先查询原回执；若查询为 404，页面允许用**同一 ID 和回执**重新提交。
- 提交接口还有每 IP 每分钟 5 次、全站每分钟 20 次的固定窗口限制。文本与已通过且仍处于发码 / 成功状态的申请进行三元组查重，相似度大于 30% 时拒绝。

## 页面和接口

- `GET /`：申请页面。
- `GET /api/daily-status`：返回北京时间当天的配额余量。
- `POST /api/applications`：提交申请。请求包含 `applicationId`、`receipt`、`application`、`fingerprint` 和 Turnstile token。
- `POST /api/applications/:id/status`：用回执查询状态或找回注册链接。
- `GET /internal/applications`：管理员查看处理列表。
- `GET /internal/applications/:id`：管理员查看单条记录并查询上游邀请码。
- `POST /internal/applications/:id/recover`：管理员人工确认后关联超时期间创建的邀请码。
- `POST /internal/applications/:id/release`：管理员核对 NodeWarden 后释放未创建成功的资格和配额。
- `POST /internal/applications/:id/revoke`：撤销仍未使用的邀请码。
- `POST /internal/applications/:id/ban`：邀请码已被使用时，封禁其 `usedBy` 用户。

内部接口使用 `Authorization: Bearer <ADMIN_TOKEN>`，认证失败统一返回 404。详情中不返回回执哈希和邀请码密文，已关联邀请码的明文与使用情况仅返回给认证通过的管理员。当前提供管理员 API，没有单独的管理员网页。

### 管理员处置示例（PowerShell）

提前在当前终端环境配置 `NW_INVITE_ADMIN_TOKEN`，值与部署时的 `ADMIN_TOKEN` 一致。以下域名和 ID 需替换为你的实际值：

```powershell
$inviteServiceUrl = 'https://invite.example.com'
$inviteAdminHeaders = @{ Authorization = 'Bearer ' + $env:NW_INVITE_ADMIN_TOKEN }
$applicationId = 'REPLACE_WITH_APPLICATION_ID'

# 每页最多 50 条，后续页使用返回的 nextOffset。
Invoke-RestMethod -Uri "$inviteServiceUrl/internal/applications?offset=0" -Headers $inviteAdminHeaders
Invoke-RestMethod -Uri "$inviteServiceUrl/internal/applications/$applicationId" -Headers $inviteAdminHeaders
```

发现 `uncertain` 或长时间未完成的 `creating` 时，在 NodeWarden 管理页结合发码时间、邀请码和审计记录核对。上游没有申请关联字段，不能仅凭“时间最近”猜测归属。确认某个码属于本申请后恢复关联：

```powershell
$recoverBody = @{ code = 'REPLACE_WITH_40_HEX_INVITE_CODE'; confirm = 'INVITE_BELONGS_TO_THIS_APPLICATION' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$inviteServiceUrl/internal/applications/$applicationId/recover" -Headers $inviteAdminHeaders -ContentType 'application/json' -Body $recoverBody
```

恢复只允许 `creating` / `uncertain`，校验邀请码创建时间位于本申请发码开始前 1 分钟至后 10 分钟，且同一个码不能关联给多条申请。恢复已使用或已过期的码同样保留成功领取限制。

确定不存在可用或已被使用的邀请码时，可释放资格和配额。`reviewing` 必须已超过 2 分钟；`creating` / `uncertain` 必须已超过记录中的 `resolve_after`（发码开始 + 配置有效期 + 10 分钟），并完成人工核对。若发现已使用的码，应恢复关联；发现其他可用码应先在 NodeWarden 撤销，再考虑释放：

```powershell
$releaseBody = @{ confirm = 'NO_USABLE_INVITE_REMAINS' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$inviteServiceUrl/internal/applications/$applicationId/release" -Headers $inviteAdminHeaders -ContentType 'application/json' -Body $releaseBody
```

已成功关联的未使用码可以撤销；发现已经注册的滥用用户时可以封禁。以下两个操作按实际情况单独执行：

```powershell
# 撤销邀请码，保留领取限制。
Invoke-RestMethod -Method Post -Uri "$inviteServiceUrl/internal/applications/$applicationId/revoke" -Headers $inviteAdminHeaders -ContentType 'application/json' -Body '{}'

# 封禁该邀请码 usedBy 所关联的用户，需明确确认。
$banBody = @{ confirm = 'BAN_REGISTERED_USER' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$inviteServiceUrl/internal/applications/$applicationId/ban" -Headers $inviteAdminHeaders -ContentType 'application/json' -Body $banBody
```

删除邀请码不会封禁已注册的用户。如果撤销与注册同时发生，应核对 NodeWarden 的用户与审计记录，不能只根据撤销成功判断注册已被阻止。管理员操作会写入 `nw_admin_audit`，结果不明时先查详情与上游状态再决定后续动作。

## 风控边界

IP 和设备指纹是辅助信号，不是稳定身份凭证；共用网络可能误伤，设备指纹也可以被改变。邀请码没有原生邮箱绑定，领取者仍可能转送链接。AI 审核不证明真实身份，也不能保证识别滥用。本版未接 GitHub / Linux.DO OAuth，未持续扫描注册后的用户行为。需要强制绑定外部身份时，应在 NodeWarden 注册流程或前置 OAuth 中增加绑定，并把稳定的外部用户 ID 写入独立字段。

D1 中的时间窗口按当前分钟判断，不需要 Cron 清零。提交时会分批清理超过 1 小时的限流记录；申请、领取与审计历史仍保留在 D1。不要随意删除领取资格表，否则会重新开放领取。没有后台自动核对或告警任务，管理员需要主动查看申请列表处理未知结果。

NodeWarden 的管理员访问令牌在内存中短暂缓存，接近过期时通过 API Key 重新获取。邀请码加密存储，IP / 设备标识加盐哈希存储，但申请文字以明文保留，并发送给配置的 AI 服务；页面已经提示用户勿提供密码或保险库内容。秘密回执保存在浏览器 localStorage，持有它即可查询本申请的邀请码，应当按敏感信息保管。

## 验证范围

`npm test` 使用真正的 Miniflare Workers 运行时和本地 D1，覆盖并发配额与事务回滚、跨日资格、回执与防重复发码、失败释放与未知结果恢复、Turnstile、限流、管理员撤码 / 封禁、加密与页面脚本。外部 NodeWarden、AI 和 Turnstile 请求使用模拟响应。

本地测试、类型检查与 Wrangler 试打包已通过。尚未对真实实例完成端到端申请、兑换或到期测试，也未部署到 Cloudflare；这些仍需在配置真实凭据后验证。

## 开源说明

本项目保留原仓库 Apache-2.0 许可证和来源说明。改造代码在 `src/index.ts` 标注了修改来源和日期。
