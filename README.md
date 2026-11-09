# NodeWarden 邀请申请与人工邮件发放

基于 [`hekuo5310/nl-invite-auto`](https://github.com/hekuo5310/nl-invite-auto) 改造的 Cloudflare Worker（Apache-2.0）。用户填写邮箱和申请说明，管理员人工审核，在自己的 NodeWarden 管理页创建邀请码，再手动通过邮件发给申请人。

申请说明为 **1–5000 个 Unicode 码点**，去掉首尾空白，纯空白不通过。用户使用申请时填写的邮箱查询审核状态。已移除自动创建邀请码、每日发码总量限制、名额显示和秘密回执页面；不调用外部内容审核服务，不需要 Cron。

管理员可打开 **`https://你的申请服务域名/admin`** 审核申请，也可继续使用 PowerShell 管理 API。通过 `ADMIN_ACCESS_MODE` 选择仅网页、仅 API 或同时启用，默认两种方式都启用。

## 使用 Cloudflare 控制台从 GitHub 部署

以下流程可以完全在浏览器中操作。界面中英文名称可能略有差异，按对应设置项操作即可。

### 1. 准备仓库和 NodeWarden

- 使用自己的 fork，例如 [`buzhidao10068/nodewarden-invite`](https://github.com/buzhidao10068/nodewarden-invite)，确认分支根目录有正式的 `wrangler.jsonc`、`package.json`、`schema.sql` 和 `src/`。
- 登录 Cloudflare，让 Cloudflare GitHub App 有权读取该仓库。
- 确认自己的 NodeWarden 管理员能在网页中创建邀请码，并准备一个用于手动发送邀请邮件的邮箱。

本项目收集申请，提供状态查询、管理员网页和管理 API。管理员自行登录邮箱发信；项目没有 SMTP、邮件 API 或自动发信任务。

### 2. 从 GitHub 创建 Worker

1. Cloudflare 控制台 → **Workers & Pages → 创建应用 / Create application → 导入 Git 仓库 / Import a repository**，产品选择 **Workers**。
2. 连接 GitHub，选择你的 `nodewarden-invite` 仓库。看不到仓库时，去 GitHub App 权限设置中授权该仓库后刷新。
3. 设置以下内容：

| 设置项 | 填写内容 |
| --- | --- |
| Worker 名称 | `nodewarden-invite`，与正式 `wrangler.jsonc` 的 `name` 一致 |
| 生产分支 / Production branch | `main` |
| 根目录 / Root directory | 仓库根目录；支持留空的界面可留空，不要填 `src` |
| 构建命令 / Build command | 留空 |
| 部署命令 / Deploy command | `npm run deploy`，也可以用 `npx wrangler deploy` |

4. 点击部署，Cloudflare 会根据 `package-lock.json` 安装依赖并运行部署命令。
5. 记下申请页 hostname，例如 `nodewarden-invite.<你的子域>.workers.dev`，用于后续 Turnstile 配置。

页面由 Worker 直接返回，无需静态文件目录。出现 `Could not detect a directory containing static files` 时，核对最新分支包含正式 `wrangler.jsonc`、根目录是仓库根，并确认部署命令如上。

已有 Worker 可在 **Worker → Settings → Builds** 中连接或修改仓库配置，无需删除 Worker。正式配置使用 `keep_vars: true`，后续 Git 部署会保留控制台运行时变量。不要直接用带占位值的 `wrangler.jsonc.example` 覆盖正式配置；同名 `vars` 会覆盖控制台值。修改 Worker 名称时同步修改仓库配置。

### 3. 检查独立 D1 绑定并建表

正式配置声明 `binding: "DB"`、`database_name: "nodewarden-invite"`，没有固定数据库 ID。当前 Wrangler 支持按配置创建或连接 D1；创建数据库不会自动执行建表文件。

1. 打开 **Worker → Bindings / 绑定**，确认 D1 绑定名是 **`DB`**。
2. 点击该库，或从 **Storage & Databases → D1 → nodewarden-invite** 进入。必须是申请服务专用数据库，不能使用 NodeWarden 本身的业务库。
3. 打开 D1 **Console / 控制台**，从仓库打开 [`schema.sql`](schema.sql) → **Raw**，复制完整 SQL 执行。若界面要求逐条执行，保持每条 SQL 完整。
4. 执行下面查询，确认包括 `nw_application_emails` 在内的表已建立：

```sql
SELECT name, type FROM sqlite_master
WHERE name LIKE 'nw_%'
ORDER BY type, name;
```

若未自动绑定成功，先在 D1 创建专用数据库，将 Database ID 写入正式 `wrangler.jsonc` 的 `d1_databases[0].database_id`，保留 `binding: "DB"`，提交后重新部署。不要将控制台绑定与仓库中的数据库名称指向不同的库。

`schema.sql` 可以重复执行，保留历史申请。已有部署升级也必须执行最新版文件，它会创建邮箱表，并删除旧每日发码计数表和触发器，详见下方升级说明。

### 4. 配置 Turnstile

1. Cloudflare 控制台 → **Turnstile → Add widget / 添加小组件**。
2. 名称可填 `nodewarden-invite`，模式选 **Managed / 托管**。
3. 添加申请页 hostname，不带 `https://` 或路径；若有自定义域名，也加入允许列表。
4. 保存，复制 **Site Key** 和 **Secret Key**，分别用于 `TURNSTILE_SITE_KEY` 和 `TURNSTILE_SECRET`。

服务端核验 Turnstile 返回的 hostname 和 `action: "apply"`。生产环境未配置或域名不匹配时，无法提交申请。

### 5. 生成随机盐和管理令牌

在可信 HTTPS 页面的浏览器开发者工具 **Console / 控制台** 运行以下代码，只在本机生成随机值，不发网络请求：

```javascript
const inviteRandom32 = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
console.log({ HASH_SALT: inviteRandom32(), ADMIN_TOKEN: inviteRandom32() });
```

将两个独立结果保存在自己的密码管理器中，均至少 32 字符。`ADMIN_TOKEN` 是本申请服务的管理凭据，与 NodeWarden API Key 不同。已有部署继续使用原 `HASH_SALT`，更换会破坏已有邮箱检索及 IP / 设备限制。

### 6. 添加运行时变量与 Secret

打开 **Worker → Settings → Variables & Secrets → Add**，逐项添加并 **Deploy / 保存并部署**：

| 名称 | 类型 | 内容 |
| --- | --- | --- |
| `TURNSTILE_SITE_KEY` | Text | 第 4 步的 Site Key |
| `TURNSTILE_SECRET` | Secret | 第 4 步的 Secret Key |
| `HASH_SALT` | Secret | 第 5 步生成的随机盐 |
| `ADMIN_TOKEN` | Secret | 第 5 步生成的管理令牌 |
| `ADMIN_ACCESS_MODE` | Text，可选 | `web` 仅网页、`api` 仅 PowerShell/API、`both` 两者同时启用；不填默认 `both` |

人工邮件发放流程必填 **1 个 Text、3 个 Secret**，以及 D1 `DB` 绑定；管理方式变量可按需添加。生产环境不设置 `ALLOW_INSECURE_LOCAL_DEV`。不要只填 **Settings → Builds** 的构建变量，它们不能替代运行时变量。

例如希望网页和 PowerShell 都可用，在此页面新增 **Text** 变量，名称填 `ADMIN_ACCESS_MODE`、值填 `both`，保存并部署。只用网页填 `web`，只用 PowerShell 填 `api`；切换无需修改代码。正式配置的 `keep_vars: true` 会保留控制台设置，不要在仓库的 `vars` 中同时设置另一个值。拼写不正确会关闭管理入口并返回服务不可用，改为上述三个值之一即可。

需要在本项目中关联邀请码、撤销或封禁关联用户时，再填写下方“可选：接入 NodeWarden 管理 API”的配置。仅查看申请、手动发邮件和标记已发送，不需要填写 NodeWarden API 凭据。

### 7. 验证部署

1. 打开申请页，确认邮箱、申请说明、Turnstile 和“查询申请状态”可见。
2. 填写可收信邮箱和至少 1 个字，提交后应显示等待管理员人工审核。
3. 用同一邮箱查询，应显示待审核。查询只返回通用状态，不返回申请文字、管理员备注、邀请码或注册链接。
4. 默认模式下打开 `https://你的申请服务域名/admin`，输入 `ADMIN_TOKEN` 登录，确认能看到待审核申请的邮箱和说明；也可使用下方 PowerShell 示例。
5. 在 NodeWarden 管理页创建邀请码，通过邮箱手动发送后，在审核网页或 PowerShell 中标记已发送。
6. 再次查询应提示留意管理员邮件。
7. Worker 的 **Settings → Triggers / Cron Triggers** 应为空。`crons: []` 用于显式移除旧定时任务。

推送至 `main` 会触发 Cloudflare Git 构建。首次建表、运行时 Secret 和真实邮箱收信仍需手动配置验证。

## 管理员人工审核和发邮件

网页和 PowerShell 操作同一套 D1 申请与审计记录。用网页处理后，PowerShell 查询可看到结果，反之亦然；已打开的网页需刷新列表或详情以获取其他终端的修改。应通过这两种管理入口处理申请，以同步风控记录和审计日志。

### 选择管理方式

在 Cloudflare **Worker → Settings → Variables & Secrets** 配置 Text 变量 `ADMIN_ACCESS_MODE`：

| 值 | 管理员网页 `/admin` | PowerShell/API `/internal/...` |
| --- | --- | --- |
| `web` | 启用 | 关闭，返回 404 |
| `api` | 关闭，返回 404 | 启用 |
| `both`（默认） | 启用 | 启用 |

这项配置控制服务开放哪些入口。`both` 模式下管理员可任选网页或 PowerShell，也可以交替使用。公开申请页和邮箱查询均正常开放。

### 使用管理员网页

1. 打开 **`https://你的申请服务域名/admin`**，例如 `https://nodewarden-invite.你的子域.workers.dev/admin`。该页面随 Worker 部署，无需额外部署网站。
2. 输入本申请服务的 **`ADMIN_TOKEN`** 登录。它是在上方第 5 步生成、保存在 Worker Secret 中的管理令牌，无需提供 NodeWarden 管理员 ID 或主密码。
3. 默认显示待审核申请。可按状态筛选、翻页、刷新列表，点击“查看”读取邮箱、申请说明和管理员备注。
4. 审核通过后，在 **NodeWarden 自己的管理页** 创建邀请码，用自己的邮箱发给申请人。发信后回到本项目，选择该申请，点击 **“标记邮件已发送”** 并确认。
5. 不通过的申请点击 **“拒绝申请”**，可填写仅管理员可见的备注。需要撤回且允许重新申请时，确认未发信、无可用或已使用邀请码，在创建满 2 分钟后点击 **“释放申请资格”**。
6. 操作结束点击“退出登录”。如他人在 PowerShell 或另一个窗口完成审核，先刷新详情；重复处理会返回状态冲突。

网页可选填写关联邀请码；使用前需配置下方 NodeWarden API 凭据。邀请码关联、状态检查不会自动发信。旧记录恢复、撤码和封禁也可使用下方 PowerShell 示例，需启用 `api` 或 `both`；仅用网页时可在 NodeWarden 自己的管理页处理这些上游操作。

生产环境登录要求 HTTPS。登录后签发有效期 8 小时的签名会话，Cookie 带 `HttpOnly`、`Secure`、`SameSite=Strict`；令牌不会写入页面源码或浏览器本地存储，刷新可继续使用会话。会话到期重新登录，更换 `ADMIN_TOKEN` 会使旧会话失效。登录每 IP 每分钟最多 5 次、全站每分钟最多 30 次；遇到 429 稍后重试。管理网页不会在公开申请页提供入口。

### 使用 PowerShell 管理 API

在终端环境配置 `NW_INVITE_ADMIN_TOKEN`，值与运行时 `ADMIN_TOKEN` 相同，然后运行：

```powershell
$inviteServiceUrl = 'https://invite.example.com'
$inviteAdminHeaders = @{ Authorization = 'Bearer ' + $env:NW_INVITE_ADMIN_TOKEN }

# 每页最多 50 条；返回邮箱、申请 ID 和状态。
Invoke-RestMethod -Uri "$inviteServiceUrl/internal/applications?offset=0" -Headers $inviteAdminHeaders

# 只看待审核申请；下一页将 offset 改为 50、100 等。
Invoke-RestMethod -Uri "$inviteServiceUrl/internal/applications?status=reviewing&offset=0" -Headers $inviteAdminHeaders

$applicationId = 'REPLACE_WITH_APPLICATION_ID'
# 查看申请说明和邮箱。
Invoke-RestMethod -Uri "$inviteServiceUrl/internal/applications/$applicationId" -Headers $inviteAdminHeaders
```

通过审核后，在 NodeWarden 网页管理页手动创建邀请码，将注册链接发送到申请记录中的邮箱。确认邮件已发送后：

```powershell
$sentBody = @{ confirm = 'INVITATION_EMAIL_SENT' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$inviteServiceUrl/internal/applications/$applicationId/sent" -Headers $inviteAdminHeaders -ContentType 'application/json' -Body $sentBody
```

这个操作只记录已经发出邮件，不会创建邀请码或发送邮件。标记已发送后，保留该邮箱、IP 和设备的重复领取限制。

拒绝待审核申请：

```powershell
$rejectBody = @{ reason = '管理员内部备注，可留空' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$inviteServiceUrl/internal/applications/$applicationId/reject" -Headers $inviteAdminHeaders -ContentType 'application/json' -Body $rejectBody
```

拒绝后解除邮箱、IP 和设备的处理中限制，保留该 IP / 设备当天申请次数。用户查询只显示“申请未通过审核”，不展示内部备注。

若待审核申请需要撤回并允许重试，创建满 2 分钟且人工确认未发送邀请、无可用或已使用的邀请码后，可释放申请资格：

```powershell
$releaseBody = @{ confirm = 'NO_USABLE_INVITE_REMAINS' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$inviteServiceUrl/internal/applications/$applicationId/release" -Headers $inviteAdminHeaders -ContentType 'application/json' -Body $releaseBody
```

## 可选：接入 NodeWarden 管理 API

用于将手动发送的邀请码关联到申请、查询上游状态、撤销未使用的码、封禁 `usedBy` 用户，以及处理旧版发码结果。基础人工邮件申请流程可跳过此节。

### 获取管理员 ID

这里需要 **NodeWarden 用户 UUID**。它不同于邮箱、Cloudflare Account ID、Worker ID 和 D1 Database ID。

1. 登录自己的 NodeWarden 网页，确认账户角色为 `admin`，状态为 `active`。
2. 按 **F12 → Network / 网络 → Fetch/XHR**，保持面板打开并刷新 NodeWarden 页面，锁定时先解锁。
3. 搜索 `profile`，打开 **GET `/api/accounts/profile`**。
4. 从 **Response / 响应** 或 **Preview / 预览** 复制 JSON 顶层 **`id`**。
5. 前面加上 `user.`，组成 `NODEWARDEN_CLIENT_ID`，格式为 `user.<完整 UUID>`，不带尖括号和多余空白。

找不到请求时清除过滤条件并刷新。不要从保险库条目、组织或其他接口复制 ID。

### 获取 API Key 和认证派生值

1. 保持 Network 面板打开，在 NodeWarden **设置 / Settings** 中选择 **查看 API Key / View API Key**。
2. 输入管理员主密码确认，会发送 **POST `/api/accounts/api-key`**。
3. 从响应中的 **`apiKey`** 或网页复制 Key，作为 `NODEWARDEN_CLIENT_SECRET`。
4. 从同一请求的 **Payload / 载荷 → Request Payload** 复制 **`masterPasswordHash`**，作为 `NODEWARDEN_MASTER_PASSWORD_HASH`。
5. 复制解析后的完整值，不带 JSON 引号，保留大小写和 `+`、`/`、`=`，不要再次哈希或 URL 编码。

`masterPasswordHash` 是网页按账户 KDF 参数计算的认证派生值，不填主密码明文，也不从数据库复制密码摘要。也可在管理页手动创建邀请码，从 **POST `/api/admin/invites`** 请求载荷读取同名字段，该操作会实际创建邀请码。

优先查看已有 Key。旧账户无法回显并提示需要轮换时，按网页提示操作，再更新所有使用旧 Key 的客户端。修改管理员主密码或 KDF 参数后，需要重新获取派生值。

接入依据：[NodeWarden 管理员 API](https://nodewarden.app/zh/guide/core/api-reference#管理员接口)、提交 [`fbc0e65`](https://github.com/shuaiplus/nodewarden/tree/fbc0e65df8f405c3120887569e939d615ab68229) 的网页设置源码；实际接入前核对部署版本。

### 添加可选变量

| 名称 | 类型 | 内容 |
| --- | --- | --- |
| `NODEWARDEN_URL` | Text | NodeWarden HTTPS origin，例如 `https://vault.example.com`，不带路径或查询 |
| `NODEWARDEN_CLIENT_ID` | Text | `user.<管理员 UUID>` |
| `NODEWARDEN_CLIENT_SECRET` | Secret | 管理员个人 API Key |
| `NODEWARDEN_MASTER_PASSWORD_HASH` | Secret | 请求载荷中的认证派生值 |
| `DATA_ENCRYPTION_KEY` | Secret | Base64 编码的恰好 32 字节随机值 |

加密密钥可使用前面的 `inviteRandom32()` 独立生成。已有部署必须保留原加密密钥，以便解密历史邀请码。管理员凭据仅保存到 Secret，API 必须允许该 Worker 访问。

已发送邮件时，可在 `/sent` 请求额外提交 `code`，由服务验证并加密关联：

```powershell
$sentBody = @{ confirm = 'INVITATION_EMAIL_SENT'; code = 'REPLACE_WITH_40_HEX_INVITE_CODE' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$inviteServiceUrl/internal/applications/$applicationId/sent" -Headers $inviteAdminHeaders -ContentType 'application/json' -Body $sentBody

# 撤销关联的未使用邀请码，保留领取限制。
Invoke-RestMethod -Method Post -Uri "$inviteServiceUrl/internal/applications/$applicationId/revoke" -Headers $inviteAdminHeaders -ContentType 'application/json' -Body '{}'

# 封禁该邀请码 usedBy 关联的注册用户。
$banBody = @{ confirm = 'BAN_REGISTERED_USER' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$inviteServiceUrl/internal/applications/$applicationId/ban" -Headers $inviteAdminHeaders -ContentType 'application/json' -Body $banBody
```

同一邀请码不能关联多个申请。邮箱查询始终不返回关联的邀请码或注册链接。删除邀请码不会封禁已经注册的用户；撤销与注册同时发生时，应核对 NodeWarden 用户和审计记录。

## 升级已有部署

1. 保留原 D1、`HASH_SALT`；如已有加密邀请码，同时保留 `DATA_ENCRYPTION_KEY` 和 NodeWarden API 配置。
2. 在申请服务的远程 D1 控制台执行完整的新版 [`schema.sql`](schema.sql)。它创建独立邮箱表，删除旧发码总量计数表和触发器，不删除历史申请、领取限制或审计记录。可重复执行。
3. 部署最新 `main`。先更新数据库再切换新版 Worker；升级期间避免接收提交。
4. 删除运行时及构建设置中旧的每日发码上限、自动发码有效期和内容审核服务变量。新版不读取它们。
5. 确认基础的 4 个变量完整，按需设置 `ADMIN_ACCESS_MODE`，测试提交、邮箱查询、管理员登录、列表和标记已发送。已有人工审核部署升级本次网页功能不需要额外建表；仍使用原 D1 和 `ADMIN_TOKEN`。

旧记录没有邮箱，不能用邮箱查询。管理员仍可按申请 ID 查看和处理，历史已发送记录及 IP / 设备限制继续保留。

旧版 `creating` / `uncertain` 记录需先在 NodeWarden 人工核对，不能再次盲目创建。确认邀请码归属后：

```powershell
$recoverBody = @{ code = 'REPLACE_WITH_40_HEX_INVITE_CODE'; confirm = 'INVITE_BELONGS_TO_THIS_APPLICATION' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$inviteServiceUrl/internal/applications/$applicationId/recover" -Headers $inviteAdminHeaders -ContentType 'application/json' -Body $recoverBody
```

恢复仅针对旧创建状态，校验创建时间处于记录发码开始前 1 分钟至后 10 分钟。确认无可用或已使用的邀请码后，可在 `resolve_after` 之后通过 `/release` 释放资格。已使用的码应恢复关联，仍可用的码需先撤销再考虑释放。

## 风控和接口

- 同一邮箱同时只能有一条待审核或已发送的申请；拒绝、技术失败或管理员释放后可再次使用邮箱。
- 同一 IP / 设备每天最多一次申请机会；处理中跨日也不能重复提交，标记已发送后保留领取限制。这里是来源限制，没有全站每日发码总量限制。
- 对已有 `creating`、`uncertain`、`succeeded` 记录做文本查重。NFKC 归一化、转小写、移除空白 / 标点 / 符号后比较三元组交集，超过 30% 拒绝；不足 3 个字时比较整体。待审核申请最终由管理员判断。
- 提交每 IP 每分钟 5 次、全站每分钟 20 次；查询每 IP 每分钟 10 次、全站每分钟 60 次。固定分钟窗口，旧限流记录在请求时分批清理，无需 Cron。
- 邮箱会去掉首尾空白并转小写，不合并不同别名。仅填写邮箱不代表已验证邮箱所有权；公开查询可以获知该邮箱的通用申请状态，不能获取申请内容或邀请码。
- IP / 设备标识加盐哈希保存，邮箱和申请说明以明文保存到专用 D1，只有通过认证的管理网页或 API 能读取。管理员需定期查看待审核列表，没有后台通知任务。

| 接口 | 用途 |
| --- | --- |
| `GET /` | 邮箱申请页 |
| `POST /api/applications` | 提交 `applicationId`、`email`、`application`、`fingerprint`、`turnstileToken` |
| `POST /api/applications/status` | 提交 `{ "email": "申请邮箱" }` 查询最新状态 |
| `GET /admin` | 管理员登录和审核网页，`web` / `both` 模式开放 |
| `GET /admin/api/session` | 检查网页登录会话 |
| `POST /admin/api/session` | 提交 `{ "token": "ADMIN_TOKEN 的值" }` 登录，签发会话 Cookie |
| `DELETE /admin/api/session` | 退出网页登录，清除 Cookie |
| `/admin/api/applications...` | 网页会话认证，复用下方申请管理操作；`web` / `both` 模式开放 |
| `GET /internal/applications` | 管理员列表，包含邮箱，每页 50 条；可用 `status`、`offset` 筛选和分页 |
| `GET /internal/applications/:id` | 管理员查看说明、邮箱及已关联邀请码的上游状态 |
| `POST /internal/applications/:id/sent` | 确认邮件已发送，`code` 可选 |
| `POST /internal/applications/:id/reject` | 拒绝待审核申请，`reason` 为可选内部备注 |
| `POST /internal/applications/:id/release` | 确认无邀请后释放申请资格 |
| `POST /internal/applications/:id/recover` | 核对旧版未知发码结果 |
| `POST /internal/applications/:id/revoke` | 撤销关联的未使用邀请码 |
| `POST /internal/applications/:id/ban` | 封禁关联注册用户 |

`/internal/...` 接口仅在 `api` / `both` 模式开放，需 `Authorization: Bearer <ADMIN_TOKEN>`，认证失败统一 404。`/admin/api/...` 仅接受网页会话，未登录返回 401；写操作需要同源 `Origin`，不能用 Bearer 代替会话。旧余量接口和秘密回执查询接口已移除。IP / 指纹只能作为辅助信号，可能误伤共享网络，也可被改变；邀请码是否被转送、最终注册邮箱是否一致，取决于 NodeWarden 注册流程。

## 本地开发和验证

使用 Node.js 22 或更新的受支持版本，在仓库根目录运行：

```powershell
npm ci
Copy-Item -LiteralPath .dev.vars.example -Destination .dev.vars
# 编辑 .dev.vars，填入测试配置。
npx wrangler d1 execute DB --local --file=schema.sql
npm run dev
```

本地跳过 Turnstile 时将两项 `TURNSTILE_*` 均设为空，`ALLOW_INSECURE_LOCAL_DEV="true"`，使用 `http://localhost:8787`，只对回环地址有效。`.dev.vars` 不提交 Git，也不能代替生产运行时配置。

```powershell
npm test
npm run typecheck
npx wrangler deploy --dry-run
```

测试使用 Miniflare 真实 Workers 运行时和 D1，覆盖邮箱校验、手动发放状态、查询信息范围、超过三条申请、并发风控及事务回滚、旧库升级、Unicode 长度、查重、Turnstile、限流、历史恢复和管理员撤码 / 封禁；同时验证网页登录、会话签名与过期、同源保护、三种入口模式、网页/API 状态共享、分页筛选和页面安全渲染。外部请求使用模拟响应，试打包不会部署；真实 Cloudflare 运行配置、NodeWarden 操作和邮件收信仍需部署后验证。

## 常见问题

| 现象 | 检查项 |
| --- | --- |
| 静态文件目录检测失败 | 使用正式 `wrangler.jsonc`，选 Workers、仓库根目录，部署命令 `npm run deploy` |
| `no such table: nw_application_emails` | 在申请服务实际绑定的远程 D1 执行新版 `schema.sql` |
| 页面正常但提交服务不可用 | 核对运行时 4 个基础变量、D1 表和绑定，保存后 Deploy |
| Turnstile 失败 | 申请页 hostname 在允许列表中，Site Key / Secret Key 属于同一组件 |
| 查询找不到旧申请 | 旧申请没有邮箱，需管理员按 ID 处理 |
| `/admin` 返回 404 | 核对已部署新版，`ADMIN_ACCESS_MODE` 为 `web` 或 `both` |
| PowerShell 管理接口返回 404 | 核对 `ADMIN_ACCESS_MODE` 为 `api` 或 `both`，并携带正确 Bearer 令牌 |
| 管理员登录失败或过期 | 使用申请服务的 `ADMIN_TOKEN`，至少 32 字符；使用 HTTPS、允许 Cookie，过期后重新登录 |
| 返回 429 | 来源每日申请限制、处理中 / 已领取限制或每分钟限流 |
| 标记已发送后没收到邮件 | 该接口只记录状态；管理员需自行发送邮件，并核对地址和垃圾邮件 |
| 可选的上游操作失败 | 核对管理员 UUID、API Key、认证派生值、加密密钥和 NodeWarden 访问策略 |

参考：[Workers Git 构建配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[D1 Worker API](https://developers.cloudflare.com/d1/worker-api/)、[运行时变量](https://developers.cloudflare.com/workers/configuration/environment-variables/)。保留上游 Apache-2.0 许可证，改造来源与日期见 `src/index.ts`。
