# NodeWarden 邀请码自动分发与免 Cron 改造方案

整理日期：2026-11-09

改造基础：[hekuo5310/nl-invite-auto](https://github.com/hekuo5310/nl-invite-auto)

目标项目：[shuaiplus/nodewarden](https://github.com/shuaiplus/nodewarden)

> 本文保留原始改造思路与接入背景；本 fork 已于 2026-11-09 完成对应代码改造。部署、配置和管理员处置以 [README.md](README.md) 为准。已通过本地运行时测试、类型检查和试打包，尚未部署或对真实 NodeWarden 完成端到端验证。NodeWarden 接入依据为提交 `fbc0e65df8f405c3120887569e939d615ab68229`，实际接入应核对所部署版本。

当前配置和控制台从 GitHub 部署的完整操作见 [README 部署教程](README.md#使用-cloudflare-控制台从-github-部署)，包含管理员 UUID、个人 API Key、认证派生值、D1 建表、Turnstile 和运行时 Secret。现版申请说明最低 1 个字符，不再调用外部内容审核服务；保留文本查重。

## 1. 目标与结论

保留 `nl-invite-auto` 的申请页面、Turnstile、领取限制和文本查重的思路，将其邀请码来源从 NodeLoc 改为 NodeWarden。实施时已重写申请页面与服务端模块，新增秘密回执、加密存储、事务预留和管理员恢复接口。

当前采用“申请检查通过后即时创建邀请码”的方式，并使用 NodeWarden 自带的有效期控制，使核心分发流程无需 Cron。

**不能只停掉原项目的 Cron 就完成改造。** 原项目依赖定时任务补充邀请码库存和删除到期邀请码，需要先替换这些业务流程。

## 2. 原项目的 Cron 在做什么

源码入口：[src/index.ts 的 scheduled 处理函数](https://github.com/hekuo5310/nl-invite-auto/blob/main/src/index.ts#L450)。

| 任务 | 触发方式 | 具体作用 | 取消后的影响 |
| --- | --- | --- | --- |
| NodeLoc 会话维护 | `*/30 * * * *`，每 30 分钟 | 请求 NodeLoc，尝试更新 Cookie / CSRF 会话 | 不再自动尝试维持会话，凭据过期后需要更新 |
| 邀请码库存补充 | 上述任务在 UTC 00:00，即北京时间 08:00 执行补货 | 每天创建 3 张一次性邀请码，存入 D1 | 不再自动补货，已有库存领完后无法继续发放 |
| 领取后到期删除 | `*/5 * * * *`，每 5 分钟 | 扫描删除队列，删除已发放满 1 小时的邀请码，重试失败的删除任务 | 未使用的邀请码不会按领取时间自动删除 |

### README 与代码存在的差异

整理时 README 只要求配置：

```json
{
  "triggers": {
    "crons": ["*/30 * * * *"]
  }
}
```

但代码中的删除队列只在 `controller.cron === "*/5 * * * *"` 时执行。

因此，完全按照 README 只配置每 30 分钟任务，并不会执行“领取 1 小时后自动删除”。如继续使用原版 NodeLoc 方案，需要额外配置每 5 分钟任务。

此外，定时扫描并不代表恰好在满 1 小时的一刻删除；执行时间还取决于扫描间隔和任务是否成功。

### 不依赖 Cron 的功能

以下逻辑在用户提交申请时执行：

- Turnstile 服务端验证。
- IP 和浏览器指纹领取限制。
- 当日申请限制、成功领取后的永久限制。
- 申请文字查重。
- 从已有库存分配邀请码。

当日限制按日期判断，不需要 Cron 每天清零。历史记录的物理清理是另一个可选维护需求。

## 3. 改接 NodeWarden 后的推荐流程

```text
用户提交申请
    ↓
服务端验证 Turnstile、输入格式和申请频率
    ↓
在数据库中原子预留领取资格和当日配额
    ↓
检查文本重复率（申请说明 1–5000 字符）
    ↓
后端获取或刷新 NodeWarden 管理员访问令牌
    ↓
调用 NodeWarden 创建邀请码，设置 expiresInHours = 1
    ↓
保存邀请码、有效期与申请人的关联
    ↓
返回 NodeWarden 注册链接
    ↓
邀请码使用一次后失效，或到期后不能兑换
```

该流程不需要每天预生成库存，也不需要定时删除来保证邀请码到期失效。

## 4. 为什么三类 Cron 都可以取消

### 4.1 移除 NodeLoc 会话维护

改造后不再请求 NodeLoc，移除 Cookie / CSRF 保活代码及相关配置。

NodeWarden 使用管理员账户的访问令牌。实现中由专用管理员的 API Key 通过 `client_credentials` 按需获取短期 token，接近过期时重新获取；不保存浏览器会话，也不需要为了保活保留原来的 Cron。

管理员访问令牌不能当作永久有效的静态 API Key。

### 4.2 将定时补库存改为按需创建

只有申请检查通过、领取资格和配额预留成功后，才调用 NodeWarden 创建邀请码。

如需限制“每天最多发放 N 张”，使用分发服务自己的数据库记录和原子配额更新。原项目“每天生成 3 张库存”与“每天最多成功发放 3 张”不是同一个约束；旧库存可能跨日累积。

### 4.3 用原生有效期替代定时删除

创建邀请码时设置 `expiresInHours = 1`。有效期从 NodeWarden 创建成功时开始计算。

邀请码过期后不能兑换，不依赖分发服务再次执行删除。过期记录是否保留，不影响过期校验。

如果要求到期后同时清除历史数据，可以另设维护任务；这不是保证邀请码失效的必要条件。

## 5. NodeWarden API 接入要点

官方文档：[API Reference — 管理员接口](https://nodewarden.app/zh/guide/core/api-reference#%E7%AE%A1%E7%90%86%E5%91%98%E6%8E%A5%E5%8F%A3)。

当前源码：[src/handlers/admin.ts](https://github.com/shuaiplus/nodewarden/blob/main/src/handlers/admin.ts)。

| 操作 | 接口 | 说明 |
| --- | --- | --- |
| 创建邀请码 | `POST /api/admin/invites` | JSON 请求体包含 `expiresInHours` 和 `masterPasswordHash` |
| 查询邀请码 | `GET /api/admin/invites?includeInactive=true` | 可读取状态、有效期和使用者 `usedBy` |
| 撤销邀请码 | `DELETE /api/admin/invites/{code}` | 需要提交 `masterPasswordHash` |
| 查询用户 | `GET /api/admin/users` | 用于关联已注册用户 |
| 封禁用户 | `PUT /api/admin/users/{id}/status` | 提交 `status: "banned"` 和 `masterPasswordHash` |

关键约束：

- 管理接口需要有效的管理员 Bearer access token，账户应为启用状态。
- 创建、撤销邀请码和封禁用户等写操作还会验证 `masterPasswordHash`，只提供 Bearer token 不够。
- `masterPasswordHash` 需按 NodeWarden 的认证逻辑取得，不能直接用主密码明文替代。
- 邀请码为一次性使用。
- `expiresInHours` 默认 168 小时，范围为 1–720 小时；推荐按本方案设置为 1 小时。
- 创建成功后返回 `code`、`inviteLink`、`expiresAt` 等字段。实现中会校验字段、加密保存，并使用配置的 NodeWarden origin 与 code 构造注册链接，不直接信任返回链接的主机。
- 管理员令牌和 `masterPasswordHash` 只保存在服务端，不下发到领取页面，不写入公开日志。

## 6. 保留和调整哪些代码

| 原项目模块 | 改造建议 |
| --- | --- |
| 申请页面 | 保留，调整 NodeLoc 文案为你的服务说明 |
| Turnstile | 保留服务端验证，正式环境配置真实密钥 |
| IP / 指纹限流 | 保留作为辅助限制，按用户群体调整规则 |
| 文本查重 | 按实际准入需求保留 |
| 外部内容审核服务 | 已移除调用、配置及相关数据库读写；当前不需要模型或服务密钥 |
| NodeLoc Cookie / CSRF 维护 | 移除 |
| NodeLoc 创建、查询、删除邀请码 | 替换为 NodeWarden 管理 API；撤销标识改用邀请码 `code` |
| 每日预生成库存 | 改成检查通过后即时创建 |
| 领取后 1 小时删除队列 | 使用 NodeWarden 原生有效期后可移除 |
| scheduled 处理函数 | 业务替换完成且不再需要其他定时维护后移除 |
| D1 申请与领取记录 | 保留并调整字段，记录发码状态、邀请码和有效期 |

分发服务可继续使用自己的 D1/KV，通过 API 操作 NodeWarden，无需直接修改 NodeWarden 的数据库。

## 7. 取消 Cron 后仍需处理的风控与一致性

### 7.1 防止并发重复领取

同一身份的两个请求可能同时通过前置检查。应在调用上游创建邀请码前，使用数据库唯一约束和条件更新，原子预留领取资格及配额。

不能只依赖 KV 缓存、前端按钮禁用或先查询再写入。

### 7.2 处理创建失败和超时

- 确认未创建成功的失败：按策略释放领取资格和配额，允许重试。
- 请求超时且结果未知：保留处理中或待核对状态，核对上游记录后再决定是否重试，避免重复生成。
- 已创建成功但保存记录失败：需要记录和恢复路径，防止遗失邀请码或重复发码。

不要假定 NodeWarden 创建接口已经提供业务幂等能力。取消 Cron 后，可以通过重试请求或受保护的管理操作触发核对；需要无人值守恢复时，再单独引入后台处理机制。

### 7.3 身份、IP 和设备指纹

如果引入 GitHub / Linux.DO 登录，优先使用稳定的外部用户 ID 做领取约束，IP 和设备指纹作为辅助信号。

原项目的“同一 IP 成功后永久不能再领”容易误伤公司、校园网、家庭共用网络。浏览器指纹也可变化或被伪造，不能单独证明是同一个人。

### 7.4 保存关联，区分撤码与封号

建议保存：

```text
外部身份或申请记录 → 邀请码 code → NodeWarden usedBy
```

未注册时可以撤销邀请码；已经注册的用户需要单独封禁，删除邀请码不会撤销已创建的账户。

`usedBy` 的同步可在管理员查看记录时按需查询。若需要自动持续追踪注册与异常行为，再增加独立的巡检机制。

### 7.5 邀请码转送限制

当前邀请码没有原生绑定指定邮箱。领取者可以把码转给别人，单靠领取页验证邮箱不能保证最终注册者就是领取人。

如需强制绑定身份或邮箱，需要在 NodeWarden 注册校验中增加相应限制。

## 8. 如何真正关闭已部署的 Cron

在 `wrangler.jsonc` 中将任务数组显式设置为空，再重新部署：

```json
{
  "triggers": {
    "crons": []
  }
}
```

**不要仅删除或注释 `triggers` / `crons` 配置。** Cloudflare 对省略配置的处理是保留已部署的触发器；空数组才表示删除全部触发器。

官方说明：[Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。

推荐顺序：

1. 完成 NodeWarden 鉴权和按需创建邀请码。
2. 完成领取资格、并发预留、每日配额和失败恢复逻辑。
3. 验证一次性兑换与原生过期行为。
4. 停止旧的 NodeLoc 补货流程，妥善处理已有库存和未完成删除任务。
5. 设置 `crons: []` 并部署，确认触发器已移除。
6. 移除不再使用的 NodeLoc 凭据、会话维护代码和删除队列。

## 9. 预期结果

改造完成后，用户通过领取检查与文本查重，即可获得一张由 NodeWarden 创建、只能使用一次、有效期 1 小时的邀请码。

核心分发流程无需定时保活、预生成库存或到期删除任务。准入规则、配额和领取记录由分发服务管理，邀请码兑换和过期校验由 NodeWarden 处理。
