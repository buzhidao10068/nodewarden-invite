# NodeWarden 邀请码自动分发

这个 Cloudflare Worker 从 [`hekuo5310/nl-invite-auto`](https://github.com/hekuo5310/nl-invite-auto) 改造而来（原项目 Apache-2.0），使用 NodeWarden 管理员 API 按需创建邀请码。申请说明为 **1–5000 个字符**，去掉首尾空白后计数，纯空白不通过；前后端均按 Unicode 码点计数。

已移除 AI 服务调用、模型配置和相关校验。保留 Turnstile、人机验证后的文本查重、D1 申请记录、每日配额、IP / 设备限制、秘密回执和管理员恢复功能。文本不会发送给第三方内容审核服务。

申请通过检查后才创建一枚单次邀请码，默认有效 1 小时。有效期由 NodeWarden 校验，不需要定时保活、预生成库存或定时删除，因此配置显式使用 `"triggers": { "crons": [] }`。

## 使用 Cloudflare 控制台从 GitHub 部署

以下流程可以在浏览器完成，不需要在本机安装 Node.js 或 Wrangler。界面中英文名称可能略有差异，请按对应的设置项操作。

### 1. 准备 NodeWarden 和仓库

- 已部署自己的 NodeWarden，确认管理员能够登录，并能在管理页面手动创建邀请码。
- 使用自己的 fork，例如 [`buzhidao10068/nodewarden-invite`](https://github.com/buzhidao10068/nodewarden-invite)，确认 `main` 分支根目录有正式的 `wrangler.jsonc`、`package.json`、`schema.sql` 和 `src/`。
- 登录 Cloudflare，并让 Cloudflare GitHub App 有权读取这个仓库。私有仓库也需要明确授权。

这里有两个独立服务：`NODEWARDEN_URL` 指向已有的密码管理站点；新建的 `nodewarden-invite` Worker 是邀请码申请页。两者使用不同的数据库。

### 2. 从 GitHub 创建 Worker

1. 打开 Cloudflare 控制台 → **Workers & Pages** → **创建应用 / Create application** → **导入 Git 仓库 / Import a repository**。如果界面先让你选择产品，选择 **Workers**。
2. 连接 GitHub，选择你的 `nodewarden-invite` 仓库。看不到仓库时，进入 GitHub App 权限设置，把该仓库加入授权范围，再回来刷新。
3. 使用以下构建设置：

| 设置项 | 填写内容 |
| --- | --- |
| Worker 名称 | `nodewarden-invite`，与仓库 `wrangler.jsonc` 中的 `name` 一致 |
| 生产分支 / Production branch | `main` |
| 根目录 / Root directory | 仓库根目录；留空表示根目录的界面可留空，不要填 `src` |
| 构建命令 / Build command | 留空 |
| 部署命令 / Deploy command | `npm run deploy`，默认的 `npx wrangler deploy` 也可以 |

4. 点击部署，Cloudflare 会安装 `package-lock.json` 中的依赖并运行部署命令。
5. 部署完成后记下申请页域名，例如 `nodewarden-invite.<你的子域>.workers.dev`，后续 Turnstile 要用。此时还需要下面的建表和配置步骤，才能正常发码。

页面由 `src/index.ts` 返回，无需静态资源目录，不需要填写 `dist`、`public` 或 Pages 输出目录，也不要使用 `wrangler pages deploy`。

**已经创建过这个 Worker：** 在 **Worker → Settings → Builds** 中连接仓库，或修改现有仓库连接的根目录、分支和命令，然后重试部署。无需删除现有 Worker 和数据库。

正式 `wrangler.jsonc` 使用 `keep_vars: true`，且没有站点变量的占位值，后续 Git 部署会保留控制台设置的运行时变量。不要把 `wrangler.jsonc.example` 直接覆盖正式文件后带着占位值部署；配置文件中的同名 `vars` 会覆盖控制台值。如果你改 Worker 名称，也要把仓库中的 `name` 同步修改。

### 3. 检查独立 D1 绑定并建表

当前配置只有 `database_name`，没有固定 `database_id`。当前 Wrangler 支持部署时自动创建 D1；如果账户内已有同名库，则按名称连接。自动创建 / 查找的资源 ID 不会自动提交回 GitHub。

1. 打开 **Worker → Bindings / 绑定**，确认存在名称为 **`DB`** 的 D1 绑定。
2. 点击该数据库，或从 **Storage & Databases → D1 → nodewarden-invite** 进入。确认它是本分发服务专用的数据库，不能使用 NodeWarden 本身的业务库。
3. 打开数据库的 **Console / 控制台**，从 GitHub 仓库打开 [`schema.sql`](schema.sql) → **Raw**，复制 SQL 执行。它包含多张表、索引和配额触发器，应执行完整文件。如果界面要求逐条执行，保持每个 SQL 语句完整，尤其 `CREATE TRIGGER … BEGIN … END;` 必须整体执行。
4. 执行以下查询，确认表和 `nw_enforce_quota` 触发器已存在：

```sql
SELECT name, type FROM sqlite_master
WHERE name LIKE 'nw_%'
ORDER BY type, name;
```

自动创建数据库**不会自动执行建表文件**。仅有 `DB` 绑定、没有表时，申请和每日余量接口会报错。

如果没有自动创建 / 绑定成功，可以先在 D1 控制台创建专用数据库，把它的 Database ID 写入仓库 `wrangler.jsonc` 的 `d1_databases[0].database_id`，保留 `binding: "DB"`，提交后重新部署并建表。不要只在控制台绑定一个与配置里名称不同的库，否则后续 Git 部署可能连接其他库。

`schema.sql` 可以重复执行；升级本项目已有的 D1 时保留现有数据库，详见[升级说明](#升级已有部署)。它不负责迁移原 NodeLoc 服务的库存和删除队列。

### 4. 获取 NodeWarden 管理员 ID

这里需要 **NodeWarden 用户的 UUID**。它不是邮箱，也不是 Cloudflare Account ID、Worker ID、D1 Database ID 或邀请码。

1. 用要提供管理权限的账户登录**你自己的 NodeWarden 网页**。确认该账户角色为 `admin`，状态为 `active`；普通用户的个人 API Key 无法调用管理员接口。
2. 按 **F12** 打开浏览器开发者工具，进入 **Network / 网络**，选择 **Fetch/XHR**。
3. 保持开发者工具打开，刷新 NodeWarden 页面。如果页面锁定，先解锁。
4. 在网络列表搜索 `profile`，点击 **GET `/api/accounts/profile`**。从 **Response / 响应** 或 **Preview / 预览** 查看 JSON **顶层 `id`**。
5. 复制完整 UUID，在前面加上 `user.`，得到 `NODEWARDEN_CLIENT_ID`。格式为 `user.<刚复制的完整 UUID>`，不带尖括号、引号、换行或多余空格。

找不到请求时，清除网络过滤条件，再刷新一次。应查看 `/api/accounts/profile`，不要从保险库条目、组织或其他请求里复制 `id`。

### 5. 获取 API Key 和主密码认证派生值

这一步一次取得两个不同配置。保持上一步的 Network 面板打开：

1. 在自己的 NodeWarden 网页进入 **设置 / Settings**，找到包含 **API Key** 的密钥页面，选择 **查看 API Key / View API Key**。
2. 按网页提示输入管理员主密码并确认。这会发送 **POST `/api/accounts/api-key`**。
3. 在网络列表点击该请求，从 **Response / 响应** 中读取 **`apiKey`**，或复制网页显示的 API Key。将它作为 **`NODEWARDEN_CLIENT_SECRET`**。
4. 在**同一个请求**的 **Payload / 载荷 → Request Payload / 请求载荷** 中读取 **`masterPasswordHash`**，将它作为 **`NODEWARDEN_MASTER_PASSWORD_HASH`**。
5. 复制 JSON 解析后显示的完整字符串值，不带 JSON 引号；保留原有大小写、`+`、`/`、`=` 等字符，不要自行做 URL 编码或再次哈希。

`masterPasswordHash` 是网页根据主密码和账户 KDF 参数计算的认证派生值。不要填主密码明文，也不要从数据库复制已存储的密码摘要。作为备选，也可以在管理页面正常手动创建一枚邀请码，从 **POST `/api/admin/invites`** 的请求载荷取同名字段；该操作会实际创建邀请码。

优先选择“查看”，不要为了获取已有 Key 随意“轮换”。某些旧账户的 Key 无法回显，查看接口可能返回 409 并提示需要轮换一次；确需轮换时，使用网页的轮换功能，然后更新所有依赖旧 Key 的客户端。

这些凭据具有管理员权限，只配置到 Cloudflare **Secret** 中，不要提交到 Git、粘贴到聊天或公开截图 / HAR / 日志。不需要关闭两步验证，也不需要抓取 Cookie 或做会话保活。修改管理员主密码或 KDF 参数后需重新获取派生值；轮换 API Key 后需更新 `NODEWARDEN_CLIENT_SECRET`。

接入依据为 NodeWarden 提交 [`fbc0e65`](https://github.com/shuaiplus/nodewarden/tree/fbc0e65df8f405c3120887569e939d615ab68229) 的[网页设置源码](https://github.com/shuaiplus/nodewarden/blob/fbc0e65df8f405c3120887569e939d615ab68229/webapp/src/components/SettingsPage.tsx) 与 [管理员 API 文档](https://nodewarden.app/zh/guide/core/api-reference#管理员接口)。实际部署版本的界面或接口若不同，应先核对版本。

### 6. 创建 Turnstile 验证组件

1. 回到 Cloudflare 控制台 → **Turnstile → Add widget / 添加小组件**。
2. 名称可填 `nodewarden-invite`，模式选择 **Managed / 托管**。
3. 添加第 2 步得到的申请页 hostname，例如 `nodewarden-invite.<你的子域>.workers.dev`。只填主机名，不带 `https://` 或路径。
4. 如果还使用 `invite.example.com` 等自定义域名，也将该 hostname 加入允许列表。这里填的是**申请页域名**。
5. 保存后，复制 **Site Key** 和 **Secret Key**。前者填 `TURNSTILE_SITE_KEY`，后者填 `TURNSTILE_SECRET`。

服务端会同时核验 Turnstile 返回的 hostname 和 `action: "apply"`。使用未授权域名或生产环境缺少密钥时，申请不会通过。

### 7. 生成三个独立随机值

需要独立生成 `DATA_ENCRYPTION_KEY`、`HASH_SALT` 和 `ADMIN_TOKEN`。可以在可信的 HTTPS 页面（例如自己的 NodeWarden 网页）开发者工具 **Console / 控制台** 中运行下面这段本地 Web Crypto 代码；它只生成随机值，不发网络请求：

```javascript
const inviteRandom32 = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
console.log({
  DATA_ENCRYPTION_KEY: inviteRandom32(),
  HASH_SALT: inviteRandom32(),
  ADMIN_TOKEN: inviteRandom32()
});
```

将结果妥善保存在自己的密码管理器中。`DATA_ENCRYPTION_KEY` 必须是 Base64 编码的恰好 32 字节；`HASH_SALT` 和 `ADMIN_TOKEN` 至少 32 字符，上述生成结果满足要求。

已有部署应继续使用原来的加密密钥和盐。随意更换密钥会使历史邀请码无法解密；更换盐会破坏回执校验和既有领取限制。`ADMIN_TOKEN` 是本分发服务内部管理接口的凭据，与 NodeWarden API Key 分开生成。

### 8. 添加 Worker 运行时变量与 Secret

打开 **Workers & Pages → nodewarden-invite → Settings → Variables & Secrets → Add**，按下表逐项选择 **Text** 或 **Secret** 类型。添加完后点击 **Deploy / 保存并部署**，使运行时配置生效。

**不要只填在 Settings → Builds 的 Build variables and secrets 中。** 那里仅供构建过程使用，不能代替 Worker 处理请求时读取的变量。

| 名称 | 类型 | 值从哪里获取 |
| --- | --- | --- |
| `NODEWARDEN_URL` | Text | 已有 NodeWarden 的 HTTPS origin，例如 `https://vault.example.com`，不带路径、查询或账号密码 |
| `NODEWARDEN_CLIENT_ID` | Text | 第 4 步的 `user.<管理员 UUID>` |
| `TURNSTILE_SITE_KEY` | Text | 第 6 步的 Site Key |
| `DAILY_INVITE_LIMIT` | Text，可省略 | 默认 `3`，每个北京时间自然日的发放上限，范围 `1–10000` |
| `INVITE_EXPIRES_IN_HOURS` | Text，可省略 | 默认 `1`，邀请码有效小时数，范围 `1–720` |
| `NODEWARDEN_CLIENT_SECRET` | Secret | 第 5 步的管理员个人 API Key |
| `NODEWARDEN_MASTER_PASSWORD_HASH` | Secret | 第 5 步请求载荷中的 `masterPasswordHash` |
| `TURNSTILE_SECRET` | Secret | 第 6 步的 Secret Key |
| `DATA_ENCRYPTION_KEY` | Secret | 第 7 步生成的加密密钥 |
| `HASH_SALT` | Secret | 第 7 步生成的独立随机盐 |
| `ADMIN_TOKEN` | Secret | 第 7 步生成的独立管理令牌 |

全部配置共 **5 个 Text（其中 2 个可用默认值）和 6 个 Secret**。生产环境不设置 `ALLOW_INSECURE_LOCAL_DEV`。运行时 Secret 保存后无法回显原值，修改时重新填写完整值。

### 9. 验证部署

1. 打开申请页，确认“申请说明（1–5000 个字符）”、Turnstile 和每日剩余名额能够显示。
2. 打开 `https://<申请页域名>/api/daily-status`。全新数据库、未申请时默认应返回 `limit: 3`、`available: 3`、`timeZone: "Asia/Shanghai"`。
3. 在测试用途的 NodeWarden 实例提交申请。首尾空白不计数，1 个汉字可以通过长度检查；它仍需通过 Turnstile、查重和配额 / 领取限制。
4. 保存申请回执，确认返回注册链接。刷新页面后，用回执应能查回同一枚码，不能重复创建。
5. 在 NodeWarden 管理页面确认邀请码的有效期和状态，并完成一次性注册与到期验证，再开放领取。成功领取会保留该 IP 和设备的领取限制，测试也会消耗当天名额。
6. 在 Worker 的 **Settings → Triggers / Cron Triggers** 确认没有定时任务。配置中的 `crons: []` 用于显式移除已有 Cron。

GitHub 后续提交到 `main` 会触发新的构建。建表和密钥配置仍需首次手动完成，单纯看到绿色部署成功并不代表真实 NodeWarden 凭据已经验证。

### 常见部署和配置错误

| 现象 | 检查项 |
| --- | --- |
| `Could not detect a directory containing static files` | 使用包含正式 `wrangler.jsonc` 的最新提交；根目录指向仓库根；选择 Workers；部署命令为 `npm run deploy` 或 `npx wrangler deploy` |
| `no such table: nw_...`、每日余量一直读取失败 | 确认 `DB` 指向正确的远程 D1，并执行完整 `schema.sql` |
| 页面打开但提交返回“服务暂不可用” | 在 Worker 运行时 Settings 中核对必填 Text 和 Secret；检查 URL、密钥格式及 D1，修改后 Deploy；不要只配置 Build variables |
| 人机验证失败 | 申请页 hostname 已加入 Turnstile；Site Key 和 Secret Key 属于同一 widget；刷新验证后重试 |
| 申请状态 `failed`，提示发码服务暂不可用 | 核对 `user.UUID`、API Key、管理员身份、认证派生值以及 NodeWarden 访问策略；技术明确失败会释放本次机会 |
| 申请状态 `uncertain`，或发码结果待确认 | 保留回执，先查询和人工核对 NodeWarden；按下文管理接口恢复，避免重新创建 |
| 返回 429 | 查看提示区分每日配额、当天 / 永久领取限制与每分钟频率限制 |

NodeWarden 站点必须允许这个 Worker 访问 API；如果放在 Cloudflare Access 等额外登录层后面，需要先配置对应访问策略，本项目没有内置 Access Service Token 支持。

官方参考：[Workers Git 构建配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[Wrangler 配置与资源自动创建](https://developers.cloudflare.com/workers/wrangler/configuration/)、[运行时变量](https://developers.cloudflare.com/workers/configuration/environment-variables/)。

## 升级已有部署

1. 拉取或部署本仓库最新提交。现有 Worker 的仓库连接保持不变。
2. **保留原 D1、`DATA_ENCRYPTION_KEY` 和 `HASH_SALT`**，不要重建数据库或重新生成这些值。
3. 可在原 D1 上重新执行幂等的 `schema.sql`，增加新的查重索引；新版代码不读写旧审核列，原库中遗留的可空字段及旧索引可以保留，不需要删表或迁移历史数据。
4. 在 Worker 运行时配置中删除已不使用的 `AI_API_URL`、`AI_MODEL`、`AI_API_KEY`；如果 Builds 中也设置过，一并删除。不需要配置任何替代服务。
5. 确认管理员凭据、Turnstile、其余变量完整，再部署并验证。若旧申请仍停留在 `reviewing` / `creating` / `uncertain`，按管理员处置流程核对，已有永久领取限制继续保留。

## 本地命令部署与开发（可选）

仅使用控制台部署可跳过本节。本地命令需要 Node.js 22 或更新的受支持版本，均在仓库根目录执行。

```powershell
npm ci
npx wrangler login
# 若控制台或首次部署已经创建该库，跳过下一行。
npx wrangler d1 create nodewarden-invite
npx wrangler d1 execute DB --remote --file=schema.sql
```

正式配置按 `database_name` 连接数据库，也可以填上创建结果的 `database_id`，保持绑定名 `DB`。公开配置可在控制台设置，或填写正式 `wrangler.jsonc` 的 `vars`；后者会提交到 Git，只能放非敏感值。

Secret 可以继续用控制台设置，或逐项执行以下命令，在交互提示中粘贴对应值：

```powershell
npx wrangler secret put NODEWARDEN_CLIENT_SECRET
npx wrangler secret put NODEWARDEN_MASTER_PASSWORD_HASH
npx wrangler secret put DATA_ENCRYPTION_KEY
npx wrangler secret put HASH_SALT
npx wrangler secret put TURNSTILE_SECRET
npx wrangler secret put ADMIN_TOKEN
npm test
npm run typecheck
npx wrangler deploy --dry-run
npm run deploy
```

本地开发：

```powershell
Copy-Item -LiteralPath .dev.vars.example -Destination .dev.vars
# 编辑 .dev.vars，填写测试实例的真实配置。
npx wrangler d1 execute DB --local --file=schema.sql
npm run dev
```

`.dev.vars` 只用于本地且不要提交，不能代替生产 Secret。需要本地跳过 Turnstile 时，设置 `TURNSTILE_SECRET=""`、`TURNSTILE_SITE_KEY=""` 和 `ALLOW_INSECURE_LOCAL_DEV="true"`，使用 `http://localhost:8787`。该开关仅对 localhost / 回环地址生效。

本地 D1 与远程 D1 分离，但开发运行仍会请求配置的真实 NodeWarden 并可能创建邀请码，请使用测试实例。试打包不会部署，也不会验证真实凭据。

## 处理流程和领取规则

1. 浏览器生成申请 ID、秘密回执和设备标识；服务端验证输入、请求来源、IP、频率和 Turnstile。
2. D1 批量事务预留每日申请次数、IP / 设备领取资格和当天配额。唯一约束或配额失败会整批回滚。
3. 对已处于 `creating`、`uncertain`、`succeeded` 的申请做文本查重。按 NFKC 归一化、转小写、移除空白 / 标点 / 符号后的三元组交集比例判断，相似度大于 30% 时拒绝；不足 3 个字时比较归一化后的整体。因此 1 个字仍可能因重复被拒，允许短说明不代表跳过查重。
4. 检查通过后，通过 `client_credentials` 获取 NodeWarden 短期管理员令牌，条件更新为 `creating` 后调用创建接口，提交 `expiresInHours` 和 `masterPasswordHash`。
5. 邀请码用 AES-GCM 加密存储，页面凭秘密回执查询注册链接和有效期。注册链接由配置的 NodeWarden origin 和 code 构造。

- 默认每天按北京时间最多预留 / 发放 3 张码，处理中的预留也计入余量，查重拒绝和明确技术失败归还配额。
- 每天第一次成功预留会固定当天配额；修改 `DAILY_INVITE_LIMIT` 后，新配置从下一天生效。
- 同一 IP 或设备每天最多一次申请机会；查重拒绝后次日可再申请。成功领取后永久限制继续保留，即使码已过期或被撤销。
- 查重检查、鉴权等明确技术失败释放当天机会，可用新申请重试。超时、5xx 或无法解析的创建结果标记为 `uncertain`，保留资格和配额，等待人工处理。
- 同申请 ID 和秘密回执重复提交只返回原状态，不重复创建。连接中断先查原回执；查询为 404 时页面允许用同一 ID 和回执重新提交。
- 提交接口限流为每 IP 每分钟 5 次、全站每分钟 20 次，采用固定时间窗口。

NodeWarden 当前创建接口没有幂等键。对未知创建结果，本服务不会盲目重试，管理员应先在上游核对，再恢复关联或确认无可用码后释放资格。

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

IP 和设备指纹是辅助信号，不是稳定身份凭证；共用网络可能误伤，设备指纹也可以被改变。邀请码没有原生邮箱绑定，领取者仍可能转送链接。当前文本检查只判断重复，不判断使用动机或证明身份。本版未接 GitHub / Linux.DO OAuth，未持续扫描注册后的用户行为。需要强制绑定外部身份时，应在 NodeWarden 注册流程或前置 OAuth 中增加绑定，并把稳定的外部用户 ID 写入独立字段。

D1 中的时间窗口按当前分钟判断，不需要 Cron 清零。提交时会分批清理超过 1 小时的限流记录；申请、领取与审计历史仍保留在 D1。不要随意删除领取资格表，否则会重新开放领取。没有后台自动核对或告警任务，管理员需要主动查看申请列表处理未知结果。

NodeWarden 的管理员访问令牌在内存中短暂缓存，接近过期时通过 API Key 重新获取。邀请码加密存储，IP / 设备标识加盐哈希存储，但申请文字以明文保留在 D1；页面已经提示用户勿提供密码或保险库内容。秘密回执保存在浏览器 localStorage，持有它即可查询本申请的邀请码，应当按敏感信息保管。

## 验证范围

`npm test` 使用真正的 Miniflare Workers 运行时和本地 D1，覆盖 1–5000 字符及 Unicode 边界、旧数据库兼容、并发配额与事务回滚、跨日资格、回执与防重复发码、失败释放与未知结果恢复、Turnstile、限流、管理员撤码 / 封禁、加密与页面脚本。外部 NodeWarden 和 Turnstile 请求使用模拟响应；测试不配置任何内容审核服务。

本地测试、类型检查与 Wrangler 试打包已通过。尚未对真实实例完成端到端申请、兑换或到期测试，也未部署到 Cloudflare；这些仍需在配置真实凭据后验证。

## 开源说明

本项目保留原仓库 Apache-2.0 许可证和来源说明。改造代码在 `src/index.ts` 标注了修改来源和日期。
